#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_directory"
check_only=false
case "${1:-}" in
  '') ;;
  --check) check_only=true ;;
  *) echo 'Usage: bash scripts/setup-garmin-python.sh [--check]' >&2; exit 1 ;;
esac

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) environment_python='.venv/Scripts/python.exe'; python_download_url='https://www.python.org/downloads/windows/' ;;
  *) environment_python='.venv/bin/python'; python_download_url='https://www.python.org/downloads/' ;;
esac
show_python_install_guidance() {
  echo 'Garmin integration requires Python 3.12+. Python 3.13 is recommended.' >&2
  echo "Download: $python_download_url" >&2
  echo 'Install Python, reopen your terminal, and rerun the launcher.' >&2
  echo 'The app can still run without Garmin integration.' >&2
}
supported_python() {
  "$@" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1
}

if [[ -e .venv ]]; then
  if [[ ! -f "$environment_python" ]] || ! supported_python "$environment_python"; then
    show_python_install_guidance
    echo 'Existing .venv is incompatible or incomplete; it was not overwritten. See README Python setup.' >&2
    exit 1
  fi
elif "$check_only"; then
  show_python_install_guidance
  echo 'Optional Garmin Python environment is not set up yet.' >&2
  exit 1
else
  candidate=()
  for command in python3.13 python3.12 python3 python; do
    if command -v "$command" >/dev/null 2>&1 && supported_python "$command"; then
      candidate=("$command")
      break
    fi
  done
  if [[ ${#candidate[@]} -eq 0 ]] && command -v py >/dev/null 2>&1; then
    for version in -3.13 -3.12 -3; do
      if supported_python py "$version"; then candidate=(py "$version"); break; fi
    done
  fi
  if [[ ${#candidate[@]} -eq 0 ]]; then
    show_python_install_guidance
    exit 1
  fi
  echo 'Creating the optional Garmin Python environment...'
  "${candidate[@]}" -m venv .venv
fi

if ! "$environment_python" -c 'import garminconnect, dotenv' >/dev/null 2>&1; then
  if "$check_only"; then echo 'Garmin Python dependencies are missing.' >&2; exit 1; fi
  echo 'Installing the optional Garmin Python dependencies...'
  "$environment_python" -m pip install --disable-pip-version-check -r python/requirements.txt
  "$environment_python" -c 'import garminconnect, dotenv'
fi
echo 'Garmin Python bridge ready. Sign in using Connect Garmin in the app.'
