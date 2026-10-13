#!/usr/bin/env bash
# No image generation here. Asset-generator reads prepare output, then accept imports its exact file.
set -euo pipefail
if [[ "${1:-}" != "prepare" && "${1:-}" != "accept" ]]; then
  echo 'Usage: thumb-en.sh prepare <epId> | accept <epId> --job <id> --file <exact PNG>' >&2
  exit 2
fi
exec npx tsx src/pipeline/en/en-thumb.ts "$@"
