---
name: render-queue
description: 溜まったレンダリングジョブを夜間にまとめて消化する。寝る前に「/render-queue」で起動。「/render-queue add <episodeDir>」で積むだけも可。
---

# /render-queue — 夜間レンダーキュー

フルレンダーはCPUを長時間占有する。日中は `scripts/render-queue.sh add` でジョブを積むだけにし、寝る前に本スキルでまとめて消化する。ランナーはnohupで切り離されるため、**起動したら完了を待たずに終了してよい**(セッションを開いたままにする必要はない)。

## 手順

### 引数なし(消化開始)

1. `scripts/render-queue.sh list` でキューの件数を確認する
2. **0件**: 「キューは空です。積むには `/render-queue add <episodeDir>`」と案内して終了
3. **1件以上**: `scripts/render-queue.sh run` で消化を開始する(runはnohupランナーを切り離し、ジョブを順次消化する)。ユーザーに「**朝に queue.log と各エピソードの `out/.render-status-*.json` を確認する**」ことを案内し、**即終了する(完了を待たない。ハーネスに監視タスクを残さない)**

### `add <episodeDir> [out名]` 付き

- `scripts/render-queue.sh add <episodeDir> [out名]` でジョブを追加するだけ。消化は開始しない

## 備考

- **二重起動**: すでにランナーが動いている状態で `run` しても、新しいランナーは立てず既存ランナーに委ねる(積んだジョブは既存ランナーが順次拾う)。addだけして終了すればよい
- `scripts/render-queue.sh clear` でキューを空にできる
- キューに積む前に必ずスモークQA(`npx tsx src/pipeline/qa-smoke.ts episodes/<epId>`)を全緑にしておくこと(NGのままキューに積むと夜間レンダーが無駄になる。/video-create 工程9a参照)
