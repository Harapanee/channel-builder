# Project identity

このリポジトリは「{{CHANNEL_NAME}}」専用のYouTube動画制作システム(Channel Video Factory)である。汎用動画ツールではない。全ての制作判断はこのチャンネルの人格に従う。

- **H3 経路(本編映像を MiniMax H3 で生成する。任意採用)**: `.channel-system.json` に `h3Pipeline.episodes` を宣言したエピソードだけが対象。設計は `docs/superpowers/specs/2026-08-19-h3-prompt-pipeline-design.md`、道具は `src/pipeline/h3/`、規則は `h3/vocab/<epId>.ts`(雛形 `h3/vocab/example-salmon.ts`)。**factory-ui の manual モードでのみ走らせる**(semi/auto は人間ゲートを自動承認する)。GPU を使うコマンドは `H3_ALLOW_GPU=1` が要る(生成 `npm run h3:run` と Pod 起動 `npm run h3:pod -- up` の二重ロック)。**Pod 起動は要確認・停止(`npm run h3:pod -- down`)は必ず行う**。H3 経路のエピソードは**夜間レンダーキューへ投入しない**(assemble の完了が最終物)

# Source of truth

- `channel/bible.md` — チャンネル教義(人格・文法・画風・音)の唯一の定義。全工程がここを参照する
- `channel/voice.json` — ナレーション音声の定義(話者・話速・creditNotice)。**変更禁止**
- `DESIGN.md` — 映像の見た目トークン(配色・書体・線)の具体値。bible §8 の教義を実装値へ落とした契約で、`src/scenes/style.ts` はこれを実装する。変更は design-forge の手順(`validate_design.py` を通す)+ `/channel-refine`
- `channel/review-checklist.md` — レビュアーの検査観点
- `src/schemas/` — 全データ契約(shots/timing/library/episode)のJSON Schema
- `channel/episode-ledger.json` — 全話台帳(題材・アーク・署名・モチーフ。マンネリ検出の機械可読契約)

# Mandatory rules

- 台本・映像・素材の創作判断は必ず `channel/bible.md` に従う。迷ったらbibleを読み直す
- 契約(コードが読むJSON)と教義(LLMが読む散文)を混同しない。契約に機械検証できない値を書かない
- 素材は `assets/library.json` に登録済み(approvedBy: "human")のもののみショットから参照する
- 新規キャラクター素材は必ず参照画像方式: 正典(canonical)を `--ref` に渡して生成 → `remove-bg.ts` → 人間キュレーション → library登録
- AI画像の生成はメインセッションで直接行わず、必ず asset-generator エージェント経由で行う(テンプレ逐語使用と塗り検査を確実にするため)
- 音声素材は `assets/audio/LICENSES.md` に記録のあるもののみ使用
- 再発し得る問題は個別エピソードで直さず `/channel-refine` でシステムへ還元する
- `.channel-system.json` の status が "approved" のとき、bible.md / voice.json / src/scenes/core/ を直接変更しない(hooksがブロックする)
- **エンディングに `channel/voice.json` の `creditNotice` の文言によるクレジット表記を必ず入れる**(音声プロバイダの利用規約上の義務)

# Key commands

