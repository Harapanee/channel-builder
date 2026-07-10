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
  /** 字幕表示用テキスト(- display: 注釈由来、行全体) */
  displayText?: string;
  /** 字幕非表示。`- subtitle: off` 注釈由来。画面内テキストと重複する行に使う */
  noSubtitle?: boolean;
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
