# YouTubeアップロード セットアップ手順

## 1. OAuthクライアントの設置(ファクトリーで1回)

UIの **設定タブ →「YouTube連携(ファクトリー共通)」** で行う。

1. セクション内の「Google Cloud側の準備(5ステップ)」ガイドに従って
   OAuthクライアントJSONをダウンロードする(各ステップにConsole直リンクと詳細あり。
   リダイレクトURIは画面のコピーボタンの値を使う)
2. ダウンロードしたJSONを貼り付け(または「ファイルを選択…」)→「保存」
3. 設置は即有効(サーバー再起動は不要)

補足: 手動で `factory-ui/youtube-client.json` に置いても同じように動く(git追跡外)。

## 2. チャンネル連携(チャンネルごとに1回)

1. エピソード詳細 → YouTubeアップロードパネル → 「YouTube連携」
2. 別タブのGoogle認可で **該当チャンネルのブランドアカウントを選択**
3. 「連携が完了しました」表示後、パネルの「状態を再確認」

## 3. エピソードのアップロード

1. `episodes/<ep>/publish/metadata.json` を用意(title/description/tags/categoryId、
   任意で privacyStatus・thumbnail。省略時は private)
2. パネルで動画ファイル(既定 out/final.mp4)を確認して「YouTubeへアップロード」
3. 完了後のURLから YouTube Studio で内容確認 → 公開

## 注意

- OAuthアプリが未審査(テスト公開)の場合、アップロード動画が非公開ロックされることがある
- アップロードは1本あたり約1600クォータ(日次既定10,000 ≒ 6本/日)
- トークンは `<チャンネル>/channel/youtube-oauth.json`。失効時はパネルに「再連携」が出る
