# 声と素材のワークフローガイド(実証済みの手順と落とし穴)

Stage 1〜2(織田信長・ナポレオン計2本)で実証済みの手順。数値・制約は実測に基づく。

## 1. 声の選定(VOICEVOX)

1. 話者一覧: `curl -s http://127.0.0.1:50021/speakers` — 名前とstyle IDの一覧を得る
2. bible §3 の人格から候補を3〜6種選ぶ(例: 「冷静で意地悪」→低音の落ち着いた男性系+呆れ系)
3. **チャンネルの実際のトーンの台詞**でサンプルを合成する(汎用文ではだめ。皮肉・オチを含む2〜3文):
   `POST /audio_query?speaker=<id>&text=<台詞>` → `POST /synthesis?speaker=<id>` → `voice-samples/<名前>.wav`
4. ユーザーに試聴させ確定 → `channel/voice.json`(speakerId / speedScale / pitchScale / intonationScale / defaultPauseAfterLineSec / creditNotice、省略可: pauseLengthScale=句読点ポーズ倍率・省略時0.5)
5. 落とし穴:
   - **speedScale はユーザーが聴いたサンプルと同じ値で固定**する。尺調整でspeedを変える場合は再試聴かユーザー了承を取る
   - creditNotice(例「VOICEVOX:青山龍星」)は動画エンディングとCLAUDE.mdの必須規則に組み込む
   - 疑問形の行はモーラ長より実音声が約0.14秒長い(tts.tsは対応済み。許容差0.3秒)

## 2. キャラクター素材(正典参照方式)

### 正典(canonical)の作成

1. bible §8 からスタイルプロンプト(英語)を組む。Doodle系の実証済み基調:
   `Simple hand-drawn doodle cartoon character, thick rough black marker outlines with sketchy uneven strokes, FLAT PURE SOLID GREEN SCREEN background (bright chroma-key green, completely uniform, no texture), no shading, no gradients, minimal flat color palette. The character itself is FULLY PAINTED with solid opaque flat colors — every garment and prop filled with its own explicitly named flat color, no region left as uncolored line art. Green appears ONLY in the background, never inside the character. ... Style: loose whiteboard doodle cartoon, NOT anime, NOT realistic.`
   - **透過前提の素材は必ず純緑グリーンバックで生成する**(画風を問わず共通の恒久規則)。除去がクロマキーになり、輪郭の閉じ・背景明度に依存しなくなる。動画上の背景は各チャンネルの基調色をRemotion側で敷く。**注意: 白・明色の衣装は緑の環境反射が焼き込まれ薄緑に寄ることがある**(同一キャラ内で一貫していれば実害は小さい。気になる場合はプロンプトに pure white, no green tint を明示)
   - **キャラ本体の全塗り要求(FULLY PAINTED句)と、顔・髪・全衣類・小物への色name明示は省略禁止**。色語ゼロのプロンプトは未着色線画(緑がキャラ内部に透ける)を誘発する(実測2/3)。塗り省略は gen-image / remove-bg の塗り検査(緑面積>88%)が自動で遮断する(意図的な例外のみ `--skip-paint-check` / `--force`)
2. text-to-imageで候補を2〜3枚生成(`npx tsx src/pipeline/gen-image.ts --prompt ... --out assets/characters/<subject>/candidates/canonical-N.png`)
3. **ユーザーが1枚選定**(人間ゲート)→ `canonical.png` へ昇格
4. 選定基準の助言: 人物固有の特徴(帽子・衣装・髪型)より、**チャンネルの顔文法(目・口・頭身)の一致**を優先する。識別は衣装・小物で立てる

### バリアント生成

1. 正典を `--ref` に渡し、差分だけを指示する。プロンプト構造:
   `Use the exact same character from the reference image: same ... same face with the SAME TINY BLACK DOT EYES exactly as in the reference (do not change the eye style), ... Change ONLY the expression and pose: <差分>`
   - **顔のスタイル固定を明示的に書く**こと。書かないと表情変更時に目・顔が別スタイル化する事故が起きる(実測: 明示なしで1/7失敗、明示ありで7/7一発合格)
2. バリアントは1人物8枚以内(表情4種+ポーズ系4種が目安)。それ以上の表現差はmotionヘルパー(揺れ・潰れ)で作る
3. 不合格は差分を言語化してリトライ(最大3回)。3回失敗したらそのバリアントを諦めショット側の演出を変える
4. 敵役・対役も同じワークフローで素材化する(正典+死/敗北バリアント程度でよい)。場所・場面も必要ならAI素材化可(low detail、キャラより目立たせない)

### 背景除去と登録

1. `npx tsx src/pipeline/remove-bg.ts <in> <out>`(モード自動判別: 緑背景→クロマキー+スピル補正 / 旧オフホワイト背景→flood-fill。AIモデル不使用)
2. **除去率をログで確認**: 70〜85%が正常。mode=floodで数%しか除去されない場合は背景が暗い→ `--threshold 190` で再実行(chromaなら不要)
3. コンタクトシート(横並びJPG)を作りユーザーに一括提示→承認後に `assets/library.json` へ登録(approvedBy: "human")。**未登録素材はshots.jsonから参照できない**

### コスト・時間の実測値(見積もりに使う)

- 画像生成: 主経路はcodex CLI(ChatGPTプラン枠・1枚数十秒〜2分)。フォールバックはevolink(約8.8クレジット/枚、gemini-3-pro-image-preview、結果URLは24時間失効→即保存)
- 1人物の素材化: 9〜15回の生成(リトライ込み)≒ 30〜60分(並行作業可)
- Pilot 1本(60〜90秒)の実測: 初回3.8時間 → 2本目1.5時間(基盤・素材再利用時)

## 3. SE / BGM

- テンプレートに実証済みSEパック24種+BGM2曲(効果音ラボ / DOVA-SYNDROME)が同梱されている。**LICENSES.md(商用可・クレジット不要・再配布禁止)を必ず一緒に保つ**こと
- チャンネルの雰囲気に合わない場合のみ差し替え(同サイトの規約を再確認し、LICENSES.mdを更新)
- BGMはチャンネルの「音の署名」: 題材ごとに変えず、チャンネルで固定するのが既定方針
