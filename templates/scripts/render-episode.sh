#!/bin/bash
# エピソード最終レンダー(恒久ツール)
# - caffeinate: レンダー中のシステムスリープを防止
# - メモリ適応concurrency: 空きメモリに応じてChromeワーカー数を自動決定
# - 自動再挑戦(最大4回): 外部要因でプロセスが死んでも完走させる
# - 完走後にMechanical QAを自動実行
# - Infinity事前ゲート: interpolate系にInfinityが混入した状態でのレンダー突入を阻止
# - 完了ステータスマーカー(out/.render-status-<out>.json): nohup運用時に監視側(wait-render.sh)が
#   完了を検知できるよう、全ての終了経路でJSONを書く
# 使い方: scripts/render-episode.sh <episodeDir|shortDir> [out名(既定preview)]
set -u
EP="${1:?usage: render-episode.sh <episodeDir> [outName]}"
OUT="${2:-preview}"
cd "$(dirname "$0")/.."

epId=$(basename "$EP")
# shorts/ 配下は縦型コンポジション(Short)+ショート用シーン捜索先に切替える
case "$EP" in
  shorts/*) COMPOSITION="Short"   ; SCENES="src/scenes/shorts/$epId" ;;
  *)        COMPOSITION="Episode" ; SCENES="src/scenes/episodes/$epId" ;;
esac
STATUS="$EP/out/.render-status-$OUT.json"

mkdir -p "$EP/out"
rm -f "$STATUS"

# ステータスJSONを書くヘルパー(jq非依存、node -eで安全に組み立てる)
# 引数: ok(true/false) reason(不要なら"") durationSec(不要なら"") qaExit(不要なら"") attempt(不要なら"")
write_status() {
  node -e '
const [outName, ok, reason, dur, qaExit, attempt] = process.argv.slice(1);
const obj = { out: outName, ok: ok === "true" };
if (reason !== "") obj.reason = reason;
if (dur !== "") obj.durationSec = Number(dur);
if (qaExit !== "") obj.qaExit = Number(qaExit);
if (attempt !== "") obj.attempt = Number(attempt);
obj.finishedAt = new Date().toISOString();
console.log(JSON.stringify(obj));
' "$OUT" "$1" "$2" "$3" "$4" "$5" > "$STATUS"
}

# --- Infinity事前ゲート(timing.json読み込みより前) ---
# 過去エピソードでNumber.POSITIVE_INFINITYをinterpolateに渡し、tscでは検出できないまま
# レンダー実行時クラッシュを4回連続で起こした実測があるための機械ゲート。
if [ -d "$SCENES" ] && [ "${SKIP_INFINITY_CHECK:-0}" != "1" ]; then
  # コメント行(// や * / /* で始まる行)は誤検知になるため除外する(コード上の使用のみ検出)
  HITS=$(grep -rnw 'Infinity' "$SCENES" | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|/\*)' || true)
  if [ -n "$HITS" ]; then
    echo "=== INFINITY GATE: interpolate系へのInfinity混入を検出 ==="
    echo "$HITS"
    echo "Remotionのinterpolate系にInfinityを渡すと実行時クラッシュする(tscでは検出不能)。修正するか SKIP_INFINITY_CHECK=1 で強行してください。"
    write_status false infinity_gate "" "" ""
    exit 3
  fi
fi

# 期待尺(narration実長)をtimingから取得
EXPECT=$(node -e "console.log(require('./$EP/timing.json').totalDurationSec)")

# 空きメモリ(free+inactive)からワーカー数を決める: 1ワーカー≈0.6GB、4〜10にクランプ
AVAIL_GB=$(vm_stat | awk '/Pages free/{f=$3} /Pages inactive/{i=$3} END{gsub(/\./,"",f); gsub(/\./,"",i); print (f+i)*16384/1073741824}')
CORES=$(sysctl -n hw.ncpu)
CONC=$(node -e "const a=Math.floor($AVAIL_GB/0.6); console.log(Math.max(4, Math.min(10, Math.min($CORES-2, a))))")
echo "=== render: $EP -> out/$OUT.mp4 (expect ${EXPECT}s, concurrency $CONC, avail ${AVAIL_GB%.*}GB) ==="

for attempt in 1 2 3 4; do
  echo "=== attempt $attempt: $(date '+%H:%M:%S') ==="
  caffeinate -ims npx remotion render src/remotion/Root.tsx "$COMPOSITION" "$EP/out/$OUT.mp4" \
    --props="{\"episodeDir\":\"$EP\"}" --concurrency="$CONC" 2>&1 | grep -vE "^Rendering|^Encoded"
  code=$?
  if [ -f "$EP/out/$OUT.mp4" ]; then
    dur=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$EP/out/$OUT.mp4")
    ok=$(node -e "console.log(Math.abs($dur - $EXPECT) < 1 ? 1 : 0)")
    if [ "$ok" = "1" ]; then
      echo "=== COMPLETE (${dur}s) ==="
      npx tsx src/pipeline/qa.ts "$EP" 2>&1 | tail -9
      qaExit=${PIPESTATUS[0]}
      write_status true "" "$dur" "$qaExit" "$attempt"
      exit "$qaExit"
    fi
  fi
  echo "=== attempt $attempt ended (exit $code) - retry in 10s ==="
  # 失敗時は自プロジェクトの孤児Chromeのみ掃除(他プロジェクトは触らない)
  ps aux | grep "[c]hrome-headless" | awk '{print $2}' | while read pid; do
    cwd=$(lsof -p "$pid" 2>/dev/null | awk '/cwd/{print $NF}')
    [ "$cwd" = "$(pwd)" ] && kill "$pid" 2>/dev/null
  done
  sleep 10
done
echo "=== ALL ATTEMPTS FAILED ==="
write_status false all_attempts_failed "" "" "4"
exit 1