- `npm run dev` — HyperFramesプレビュー(本編。必ずbackgroundで起動)
- `npm run check` — 視覚多様性検査 + HF check(本編。レンダー前の機械ゲート)
- `npm run probe episodes/<epId> -- --at <秒,...> -o <出力先>` — **HFエピソードの実フレーム取得はこれだけを使う**。HFランタイムを注入して composition を1回ロードし、複数時刻をまとめて撮る(実測: ロード約65秒+1枚約3秒)。**輝度stdの機械判定+コンタクトシート(contact.jpg)を出すので、OKのフレームは画像をReadしない**。ランタイムを注入しないと時間窓外のclipが重なった別物の絵になる(レンダーとの平均差 117→2.25)
- `npm run snapshot`(hyperframes CLI)は**完成尺のcompositionでは動かない**(215clip/490KBで Navigation timeout。予算を上げても protocolTimeout 180秒で失敗)ため使わない
- `npx tsx src/pipeline/scaffold-composition.ts episodes/<epId> [--groups "cL01-cL50,..."]` — composition.html の骨格を timing.json から機械生成(clip/字幕/音声配線/素材テーブル/共通ヘルパー/SPLICEマーカー)。**工程8の最初に実行し、章グループを最初から並列で走らせる**
- `npm run render` — HyperFramesレンダー(本編)
- **HyperFrames CLI は必ず上記のnpmスクリプト経由で叩く**(`npx hyperframes ...` を直接叩かない)。CLIのページ遷移予算は既定10秒固定で、clip数・DOMノードの多い長尺compositionでは実装が正しくても `check_runtime_failure: Navigation timeout` になる。npmスクリプトと `scripts/render-episode.sh` が `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS=90000` を渡した状態で呼ぶ
- `npm run check:visual -- episodes/<epId>` — 視覚多様性検査のみ
- `npm test` — 単体テスト(tsx --test)
- `npm run studio` — Remotion Studio(ショート・サムネ専用)
- `npm run render:test:short` — ショートのテストレンダー(**Remotion**)
- `npm run tts episodes/<epId>` — 台本→音声+timing.json(自己検証・ラウドネス正規化つき。最終行に pause_after_sec を明示するとその秒数の無音尾が付く=アウトロ尺の確保用)
- `npm run tts episodes/<epId> -- --readings-only` — 誤読プリチェック(audio_queryのみ・数十秒。合成前にreading-checkerへ)
- `npm run audio-cues episodes/<epId>` — composition の SE台帳(`window.__G<n>_SE_CUES`)から audio-cues.json のSEキューを機械生成する(BGMは storyboard の散文が正本なので人が書く)
- `npm run audio-mix episodes/<epId>` — audio-cues.json(ナレーション+BGM+SE)から `narration/master.mp3` を焼き、composition の `<audio src>` をそこへ差し替える。SE音量は -22 LUFS へ整え、総和はリミッタ(-1.5 dBFS)で抑える。**この工程を飛ばすとBGMもSEも鳴らない**(工程8.4)
- `npm run check:readings episodes/<epId>` — 誤読リスクの機械抽出(readings.md の実読みカナと台本表記を突合し、既知の誤読型を候補リストで出す。exit 1=候補あり)。**reading-checker の前段**。チャンネル固有の語族は `channel/reading-risks.json`(任意)
- `npm run diff:readings episodes/<epId>` — **期待読み(`narration/expected-readings.md`。reading-checker が readings.md を見る前に台本から書く)と VOICEVOX 実読みの機械diff**。差分行だけを出す(exit 1=差分あり / 2=未記入行あり)。判定はしない(合否権は reading-checker)。未知の誤読を拾う側で、check:readings(既知の型)と補完関係
- `channel/user-dict.json`(任意)— **VOICEVOX ユーザー辞書**(表記→カタカナ読み・accentType)。`npm run tts` の起動時にエンジンへ同期し、行キャッシュのキーにも混ぜる。**誤読が確定した名詞はここへ登録する**(台本をひらがなに開かなくてよい・以後の全話に効く)。動詞の活用形・助詞の結合は辞書で固定できないので台本表記で直す。エンジン側に永続する(同じ VOICEVOX を使う他チャンネルにも効く)
- `npm run next-videos episodes/<epId> [-- --apply]` — 「次に見る」2本の選定(最新の analytics スナップショットから、公開後7日以上・本編・平均視聴率の降順)。`publish/next-videos.json` に書き、`--apply` で metadata.json の概要欄末尾へ追記する。**終了画面は API に無いので人間が Studio で置く**
- 【H3経路】`npm run check:h3 -- <epId> [章ID] [--dump <出力先>]` — 生成前のプロンプト検査(exit 0=緑 / 1=ADVISE / 2=BLOCK。B14 は `cuts.json` の `firstWorstLineId` を検査)
- 【H3経路】`npm run h3:pod -- status|up|down` — RunPod の状態・起動・停止(`up` は `H3_ALLOW_GPU=1` 必須・要ユーザー確認。`down` は必ず実行)
- 【H3経路】`H3_ALLOW_GPU=1 npm run h3:run -- <epId> <章ID> [--only <id,..>] --url <PodのURL>` — 章の生成(`--plan` / `--dry` はGPU不要)
- 【H3経路】`npm run h3:inspect -- <epId> <章ID>` — 章のコンタクトシートとストリップ(`review/<epId>/<章ID>-manifest.json` を検品報告の1行目に引用する)
- 【H3経路】`npm run h3:reject -- <epId> <clipId,..>` — 不合格クリップの隔離(削除ではなく移動。再生成の対象に戻す)
- 【H3経路】`npm run h3:audio-cues -- <epId>` / `npm run audio-mix episodes/<epId>` / `npm run h3:ambient -- <epId>` — 音声(BGM+SE の cues → master.mp3 → 生成音の環境音トラック)
- 【H3経路】`npm run h3:subs <epId>` — 字幕を透過PNGに焼く(1回の表示=1文。表示窓は `subs/subs.json`)
- 【H3経路】`npm run h3:figures -- <epId> [--only <id,..>] [--force] [--check]` — 図解オーバーレイ(`h3/episodes/<epId>/figures.json`)と章カードを透過PNG連番に焼く。**`h3:assemble` の前に実行**。設計は `docs/superpowers/specs/2026-09-04-h3-figure-overlay-design.md`
- 【H3経路】`npm run h3:assemble -- <epId> [--out <名前>] [--no-figures]` — クリップ+図解+字幕+master.mp3 を1本に組み立てる(これが最終物。既定の出力先に既存ファイルがあれば exit 2)
- 【H3経路】`npm run typecheck:h3` — 語彙帳・カット文面(`h3/vocab` / `h3/episodes/*/shots`)の型検査
- `npm run usage [-- --since <日付>|--session <id>|--json]` — セッション記録からAPI換算コスト・キャッシュ内訳・**サブエージェントの並列度**(1メッセージ1本の件数・同時最大本数)を集計する
- `npm run check:audio episodes/<epId>` — 音声の配線検査(cues有無・`<audio src>`がmasterか・焼き直し漏れ・BGMが実際に乗っているか)。render-episode.sh のレンダー前ゲートでもある
- `npm run check:assets episodes/<epId> [--strict]` — storyboardの「使用素材」列と composition の実装の突合(既定は報告のみ)
- `npm run qa:frames episodes/<epId> [out名]` — レンダー後の空フレーム検出(何も描かれていないclipを輝度stdで見つける)。render-episode.sh に内蔵
- `npm run validate episodes/<epId>` — shots.json契約検証(shotId一意性・bgmTracks含む)【Remotion経路(shots.json を持つ既存ep・shorts)専用。HF ep は shots.json を持たず `npm run check` で検査する】
- `npx tsx src/pipeline/gen-image.ts ...` — AI画像生成(**直接叩かずasset-generatorエージェント経由**。codex CLI主経路+evolinkフォールバック、`--provider codex|evolink`で強制可)
- `npx tsx src/pipeline/remove-bg.ts <in> <out>` — 背景除去(緑=クロマキー/白=flood-fill自動判別)
- 【Remotion経路(shots.json を持つ既存ep・shorts)専用】 `npx tsx src/pipeline/qa.ts episodes/<epId>` — Mechanical QA(7項目)
- 【Remotion経路(shots.json を持つ既存ep・shorts)専用】 `npx tsx src/pipeline/precheck.ts episodes/<epId>` — レンダー前検査4ゲート(tsc/validate/Infinity/qa-smoke)の一括実行+入力ハッシュ記録(**入力未変更なら数秒でSKIP**。強制再実行は `--force`)。**HF ep は工程9で `npm run check` を使う**
- 【Remotion経路(shots.json を持つ既存ep・shorts)専用】 `npx tsx src/pipeline/qa-smoke.ts episodes/<epId>` — レンダー前スモークQA(全ショット2フレームサンプリングでランタイムエラー・静止・黒を3〜10分検出。**NGゼロまでフルレンダー禁止**。通常はprecheck経由で走る)
- 【Remotion経路(shots.json を持つ既存ep・shorts)専用】 `npx tsx src/pipeline/render-stills.ts episodes/<epId> --shots <id,..> [--at 秒,..]` — 指定ショット中央フレームの静止画一括レンダー(レビューの視覚検証用。**レビュー目的のフルレンダーは禁止** — こちらで代替)。**HF ep は hyperframes-cli の snapshot 系で取得する**
- 【Remotion経路(shots.json を持つ既存ep・shorts)専用】 `npx tsx src/pipeline/repair-render.ts episodes/<epId> <shotId> [--out preview]` — 部分再レンダー+継ぎ接ぎ(1ショット修正を2〜3分に。局所修正はフル再レンダーよりこちらが原則)
- 【Remotion経路(shots.json を持つ既存ep・shorts)専用】 `npx tsx src/pipeline/retime-shots.ts episodes/<epId>` — 台本改訂後のショット追従
- `npx tsx src/pipeline/render-thumbs.ts episodes/<epId>` — サムネ3枚+計測(thumb-metrics.json)+モバイルプレビュー(CLIのremotion still直叩き禁止。720p未満はexit 1)
- `scripts/render-episode.sh episodes/<epId> [out名]` — レンダリング(Infinityゲート・QA・状態書き出し内蔵。remotion render直叩きより優先)
- `npm run tts shorts/<shortId>` — ショート台本→音声+timing.json(本編と同じTTSパイプライン)
- `npm run validate shorts/<shortId>` — ショートshots.json契約検証
- `npm run validate:short-format channel/short-formats/<formatId>.json` — ショートフォーマット契約検証
- `npm run validate:metadata episodes/<epId>` — publish/metadata.json(YouTube公開メタデータ契約)検証(YPP対策のAI開示・制作工程明記・公開予約を含む)。factory-uiのアップロードが読む
- `npm run validate:ledger` — 全話台帳(channel/episode-ledger.json)の契約検証
- `scripts/render-episode.sh shorts/<shortId> [out名]` — ショートレンダー(shorts/はShortコンポジション自動選択)
- `scripts/wait-render.sh episodes/<epId> [out名]` — レンダー完了待ち(nohup本体+これをバックグラウンドBashで=完了即時通知)
- `scripts/promote-preview.sh episodes/<epId>` — 委任モードでpreview→final昇格(入力の更新なしを機械検査)
- `scripts/render-queue.sh add <episodeDir> [out]` / `run` / `list` / `clear` — 夜間レンダーキュー(runはnohupランナー切り離しで順次消化。消化開始は `/render-queue` から)
- `node scripts/check-template-sync.mjs` — channel-builderテンプレート同期の機械検証
- VOICEVOXエンジンが http://127.0.0.1:50021 で起動している必要がある

