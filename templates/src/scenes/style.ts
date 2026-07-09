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
