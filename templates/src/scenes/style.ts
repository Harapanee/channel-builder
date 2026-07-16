/**
 * 映像スタイル契約(bible.md §8 / タスク「画風の絶対条件」)。
 *
 * オフホワイト背景 / ラフな黒手描き線 / 色は藍・赤・黄 + 黒のみ。
 * 陰影・グラデーション禁止。ここに定義した色以外を各コンポーネントで使わない。
 */
export const PALETTE = {
  /** オフホワイトの紙 */
  paper: "#F4F1E7",
  /** ラフな黒マーカー線 */
  ink: "#1B1A17",
  /** 藍(キャラ衣装・落ち着いた強調) */
  indigo: "#37416B",
  /** 赤(危険・強調) */
  red: "#C6382C",
  /** 黄(希望・光) */
  yellow: "#E7B23A",
} as const;

export type PaletteColor = keyof typeof PALETTE;

/**
 * 線の様式(全チャンネル共通の doodle-svg.ts / motion が参照するチャンネル可変の見た目)。
 *
 * - "rough": 手描き画風。シード付きジッタで頂点を歪ませ、Catmull-Rom で平滑化した
 *   ゆらぐ線を描く。常時 boiling(コマ単位の揺れ)がかかる。
 * - "clean": 均一で太い線。ジッタ・平滑化を使わず、直線セグメントと正確な円弧で
 *   幾何的に整った形を描く。boiling は「滑らかな微小ドリフト」に置き換わる
 *   (bible §8「手描き風のジッターを使わない」+ frozen_video QA 対策。motion/index.ts の
 *   boiling() を参照)。
 *
 * 既定(テンプレート)は "rough"。この値だけを差し替えれば doodle-svg.ts の
 * rough*Path 群と boiling() の全呼び出しが自動追従する(PALETTE と同じ考え方)。
 */
export type LineStyle = "rough" | "clean";
export const LINE_STYLE: LineStyle = "rough";

/**
 * 本文・見出しの書体(全チャンネル共通の use-doodle-font.ts が参照するチャンネル可変の見た目)。
 *
 * assets/fonts/ に同梱した TTF を FontFace でロードする。ライセンスは
 * assets/fonts/LICENSE.md に記録すること。
 *
 * ⚠️ family は **TTF の内部ファミリー名**を書くこと(配布サイトの表示名ではない)。
 * FontFace(name, url) に渡した name がそのまま CSS の font-family 参照名になるため、
 * ここが実物とずれるとフォールバックへ落ちる。
 * 例: M PLUS Rounded 1c の TTF の内部ファミリー名は "Rounded Mplus 1c"。
 *
 * 既定は手描き風の "Yusei Magic"(SIL OFL 1.1)。bible §8 が別の書体を定めるチャンネルでは
 * TTF を assets/fonts/ へ同梱し、ライセンスを assets/fonts/LICENSE.md に記録した上で
 * ここを差し替える(例: 太いラウンドゴシックの M PLUS Rounded 1c Black / SIL OFL 1.1)。
 */
export const DOODLE_FONT = {
  /** TTF の内部ファミリー名 = CSS 参照名 */
  family: "Yusei Magic",
  /** public/ からの相対パス(staticFile に渡す) */
  file: "assets/fonts/YuseiMagic-Regular.ttf",
  /** FontFace に登録するウェイト */
  weight: "400",
  /** ロード失敗時に落ちる先(同系統の書体を並べる) */
  fallback: `"Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif`,
} as const;

/** 手描き風の太い線幅の目安(1080p キャンバス基準の px)。 */
export const STROKE = {
  hair: 4,
  thin: 7,
  medium: 11,
  thick: 16,
} as const;

/**
 * 字幕セーフゾーン(キャンバス高さに対する割合)。
 * シーン内のテキスト・札(プラカード)類は y < 82%(= この値より上)に置くこと。
 * 字幕帯は画面のおよそ 85〜93% を占有するため、これより下に置くと字幕と重なる。
 * 使用例: `top: \`${SUBTITLE_SAFE_BOTTOM_PCT * 100 - 5}%\`` のように上限として使う。
 */
export const SUBTITLE_SAFE_BOTTOM_PCT = 0.82;

/**
 * 話者別の字幕スタイル(2話者以上の掛け合いチャンネルのみ)。
 * キーは channel/voice.json の speakers のキー(= timing.json の行の speaker)と
 * 一致させること。accent は字幕の文字色に使う。
 * このエクスポートが無いチャンネルでは字幕は従来色のまま(防御的読み込み)。
 *
 * export const SPEAKER_STYLE: Record<string, { accent: string; label: string }> = {
 *   <話者キー>: { accent: "#7EC96E", label: "<表示名>" },
 * };
 */

/**
 * 立ち絵レイヤー設定(左右下に立ち絵+口パク。掛け合いチャンネルのみ)。
 * **このエクスポートが無い既定のチャンネルでは立ち絵レイヤーは何も描画しない。**
 * 立ち絵を使うチャンネルだけ、次の形で宣言する(型は SpeakerStands.tsx が持つ):
 *
 * import type { SpeakerStandConfig } from "./shared/SpeakerStands";
 * export const SPEAKER_STANDS: Record<string, SpeakerStandConfig> = {
 *   <話者キー>: {
 *     side: "left",
 *     // library.json の assetId 接頭辞。"<prefix>-open" / "<prefix>-closed" の2枚を引く
 *     assetPrefix: "stand-<話者>-normal",
 *     // 表情差分を持つチャンネルのみ。**実際に素材がある表情だけ**を宣言する。
 *     // 省略時は全行が既定表情で描かれる(= 表情差分なしの挙動)。
 *     // 台本注釈 `- expression: normal|smile|surprise|trouble` → timing.json の行
 *     // expression → ここで assetId 接頭辞へ解決される。宣言の無い表情・
 *     // library.json 未登録の表情は assetPrefix(既定表情)へ安全に落ちる。
 *     expressionPrefixes: { smile: "stand-<話者>-smile" },
 *   },
 * };
 */

/**
 * 画面フレーム設定(全チャンネル共通の Episode.tsx が参照するチャンネル可変の見た目)。
 * 既定は従来のDoodle系挙動(帯なし・角丸字幕・紙背景)。
 * スライドショー型など別様式のチャンネルはここを書き換える
 * (例: letterboxPct: 0.12, letterboxColor: "#060504", subtitleVariant: "band",
 *  subtitleFontFamily: 明朝スタック, rootBackground: 帯色)。
 * このエクスポート自体を消しても Episode.tsx は既定値で動く(防御的読み込み)。
 */
export const FRAME_STYLE = {
  /** 上下黒帯の高さ(キャンバス高さ比)。0で帯なし */
  letterboxPct: 0,
  /** 横型字幕の様式: "rounded"=角丸ボックス / "band"=下帯内の帯文字 */
  subtitleVariant: "rounded",
} as const;
