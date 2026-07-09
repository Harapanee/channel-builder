#!/bin/bash
# preview.mp4をfinal.mp4へ無劣化コピーで昇格する(委任モード用の二重レンダー排除)
# - previewレンダー後に入力(台本・素材・シーン実装等)が一切更新されていない場合のみ、
#   ビット同一のfinalを作るためだけの再レンダーを省略できる。
# - 判定: src/, assets/, <episodeDir>配下でpreview.mp4より新しいファイルが1件でもあれば拒否。
#   ただし <episodeDir>/out・/review・/publish配下、.DS_Store、*.log、episode.jsonは判定対象から除外する
#   (episode.jsonはレンダー入力ではなく、preview後のstatus更新で必ず新しくなるため)。
# 使い方: scripts/promote-preview.sh <episodeDir>
set -u
EP="${1:?usage: promote-preview.sh <episodeDir>}"
cd "$(dirname "$0")/.."

PREVIEW="$EP/out/preview.mp4"
FINAL="$EP/out/final.mp4"

if [ ! -f "$PREVIEW" ]; then
  echo "=== $PREVIEW が存在しません。先に scripts/render-episode.sh $EP preview を実行してください ==="
  exit 1
fi

NEWER=$(find src assets "$EP" -type f -newer "$PREVIEW" \
  ! -path "$EP/out/*" \
  ! -path "$EP/review/*" \
  ! -path "$EP/publish/*" \
  ! -name ".DS_Store" \
  ! -name "*.log" \
  ! -name "episode.json")

if [ -n "$NEWER" ]; then
  echo "=== 入力が更新されています(previewより新しいファイル) ==="
  echo "$NEWER"
  echo "入力が更新されている。scripts/render-episode.sh $EP final で直接finalをレンダーせよ"
  exit 1
fi

cp -p "$PREVIEW" "$FINAL"
echo "昇格完了(QAは同一ビットのpreviewで実施済み)"
exit 0
