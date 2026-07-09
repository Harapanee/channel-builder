#!/bin/bash
# レンダリングキュー(恒久ツール)
# 溜まったレンダージョブを1本ずつ scripts/render-episode.sh で消化する。
# 寝る前に積んで run しておけば、caffeinate 下で夜間に順次消化される。
#
# サブコマンド:
#   add <episodeDir> [outName]  ジョブをキューに積む(outName既定: preview)
#   run                          ランナーをnohupで切り離して起動し、即座に返る
#   list                         キュー・ランナー状態を表示
#   clear                        未実行ジョブを全て削除
#
# 実体: render-queue/ にジョブJSON(job-<連番>.json)。
#       完了→ render-queue/done/ 失敗→ render-queue/failed/ へ移動。
# ログ: render-queue/queue.log(全体ログ。各レンダーの詳細もここに追記)
#
# 設計メモ:
# - run はランナーを nohup で自分自身(__runner)として切り離す。ハーネス管理の
#   フォアグラウンドタスクはセッション終了で殺されるため、render-episode.sh の
#   nohup+ステータスファイル運用と同じ思想で必須。
# - 二重起動ガード: render-queue/runner.pid + kill -0 生存確認(stale pidは自動除去)
# - DRY_RUN=1 scripts/render-queue.sh run … レンダー実行を echo に差し替えて
#   ランナーの動作(取り出し順・done/failed移動・ログ)だけを確認できる
set -u
cd "$(dirname "$0")/.."

QDIR="render-queue"
PIDFILE="$QDIR/runner.pid"
LOG="$QDIR/queue.log"
mkdir -p "$QDIR/done" "$QDIR/failed"

runner_alive() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
}

cmd_add() {
  EP="${1:?usage: render-queue.sh add <episodeDir> [outName]}"
  OUT="${2:-preview}"
  if [ ! -d "$EP" ]; then
    echo "episodeDir が存在しません: $EP"
    exit 1
  fi
  if [ ! -f "$EP/timing.json" ]; then
    echo "警告: $EP/timing.json がありません(render-episode.sh が失敗します)"
  fi
  # 連番: pending/done/failed 全体の最大+1(消化済みと衝突しない)
  last=$(ls "$QDIR" "$QDIR/done" "$QDIR/failed" 2>/dev/null \
    | grep -oE '^job-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
  seq=$(( ${last:-0} + 1 ))
  JOB=$(printf "job-%04d.json" "$seq")
  node -e '
const [seq, ep, out] = process.argv.slice(1);
console.log(JSON.stringify(
  { seq: Number(seq), episodeDir: ep, out, enqueuedAt: new Date().toISOString() },
  null, 2));
' "$seq" "$EP" "$OUT" > "$QDIR/$JOB"
  echo "queued: $QDIR/$JOB ($EP -> out/$OUT.mp4)"
}

cmd_list() {
  echo "=== render-queue ==="
  if runner_alive; then
    echo "runner: RUNNING (pid $(cat "$PIDFILE"))"
  else
    echo "runner: stopped"
  fi
  pending=0
  for f in "$QDIR"/job-*.json; do
    [ -e "$f" ] || continue
    pending=$((pending + 1))
    node -e '
const j = require(process.argv[1]);
console.log(`  [pending] ${require("path").basename(process.argv[1])}: ${j.episodeDir} -> out/${j.out}.mp4 (enqueued ${j.enqueuedAt})`);
' "./$f"
  done
  [ "$pending" -eq 0 ] && echo "  (pendingなし)"
  echo "done: $(ls "$QDIR/done" 2>/dev/null | grep -c '^job-' || true) / failed: $(ls "$QDIR/failed" 2>/dev/null | grep -c '^job-' || true)"
}

cmd_clear() {
  n=0
  for f in "$QDIR"/job-*.json; do
    [ -e "$f" ] || continue
    rm -f "$f"
    n=$((n + 1))
  done
  echo "cleared: 未実行ジョブ ${n}件を削除しました(done/failed/logは保持)"
}

cmd_run() {
  if runner_alive; then
    echo "既にランナーが稼働中です (pid $(cat "$PIDFILE"))。二重起動はしません"
    exit 1
  fi
  rm -f "$PIDFILE" # stale pidfile の掃除
  if ! ls "$QDIR"/job-*.json >/dev/null 2>&1; then
    echo "キューが空です。先に add でジョブを積んでください"
    exit 0
  fi
  nohup bash "$0" __runner >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  disown
  echo "runner started (pid $(cat "$PIDFILE"))${DRY_RUN:+ [DRY_RUN]}"
  echo ""
  cmd_list
  echo ""
  echo "進捗確認: tail -f $LOG / scripts/render-queue.sh list"
}

cmd_runner() {
  # ここは nohup で切り離されたランナー本体(直接呼ばない)
  trap 'rm -f "$PIDFILE"' EXIT
  echo "=== runner start $(date '+%F %T') (pid $$)${DRY_RUN:+ [DRY_RUN]} ==="
  while true; do
    JOB=$(ls "$QDIR"/job-*.json 2>/dev/null | sort | head -1)
    [ -z "$JOB" ] && break
    EP=$(node -e "console.log(require('./$JOB').episodeDir)")
    OUT=$(node -e "console.log(require('./$JOB').out)")
    echo "=== $(basename "$JOB"): $EP -> out/$OUT.mp4 : start $(date '+%F %T') ==="
    if [ "${DRY_RUN:-0}" = "1" ]; then
      echo "[DRY_RUN] caffeinate -ims scripts/render-episode.sh $EP $OUT"
      rc=0
    else
      # レンダー中のスリープ防止。render-episode.sh 内部の再挑戦・QA・
      # ステータスファイル運用はそのまま活きる
      caffeinate -ims scripts/render-episode.sh "$EP" "$OUT"
      rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
      mv "$JOB" "$QDIR/done/"
      echo "=== $(basename "$JOB"): DONE (exit 0) $(date '+%F %T') ==="
    else
      mv "$JOB" "$QDIR/failed/"
      echo "=== $(basename "$JOB"): FAILED (exit $rc) $(date '+%F %T') ==="
    fi
  done
  echo "=== runner end $(date '+%F %T'): queue empty ==="
}

case "${1:-}" in
  add)      shift; cmd_add "$@" ;;
  run)      cmd_run ;;
  list)     cmd_list ;;
  clear)    cmd_clear ;;
  __runner) cmd_runner ;;
  *)
    echo "usage: render-queue.sh <add|run|list|clear>"
    echo "  add <episodeDir> [outName]  ジョブを積む"
    echo "  run                          消化開始(nohupで切り離し、即座に返る)"
    echo "  list                         キュー・ランナー状態"
    echo "  clear                        未実行ジョブを削除"
    exit 1
    ;;
esac
