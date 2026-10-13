# 英語制作（任意採用）

英語制作ツールは同梱されるが、既定の日本語制作工程には追加しない。採用するチャンネルでのみ英語の話者・翻訳方針・図解・公開運用を決める。既存チャンネルへは `/factory-update` で必要な部品を選択して取り込む。

## 導入

1. `channel/english/voice-en.example.json` は無効な見本。承認済みの話者・言語・話速範囲・engine を決めて `voice-en.json` を作る。サンプルの話者文字列のまま実行しない。日本語 `channel/voice.json` は変更しない。同期検査は `voice-en.json` の存在を明示採用の印として扱う。
2. `thumb-prompt.example.txt` を自チャンネルの画風・教義に合わせて `thumb-prompt.txt` にし、置換対象 `{{THUMB_TEXT}}` を残す。他チャンネルの翻訳brief・固定話者・教義はコピーしない。
3. FFmpeg/ffprobe、Node/tsx、Pythonが必要。付属 `scripts/en-dub/setup.sh` は macOS Apple Silicon + Homebrew + uv 向けで、依存をインストールするため採用時だけ実行する。MLXはローカルGPU、onnxはCPU。ほかの環境はエンジン起動パスを適合させるまで未対応。
4. MLXモデルは初回だけ承認した版をローカルに準備する。`~/.cache/en-dub/mlx-venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('prince-canuma/Kokoro-82M')"` でキャッシュを用意する。以後は現在のローカルsnapshot・モデル実体ハッシュを記録して合成する。モデルや依存を更新すると再合成対象になる。
5. `episodes/<epId>/en/en.json` は timing.json の行IDに対応する `lines`、`episodeId`、公開用 `title` / `description` / `thumbText`、必要に応じて `thumbSource` を持つ。翻訳は担当エージェントが原文・数字・否定・比較を確認する。形式検査の合格を翻訳品質保証にしない。

## 制作と確認

`npm run en:check -- <epId>` → `en:tts` → `en:mix` → `en:subs` → `en:qa` → `en:package`。すべて `<epId>` を引数に取る。英語の未完は日本語版の完了を止めない。

- **差分TTS**: 英文・原文・話者・モデル/ライブラリ・合成スクリプトが同じでWAVハッシュが有効な行だけ再利用する。`--force` は全生成。`--only L01,L02` でも対象外の古い行を有効扱いしない。timingのみ変更時は `--report-only` で配置適合を再判定できる。来歴なしの旧WAVは再認定しない。
- **終了コード**: `en:tts` はEXPANDだけなら警告して0（空白の試聴対象。強制加筆しない）。SHRINK/SPEEDが残る場合1、入力/来歴不正は2。冒頭45秒・2秒超の空白・数字・速度変更・長い字幕を `en:qa` で優先確認する。
- **入力ハッシュ**: mix/subsは原文・英訳・timing・WAV・fitが一致しなければ停止する。mixはBGM/SE・旧経路の元BGM・環境音も記録する。失敗後の古い出力を採用しない。
- **保存パッケージ**: `en:package` は `publish/en/package/<hash>/` にMP3/VTTと英訳・timing・来歴を保存し、既存パッケージを上書きしない。公開直前は `en:package -- <epId> --verify <package-dir>` で対象回と全成果物の一致を再確認する。これは公開操作ではない。
- **サムネ**: `en:thumb -- prepare <epId>` のjob ID・参照・正確なプロンプトをasset-generatorへ渡す。生成後 `en:thumb -- accept <epId> --job <id> --file <絶対パスPNG>` でその画像だけ受け入れる。1280×720、元画像/文字一致を検査する。共有生成フォルダの最新画像探索は行わない。明示したthumbSourceを優先する。
- **公開観測**: `en:status -- --json` はローカル観測記録。`en:status -- --record <epId> <evidence.json>` は `{videoId,observedAt,fields:{audio:{state,raw}}}` 形式のUI証拠を追記する。fieldsはaudio/titleDescription/thumbnail/captions。stateはnot-recorded/unknown/missing/uploaded/processing/published/failed。source/rawRows/autoDub等も保持する。処理中の昔の記録を現在の公開状態と断定しない。studio-enとupload-resultのID不一致は書込みを止める。
- **字幕**: 既定は実測の行尺を保持し、未知の行内時刻を文字数で捏造しない。`en:subs -- <epId> --alignment <file>` は `schema:1,method:"measured-word-alignment",producer,lines:{L01:{wavHash,textHash,words:[{text,start,end}]}}` の一致確認後だけ文/節・最大2行×42字に分ける。word時刻は行WAV相対の実測値。未導入なら長文/読速をQA対象にする。

公開後の状態確認・自動吹替との区別・字幕のプレイヤー表示・英語としての聞きやすさは別途実測する。音声言語別で公開日から7日/28日に評価する。図解は絵・数値・共通単位を優先し、日本語だけのラベルが残る場合は確認対象にする。

同梱しないもの: チャンネル固有voice/翻訳brief/公開操作スクリプト、旧一括TTSキュー。登録失敗の回復や公開音声差し替えは依頼の許可範囲に従う。
