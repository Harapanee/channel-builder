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

# HyperFrames CLI(check / render / snapshot)のページ遷移予算は既定10秒固定で、
# clip数・DOMノード数の多い長尺compositionでは超過して check_runtime_failure /
# Navigation timeout になる(実測: 164clip・6700ノード・2600tweenで再現。素材が正しくても落ちる)。
# 遷移待ちは domcontentloaded なので健全なページなら1秒台で返り、上限を上げても遅くならない。
# 呼び出し元が明示指定していればそちらを尊重する。
export PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS="${PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS:-90000}"

# HyperFrames が最初に見つけた ffmpeg を使うため、PATH 先頭に host と別アーキテクチャの
# ビルド(Apple Silicon 上の x86_64 Homebrew 等)があると "FFmpeg cannot start" で
# レンダーが落ちる。ホストと同じアーキテクチャで、実際に -version が通るものを選ぶ。
if [ -z "${HYPERFRAMES_FFMPEG_PATH:-}" ]; then
  _arch=$(uname -m)
  for _c in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg "$(command -v ffmpeg 2>/dev/null)"; do
    [ -x "$_c" ] || continue
    "$_c" -version >/dev/null 2>&1 || continue
    if command -v file >/dev/null 2>&1 && ! file -b "$_c" | grep -q "$_arch"; then continue; fi
    export HYPERFRAMES_FFMPEG_PATH="$_c"
    _p=$(dirname "$_c")
    [ -x "$_p/ffprobe" ] && export HYPERFRAMES_FFPROBE_PATH="$_p/ffprobe"
    break
  done
  [ -n "${HYPERFRAMES_FFMPEG_PATH:-}" ] && echo "ffmpeg: $HYPERFRAMES_FFMPEG_PATH ($_arch)" >&2
fi

epId=$(basename "$EP")
# shorts/ 配下は縦型コンポジション(Short)+ショート用シーン捜索先に切替える
case "$EP" in
  shorts/*) COMPOSITION="Short"   ; SCENES="src/scenes/shorts/$epId" ;;
  *)        COMPOSITION="Episode" ; SCENES="src/scenes/episodes/$epId" ;;
esac
STATUS="$EP/out/.render-status-$OUT.json"

# --- HyperFrames分岐: composition.html があればHF経路(Remotionへ進まない) ---
EPDIR="$EP"
OUTDIR="$EPDIR/out"
if [ -f "$EPDIR/composition.html" ]; then
  mkdir -p "$OUTDIR"
  rm -f "$STATUS"
  cp "$EPDIR/composition.html" index.html || { printf '{"ok":false,"reason":"copy_composition_failed","qaExit":1}\n' > "$STATUS"; exit 1; }
  if ! npx --yes hyperframes@0.7.68 check --timeout 60000 > "$OUTDIR/check-$OUT.log" 2>&1; then
    printf '{"ok":false,"reason":"check_failed","qaExit":1}\n' > "$STATUS"; exit 1
  fi
  ok=0
  for i in 1 2 3; do
    if npx --yes hyperframes@0.7.68 render > "$OUTDIR/render-$OUT-try$i.log" 2>&1; then ok=1; break; fi
    echo "render try $i failed, retrying..." >&2; sleep 5
  done
  if [ "$ok" -ne 1 ]; then printf '{"ok":false,"reason":"render_failed","qaExit":1}\n' > "$STATUS"; exit 1; fi
  latest=$(ls -t renders/*.mp4 2>/dev/null | head -1)
  if [ -z "$latest" ]; then printf '{"ok":false,"reason":"no_output","qaExit":1}\n' > "$STATUS"; exit 1; fi
  cp "$latest" "$OUTDIR/$OUT.mp4"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTDIR/$OUT.mp4" 2>/dev/null || echo 0)

  # --- Mechanical QA(HF経路)---
  # 2026-07-29 新設。それまでこの分岐は QA を一度も実行せず `qaExit:0` を
  # ハードコードで書いていた(=検査せずに合格と記録していた)。その結果、
  # bible §11 の【不変規則】「ラウドネス基準 -14 LUFS」が誰にも検査されず素通りし、
  # Pilot の完成mp4が -11.8 LUFS(ナレーション単体 -14.7 に対し BGM/SE が +2.9 LU)で
  # 上がっていたのを人手で発見した。同じ見落としを繰り返さないよう機械化する。
  qa_exit=0
  qa_notes=""
  lufs=$(ffmpeg -hide_banner -nostats -i "$OUTDIR/$OUT.mp4" -af ebur128=framelog=quiet -f null - 2>&1 \
    | awk '/Integrated loudness/{f=1} f&&/I:/{print $2; exit}')
  if [ -z "$lufs" ]; then
    qa_exit=1; qa_notes="loudness_unmeasurable"
    echo "QA NG: ラウドネスを測定できませんでした" >&2
  else
    # bible §11: 基準 -14 LUFS。製作上の許容は ±1.0 LU
    if awk -v v="$lufs" 'BEGIN{exit !(v > -13.0 || v < -15.0)}'; then
      qa_exit=1; qa_notes="loudness_out_of_spec"
      echo "QA NG: 統合ラウドネス ${lufs} LUFS が基準 -14 LUFS ±1.0 を外れています(bible §11 不変規則)" >&2
      echo "       ナレーションが主役か・BGM/SEが大きすぎないかを確認してください" >&2
    else
      echo "QA OK: 統合ラウドネス ${lufs} LUFS(基準 -14 ±1.0)"
    fi
  fi

  printf '{"out":"%s","ok":%s,"durationSec":%s,"qaExit":%s,"lufs":"%s","qaNotes":"%s"}\n' \
    "$OUTDIR/$OUT.mp4" "$([ "$qa_exit" -eq 0 ] && echo true || echo false)" "${dur%.*}" "$qa_exit" "$lufs" "$qa_notes" > "$STATUS"
  if [ "$qa_exit" -ne 0 ]; then
    echo "NG(HF): $OUTDIR/$OUT.mp4 は出力されましたが QA に落ちています" >&2
    exit 1
  fi
  echo "OK(HF): $OUTDIR/$OUT.mp4 (${dur}s)"
  exit 0
fi
# --- 以下、従来のRemotion経路(無変更) ---

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
# FORCE_COLOR環境下ではconsole.logの数値にANSIカラーが混入し
# --concurrency等が "\e[33m6\e[39m" になってremotionが落ちるため、色を明示的に殺す
EXPECT=$(FORCE_COLOR=0 NO_COLOR=1 node -e "console.log(require('./$EP/timing.json').totalDurationSec)" | sed $'s/\x1b\\[[0-9;]*m//g')

# 空きメモリ(free+inactive)からワーカー数を決める: 1ワーカー≈0.6GB、4〜10にクランプ
AVAIL_GB=$(vm_stat | awk '/Pages free/{f=$3} /Pages inactive/{i=$3} END{gsub(/\./,"",f); gsub(/\./,"",i); print (f+i)*16384/1073741824}')
CORES=$(sysctl -n hw.ncpu)
CONC=$(FORCE_COLOR=0 NO_COLOR=1 node -e "const a=Math.floor($AVAIL_GB/0.6); console.log(Math.max(4, Math.min(10, Math.min($CORES-2, a))))" | sed $'s/\x1b\\[[0-9;]*m//g')
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
