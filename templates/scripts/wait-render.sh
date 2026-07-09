#!/bin/bash
# render-episode.shのレンダー完了を待つ軽量ウォッチャー
# - 用途: render-episode.sh本体はnohupで独立起動しておき、本スクリプトを
#   ハーネス管理のバックグラウンドジョブとして走らせることで完了を即時検知する。
# - 本スクリプトが途中で殺されても、ステータスファイルを見るだけの設計なので
#   単純に再実行すればよい(状態を持たない)。
# 使い方: scripts/wait-render.sh <episodeDir> [outName(既定preview)]
set -u
EP="${1:?usage: wait-render.sh <episodeDir> [outName]}"
OUT="${2:-preview}"
cd "$(dirname "$0")/.."

STATUS="$EP/out/.render-status-$OUT.json"
MAX_WAIT_SEC="${MAX_WAIT_SEC:-10800}"
elapsed=0

echo "=== waiting for: $STATUS (max ${MAX_WAIT_SEC}s) ==="
while [ ! -f "$STATUS" ]; do
  if [ "$elapsed" -ge "$MAX_WAIT_SEC" ]; then
    echo "=== TIMEOUT: ${MAX_WAIT_SEC}秒待っても $STATUS が現れませんでした ==="
    echo "タイムアウト(レンダープロセスの生存確認を推奨)"
    exit 2
  fi
  sleep 10
  elapsed=$((elapsed + 10))
done

cat "$STATUS"

node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit(data.ok === true && data.qaExit === 0 ? 0 : 1);
' "$STATUS"
exit $?
