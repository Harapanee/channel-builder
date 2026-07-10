# channel-builder — Channel Video Factory

YouTubeチャンネル専用の動画制作システム(Channel Video Factory)を構築・運用するためのセットです。2つの部品からなり、**それぞれ設置場所が異なります**。

| 部品 | 中身 | 設置場所 |
|---|---|---|
| スキル本体 | `SKILL.md` / `MANUAL.md` / `templates/` / `references/` | `~/.claude/skills/channel-builder/` |
| factory-ui | ファクトリー管理のブラウザUI(`factory-ui/`) | ファクトリールート直下にコピー |

## 前提

- [Claude Code](https://claude.com/claude-code)(スキルは Claude Code のセッションから `/channel-builder` で起動)
- Node.js(factory-ui の実行に必要)

## セットアップ

### 1. スキルをインストール

このリポジトリを `~/.claude/skills/channel-builder` として配置します。

```bash
git clone https://github.com/Harapanee/channel-builder.git ~/.claude/skills/channel-builder
```

### 2. ファクトリールートを用意

チャンネル群を束ねる作業ディレクトリ(=ファクトリールート)を任意の場所に作ります。

```bash
mkdir -p ~/my-factory && cd ~/my-factory
```

このディレクトリで Claude Code を起動し `/channel-builder` を実行すると、ヒアリングを経て直下にチャンネルフォルダが構築されます。動画制作は構築されたチャンネルフォルダ内の `/video-create` が担います。詳細は `SKILL.md` と `MANUAL.md` を参照。

### 3. factory-ui を設置(任意・ブラウザUIを使う場合)

factory-ui は**自分の親フォルダをファクトリールートとみなす**ため、必ずファクトリールート直下にコピーしてください。

```bash
cp -R ~/.claude/skills/channel-builder/factory-ui ~/my-factory/factory-ui
cd ~/my-factory/factory-ui
npm install
npm start   # → http://127.0.0.1:4700
```

ポートは環境変数 `FACTORY_UI_PORT` で変更できます。

### 4. YouTube連携(任意)

UIからのYouTubeアップロードを使う場合は、Google Cloud の OAuth クライアントJSONが必要です。手順は [`factory-ui/docs/youtube-setup.md`](factory-ui/docs/youtube-setup.md) を参照(UIの設定タブからも案内されます)。

`youtube-client.json`(クライアントシークレット)はコミットしないでください(`.gitignore` 済み)。

## 更新

```bash
git -C ~/.claude/skills/channel-builder pull
```

factory-ui を更新した場合は、ファクトリールート側へ再コピーして `npm start` し直してください。