# Skills

- `/video-create <題材>` — 新規エピソード制作(パイプライン全工程。台本はscript-director+二重審査、10分超は章並列)。引数なし起動でネタ帳(channel/backlog.md)の上位候補から選択
- `/theme-scout` — ネタ帳の補充・再採点(題材候補の採点はtheme-scoutエージェント)
- `/render-queue` — 溜まったレンダリングジョブを夜間にまとめて消化(寝る前に起動。`/render-queue add <episodeDir>` で積むだけも可)
- `/channel-refine <フィードバック>` — このチャンネルの教義への還元(人間承認+マーカー手順)
- `/system-refine` — 全チャンネル共通の工場OS(スキル・エージェント・ツール・契約)の変更+テンプレート同期
- `/short-builder` — ショートフォーマット(構造の型)の登録・改修
- `/short-create <epId> [formatId]` — 完成エピソードからショート動画を生成(台本承認→TTS→実装→Studio確認→夜間キュー)

# Agents(制作の実働。メインセッションは監査・ゲート管理のみ)

fact-checker / script-director / **script-reviewer(台本合否)** / reading-checker(誤読検査) / visual-director / scene-implementer(シーン実装) / asset-generator / compliance-reviewer(準拠合否) / audience-sim / theme-scout(題材採点) / publisher / short-director(ショート台本+ショット) / **H3経路(任意採用)**: h3-cut-planner(カット割り台帳)/ h3-prompt-writer(カット文面)/ h3-prompt-reviewer / h3-fix-writer / h3-clip-inspector(検品)/ figure-planner(図解オーバーレイの宣言。工程7で prompt-writer と並列起動)

# ショート動画の運用注記

- 台本行に `- subtitle: off` を付けると、画面文字と重複するその行の字幕を非表示にできる(縦型の字幕は自動で大きく中央やや下に表示される)
- `channel/short-formats/<formatId>.json` にトップレベル `speech: { speedScale, pauseLengthScale }` を追加すると、そのフォーマットのショートだけ本編と異なる話速・句読点ポーズにできる(未指定時は `channel/voice.json` 準拠)

# チャンネル署名(全動画共通)

<!-- 展開後にこのチャンネルの固定演出を書く。例: 冒頭の定型オープニング、
     章カードの様式、固定アウトロとクレジット。bible §4 と §8 に従うこと。 -->
