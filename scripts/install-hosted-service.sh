#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then echo 'Run with sudo; this creates the dedicated service account and installs the system service.' >&2; exit 1; fi
if [[ "$#" -ne 1 ]]; then echo 'Usage: sudo bash scripts/install-hosted-service.sh /absolute/runtime/directory' >&2; exit 1; fi
runtime_directory="$(realpath -- "$1")"
if [[ "$runtime_directory" != /* || "$runtime_directory" == / || "$runtime_directory" == *[$'\n\r\t %']* ]]; then echo 'Use an absolute deployment path without whitespace, % or control characters.' >&2; exit 1; fi
for tool in setfacl python3 node systemctl; do command -v "$tool" >/dev/null || { echo "Install required tool: $tool" >&2; exit 1; }; done
for item in dist dist-ui node_modules python .venv package.json deploy/workout-builder-hosted.service; do
  [[ -e "$runtime_directory/$item" ]] || { echo "Missing runtime component: $item" >&2; exit 1; }
  [[ ! -L "$runtime_directory/$item" ]] || { echo "Runtime component must not be a symlink: $item" >&2; exit 1; }
done
if ! id workout-builder >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/local-workout-builder --no-create-home --shell /usr/sbin/nologin workout-builder
fi
if [[ "$(getent passwd workout-builder | cut -d: -f7)" != /usr/sbin/nologin ]]; then echo 'Existing workout-builder account must be a dedicated nologin service account.' >&2; exit 1; fi
install -d -m 0700 -o workout-builder -g workout-builder /var/lib/local-workout-builder
# Permit traversal to this runtime without granting directory listing or access to SSH files.
ancestor_directory="$runtime_directory"
while [[ "$ancestor_directory" != / ]]; do
  setfacl -m u:workout-builder:--x -- "$ancestor_directory"
  ancestor_directory="$(dirname -- "$ancestor_directory")"
done
for item in dist dist-ui node_modules python .venv package.json; do
  setfacl -R -P -m u:workout-builder:rX -- "$runtime_directory/$item"
done
# Explicitly deny the runtime owner's SSH directory and local Garmin configuration,
# even if that owner has accidentally made them readable to other OS accounts.
runtime_owner_home="$(getent passwd "$(stat -c '%U' -- "$runtime_directory")" | cut -d: -f6)"
for private_path in "$runtime_directory/.env" "$runtime_owner_home/.ssh" "$runtime_owner_home/.local/share/LocalWorkoutBuilder/garmin"; do
  if [[ -e "$private_path" ]]; then setfacl -m u:workout-builder:--- -- "$private_path"; fi
done
python3 - "$runtime_directory" <<'PY'
from pathlib import Path
import sys
runtime = Path(sys.argv[1])
text = (runtime / 'deploy/workout-builder-hosted.service').read_text()
Path('/etc/systemd/system/workout-builder-hosted.service').write_text(text.replace('@RUNTIME_DIRECTORY@', str(runtime)))
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/workout-builder-hosted.service
echo 'Service installed but not started. Create app accounts first, then stop the old user service and start workout-builder-hosted.service.'
