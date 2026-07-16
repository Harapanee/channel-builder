/**
 * データ契約の TypeScript 型定義(仕様書 §5.3〜§5.7 に対応)。
 * ここで定義した形は src/schemas/*.schema.json と一致させること。
 * どちらか一方だけを更新して乖離させない。
 */

// ---- §5.6 shots.json -------------------------------------------------

export type ShotRole =
  | "hook"
  | "show"
  | "explain"
  | "contrast"
  | "foreshadow"
  | "withhold"
  | "reveal"
  | "payoff"
  | "gag"
  | "reframe";

export type ShotSfxCue = {
  cue: string;
  atSec: number;
  gainDb?: number;
};

export type Shot = {
  shotId: string;
  lineIds: string[];
  startSec: number;
  endSec: number;
  role: ShotRole;
  scene: {
    component: string;
    props: Record<string, unknown>;
  };
  assets: string[];
  sfx?: ShotSfxCue[];
  intent?: string;
};

export type ShotsFile = {
  episodeId: string;
  fps: 30;
  resolution: { w: 1920; h: 1080 } | { w: 1080; h: 1920 };
  narration: { file: string; durationSec: number };
  bgm?: { file: string; gainDb: number };
  /** 章別BGM。指定時は bgm より優先。file は assets/ 相対。区間はループ再生 */
  bgmTracks?: { file: string; startSec: number; endSec: number; gainDb: number }[];
  shots: Shot[];
};

// ---- §5.5 timing.json --------------------------------------------------

/**
 * 立ち絵の表情キー(全チャンネル共通の語彙)。
 *
 * 台本注釈 `- expression:` の許可値であり、parse-script.ts がこの集合で検証する
 * (自由文の `- delivery:` は演者向けの散文として hints に残り、コードは解釈しない。
 *  「契約に機械検証できない値を書かない」= CLAUDE.md)。
 *
 * 素材の assetId 規約は `<立ち絵接頭辞>-<expression>-<open|closed>`。
 * 表情差分を持たないチャンネルは style.ts の SPEAKER_STANDS で expressionPrefixes を
 * 宣言しなければよく、その場合は全行が既定表情(DEFAULT_EXPRESSION)で描かれる。
 */
export const EXPRESSIONS = ["normal", "smile", "surprise", "trouble"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** `- expression:` 注釈が無い行・表情素材が無いチャンネルの既定表情 */
export const DEFAULT_EXPRESSION: Expression = "normal";

export function isExpression(value: string): value is Expression {
  return (EXPRESSIONS as readonly string[]).includes(value);
}

export type PhraseTiming = {
  text: string;
  /** 字幕表示用テキスト(- display: 注釈由来)。読み(text)がひらがな開きでも字幕は漢字にできる */
  displayText?: string;
  startSec: number;
  endSec: number;
};

export type LineTiming = {
  lineId: string;
  text: string;
  /** 解決済み話者キー(例 "zundamon")。voice.json speakers 形式のTTS出力のみ */
  speaker?: string;
  /** 字幕表示用テキスト(- display: 注釈由来、行全体) */
  displayText?: string;
  /** 字幕非表示。`- subtitle: off` 注釈由来。画面内テキストと重複する行に使う */
  noSubtitle?: boolean;
  /**
   * この行を話す話者の表情(`- expression:` 注釈由来)。省略時は DEFAULT_EXPRESSION 相当。
   * 立ち絵レイヤー(SpeakerStands.tsx)が読む。表情素材の無いチャンネルでは無視される
   */
  expression?: Expression;
  startSec: number;
  endSec: number;
  phrases: PhraseTiming[];
};

export type TimingFile = {
  episodeId: string;
  totalDurationSec: number;
  lines: LineTiming[];
};

// ---- §5.7 assets/library.json ------------------------------------------

export type LibraryAssetKind =
  | "character"
  | "prop"
  | "map"
  | "background"
  | "se"
  | "bgm";

export type LibraryAssetSource =
  | "ai_image"
  | "code_generated"
  | "public_domain"
  | "licensed"
  | "user_provided";

export type LibraryAsset = {
  assetId: string;
  kind: LibraryAssetKind;
  subject: string;
  variant: string;
  file: string;
  source: LibraryAssetSource;
  license: string;
  approvedBy: string;
};

export type LibraryFile = {
  assets: LibraryAsset[];
};

// ---- §5.3 episode.json ---------------------------------------------------

export type EpisodeStatus =
  | "researched"
  | "scripted"
  | "voiced"
  | "storyboarded"
  | "implemented"
  | "qa_passed"
  | "reviewed"
  | "final";

export type EpisodeFile = {
  episodeId: string;
  subject: string;
  targetDurationSec: number;
  status: EpisodeStatus;
};
