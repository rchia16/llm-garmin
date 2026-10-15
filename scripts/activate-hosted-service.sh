#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 || "$#" -ne 2 ]]; then
  echo 'Usage: sudo bash scripts/activate-hosted-service.sh /absolute/projects/llm-garmin FIRST_USERNAME' >&2
  exit 1
fi
stage_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_directory="$(realpath -- "$1")"
first_username="$2"
if [[ "$stage_directory" == "$runtime_directory" || "$(basename -- "$runtime_directory")" != llm-garmin || "$(basename -- "$(dirname -- "$runtime_directory")")" != projects ]]; then
  echo 'Run this initial activation from a separate staged release, targeting projects/llm-garmin.' >&2; exit 1
fi
if systemctl is-active --quiet workout-builder-hosted.service; then echo 'Hosted service is already active; this script is for initial activation only.' >&2; exit 1; fi
for tool in setfacl python3 node systemctl curl; do command -v "$tool" >/dev/null || { echo "Install required tool: $tool" >&2; exit 1; }; done
runtime_owner="$(stat -c '%U' -- "$runtime_directory")"
runtime_owner_uid="$(id -u "$runtime_owner")"
if [[ "$runtime_owner_uid" == 0 ]]; then echo 'Runtime must belong to the original non-root project owner.' >&2; exit 1; fi
owner_service() {
  sudo -u "$runtime_owner" env "XDG_RUNTIME_DIR=/run/user/$runtime_owner_uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$runtime_owner_uid/bus" systemctl --user "$@"
}
backup_directory="$(mktemp -d "$(dirname -- "$runtime_directory")/.llm-garmin-before-hosted-XXXXXXXX")"
python3 - "$runtime_directory" "$backup_directory" <<'PY'
from pathlib import Path
import shutil,sys
runtime,backup=map(Path,sys.argv[1:])
for name in ['dist','dist-ui','node_modules','python','deploy','scripts','package.json','package-lock.json','README.md']:
    source=runtime/name
    if source.is_dir(): shutil.copytree(source,backup/name,symlinks=True)
    elif source.exists(): shutil.copy2(source,backup/name)
PY
rollback() {
  trap - ERR
  echo 'Activation failed; restoring the previous runtime and user service.' >&2
  systemctl disable --now workout-builder-hosted.service >/dev/null 2>&1 || true
  python3 - "$runtime_directory" "$backup_directory" <<'PY'
from pathlib import Path
import shutil,sys
runtime,backup=map(Path,sys.argv[1:])
for source in backup.iterdir():
    if source.is_dir(): shutil.copytree(source,runtime/source.name,dirs_exist_ok=True,symlinks=True)
    else: shutil.copy2(source,runtime/source.name)
PY
  owner_service restart workout-builder.service || true
}
trap 'rollback; exit 1' ERR
python3 - "$stage_directory" "$runtime_directory" <<'PY'
from pathlib import Path
import os,shutil,sys
stage,runtime=map(Path,sys.argv[1:])
owner=runtime.stat()
for name in ['dist','node_modules','python','deploy','scripts','package.json','package-lock.json','README.md']:
    source,destination=stage/name,runtime/name
    if source.is_dir(): shutil.copytree(source,destination,dirs_exist_ok=True,symlinks=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    else: shutil.copy2(source,destination)
    for path in [destination,*(destination.rglob('*') if destination.is_dir() else [])]:
        os.chown(path,owner.st_uid,owner.st_gid,follow_symlinks=False)
# Keep the old entry point until account creation and service installation succeed.
shutil.copytree(stage/'dist-ui/assets',runtime/'dist-ui/assets',dirs_exist_ok=True)
PY
if [[ ! -e "$runtime_directory/.venv" ]]; then sudo -u "$runtime_owner" -H python3 -m venv "$runtime_directory/.venv"; fi
sudo -u "$runtime_owner" -H "$runtime_directory/.venv/bin/python" -c 'import sys; assert sys.version_info >= (3,12), "Existing Python environment requires manual attention; Python 3.12+ is required."'
sudo -u "$runtime_owner" -H "$runtime_directory/.venv/bin/python" -m pip install -r "$runtime_directory/python/requirements.txt"
bash "$runtime_directory/scripts/install-hosted-service.sh" "$runtime_directory"
account_exists="$(sudo -u workout-builder python3 - "$first_username" <<'PY'
from pathlib import Path
import sqlite3,sys
path=Path('/var/lib/local-workout-builder/accounts.sqlite')
if not path.exists(): print('no')
else:
    with sqlite3.connect(path) as db:
        print('yes' if db.execute('SELECT 1 FROM users WHERE username=? AND disabled=0',(sys.argv[1].strip().lower(),)).fetchone() else 'no')
PY
)"
if [[ "$account_exists" != yes ]]; then
  sudo -u workout-builder env WORKOUT_DATA_DIR=/var/lib/local-workout-builder /usr/bin/node "$runtime_directory/dist/shared/admin.js" create "$first_username"
else
  echo 'The first app account already exists; its password is unchanged.'
fi
owner_service stop workout-builder.service
install -m 0644 "$stage_directory/dist-ui/index.html" "$runtime_directory/dist-ui/index.html.next"
mv -- "$runtime_directory/dist-ui/index.html.next" "$runtime_directory/dist-ui/index.html"
systemctl enable --now workout-builder-hosted.service
curl --fail --silent --retry 10 --retry-connrefused --retry-delay 1 -H 'Host: promaxgb10-4e2b.tail06a565.ts.net:8443' http://127.0.0.1:4173/ >/dev/null
status="$(curl --silent -o /dev/null -w '%{http_code}' -H 'Host: promaxgb10-4e2b.tail06a565.ts.net:8443' http://127.0.0.1:4173/api/profile)"
[[ "$status" == 401 ]]
owner_service disable workout-builder.service
trap - ERR
echo "Hosted service is active. Previous runtime backup: $backup_directory"
echo 'Refresh https://promaxgb10-4e2b.tail06a565.ts.net:8443/ and sign in with your app account.'
