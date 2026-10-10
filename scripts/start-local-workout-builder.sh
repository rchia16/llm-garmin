#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_directory"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 20+ (including npm), then run this launcher again.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo 'Node.js 20+ is required.' >&2; exit 1;
}
if [[ ! -f node_modules/vite/bin/vite.js ]]; then npm install; fi
if ! bash scripts/setup-garmin-python.sh; then
  echo 'Starting without the optional Garmin connector. Local saving and exports still work.'
  echo 'Retry setup with: bash scripts/setup-garmin-python.sh'
fi
echo 'Open http://localhost:5173/ in your browser. Press Ctrl+C to stop the app.'
exec npm run dev -- --host localhost --strictPort
