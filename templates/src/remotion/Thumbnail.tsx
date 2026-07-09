import React from "react";
import {
  AbsoluteFill,
  Freeze,
  staticFile,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { AssetProvider } from "../scenes/asset-context";
import { CUSTOM_COMPONENT_PREFIX, resolveComponent } from "../scenes/registry";
import { DoodleCharacter } from "../scenes/core/DoodleCharacter";
import { DOODLE_FONT_STACK, useDoodleFont } from "../scenes/use-doodle-font";
import { PALETTE, type PaletteColor } from "../scenes/style";
import { seedFrom, seededRange } from "../motion/noise";
import { roughArrow, roughCirclePath, roughLinePath } from "../scenes/doodle-svg";
import type { LibraryFile } from "../schemas/types";

/**
 * §13 Thumbnail — 動画ごとのサムネ3案を Remotion で静止画生成する。
 *
 * 1280x720 / durationInFrames=1 / 30fps の静止コンポジション。
 * publisher エージェントが書く `<episodeDir>/publish/thumbnails.json`(契約は
 * .claude/agents/publisher.md)を calculateMetadata で読み、`variant`(1|2|3)に
 * 対応する案を描画する。
 *
 * 動画本編(Episode.tsx)と同じ「AI画像でなく既存素材+手描きフォント」方針で、
 * 画風が自動的にチャンネルへ揃う。アニメーションは持たず、手描き感は
 * シード付きジッタ(frame に依らない静的な歪み)で表現する。
 */

// ---- thumbnails.json の契約型(publisher.md 準拠)------------------------

/** "paper" / パレット名 / 任意の #hex */
type ThumbBackground = "paper" | PaletteColor | string;

type ThumbCharacter = {
  /** library.json の承認済み透過PNG assetId */
  assetId: string;
  /** 画像中心の水平位置(キャンバス幅に対する %)。§13の固定構造は中央。既定 50 */
  xPct?: number;
  /** 画像中心の垂直位置(キャンバス高さに対する %)。既定 56 */
  yPct?: number;
  /** 画像の高さ(キャンバス高さに対する %)。既定 90 */
  heightPct?: number;
  /** 左右反転 */
  flip?: boolean;
};

type ThumbLine = {
  /** 1行8文字以内(スマホ可読性、publisher.md)。1案あたり合計3語以内 */
  text: string;
  /** 文字サイズ(キャンバス高さに対する %) */
  sizePct: number;
  /** パレット名のみ(ink / red / indigo / yellow / paper) */
  color: PaletteColor;
  /** テキスト中心の水平位置(%) */
  xPct: number;
  /** テキスト中心の垂直位置(%) */
  yPct: number;
  /** 傾き(度)。手描き感の演出 */
  rotateDeg?: number;
};

/**
 * 動画内の実シーンをサムネ背景として1フレーム描画する。
 * §13「動画内の実素材を使う」の最上位の形 — サムネ専用の簡略絵ではなく、
 * 本編に実在する画(群衆・ベッド・地図など)をそのまま見せる。
 *
 * component は src/scenes/registry.ts の既存解決(shots.json と同じ規約)に従う:
 * コアは素の名前("DoodleCharacter" 等)、エピソード固有は "custom:<Name>"。
 * "custom:" を省いた <Name> 単独でも customRegistry から解決される(利便のため)。
 * props はそのシーンコンポーネントへそのまま渡す(shots.json の scene.props と同形)。
 * frame は静止させる本編フレーム(既定 0)。出現アニメが出揃った後の
 * フレームを指定する(Freeze で固定描画するため任意フレームを選べる)。
 */
type ThumbScene = {
  component: string;
  props?: Record<string, unknown>;
  frame?: number;
};

type ThumbAccent =
  | {
      /**
       * §13の固定構造の主役アクセント。主人公を指す手描きの矢印。
       * from=一言(根本)の近く → to=主人公の体の縁(矢じり)。顔には被せない。
       */
      type: "arrow";
      /** 根本(一言側)の水平位置(%) */
      fromXPct: number;
      /** 根本(一言側)の垂直位置(%) */
      fromYPct: number;
      /** 矢じり(主人公の体の縁)の水平位置(%) */
      toXPct: number;
      /** 矢じり(主人公の体の縁)の垂直位置(%) */
      toYPct: number;
      /** パレット名。既定 red */
      color?: PaletteColor;
    }
  | {
      type: "burst";
      xPct: number;
      yPct: number;
      color?: PaletteColor;
      radiusPct?: number;
    }
  | {
      type: "dangerCircle";
      xPct: number;
      yPct: number;
      radiusPct?: number;
      color?: PaletteColor;
    }
  | {
      type: "underline";
      xPct: number;
      yPct: number;
      widthPct?: number;
      color?: PaletteColor;
    }
  | {
      type: "vs";
      xPct?: number;
      yPct?: number;
      color?: PaletteColor;
    };

export type ThumbVariant = {
  /**
   * "1" | "2" | "3"。§13の固定構造(中央主人公+手描き矢印+最悪の一言)を保ち、
   * 「一言の切り口(状況/数字/皮肉)× 主人公の表情バリアント」で3案を作り分ける。
   */
  id: string;
  strategy?: string;
  background?: ThumbBackground;
  /**
   * 動画内の実シーンを背景として静止描画する(ThumbScene のJSDoc参照)。
   * 描画順は background → scene → character → accents → lines。
   * シーン内に主人公が含まれる場合、重複する character は省略する。
   * 省略時は従来どおり(後方互換: 既存の thumbnails.json はそのまま動く)。
   */
  scene?: ThumbScene;
  /** 文字主体の案では省略可(publisher.md)。 */
  character?: ThumbCharacter;
  lines?: ThumbLine[];
  accents?: ThumbAccent[];
};

export type ThumbnailsFile = {
  episodeId: string;
  variants: ThumbVariant[];
};

// ---- props --------------------------------------------------------------

export type ThumbnailProps = {
  /** プロジェクトルートからの相対パス。例: "episodes/ep000-test" */
  episodeDir: string;
  /** 描画する案。1 | 2 | 3(thumbnails.json の variants[].id と対応) */
  variant: number;
  /** calculateMetadata が読み込んで注入する */
  spec?: ThumbVariant;
  library?: LibraryFile;
};

// ---- staticFile 経由の読み込み(Episode.tsx と同じ流儀)------------------

function thumbnailAssetUrl(episodeDir: string, ...segments: string[]): string {
  const rel = [episodeDir, ...segments].join("/").replace(/\\/g, "/");
  return staticFile(rel);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const calculateThumbnailMetadata: CalculateMetadataFunction<
  ThumbnailProps
> = async ({ props }) => {
  const { episodeDir, variant } = props;

  const [thumbs, library] = await Promise.all([
    fetchJson<ThumbnailsFile>(
      thumbnailAssetUrl(episodeDir, "publish", "thumbnails.json")
    ),
    fetchJson<LibraryFile>(staticFile("assets/library.json")),
  ]);

  const wanted = String(variant);
  const spec =
    thumbs.variants.find((v) => v.id === wanted) ?? thumbs.variants[0];

  // scene.frame を使う案では、コンポジション長をそのフレームが収まる長さに
  // 伸ばす(Remotion は useCurrentFrame を durationInFrames-1 でクランプする
  // ため、長さ1のままだと Freeze の指定フレームが 0 に丸められる)。
  // レンダリングは従来どおり frame 0 の静止画1枚(render-thumbs.ts)。
  const sceneFrame = Math.max(0, Math.floor(spec?.scene?.frame ?? 0));

  return {
    // 静止画: 1フレーム(scene 使用時のみ Freeze 用に長さを確保)。1280x720 固定。
    durationInFrames: sceneFrame + 1,
    fps: 30,
    width: 1280,
    height: 720,
    props: {
      ...props,
      spec,
      library,
    },
  };
};

// ---- 色解決 --------------------------------------------------------------

function isPaletteColor(name: string): name is PaletteColor {
  return Object.prototype.hasOwnProperty.call(PALETTE, name);
}

function resolveBackground(bg: ThumbBackground | undefined): string {
  if (!bg || bg === "paper") return PALETTE.paper;
  if (bg.startsWith("#")) return bg;
  if (isPaletteColor(bg)) return PALETTE[bg];
  return PALETTE.paper;
}

// ---- 太縁取りテキスト -----------------------------------------------------
// 素材(キャラ)に重なっても読めるよう、同一テキストを3層重ねる:
//   1) 黒(ink)の太いストローク層 → いちばん外の輪郭
//   2) 白(paper)のストローク層  → 黒と塗りの間の白リング
//   3) パレット色の塗り層        → 文字本体
// paint-order: stroke でストロークを塗りの背面に置き、字面を痩せさせない。

export interface CalloutLayout {
  fontSize: number;
  xPct: number;
  yPct: number;
  halfWPct: number;
  halfHPct: number;
  side: "left" | "right";
}

/**
 * 一言(callout)の自動レイアウト。§13の固定構造(主人公=中央)を前提に:
 *  1) まず顔帯(x40〜62)の外側=左右どちらかのサイドに、できるだけ大きく置く
 *     (指定サイズの72%まで縮小を許容してサイドに収める)
 *  2) サイドに収まらない幅広テキストだけ、頭上の帯(y≦18%)へ縮小して逃がす
 * 矢印の自動アンカー(本体側)もこの結果を共有する。
 */
export function layoutCallout(
  line: ThumbLine,
  canvasW: number,
  canvasH: number
): CalloutLayout {
  const emUnits =
    Array.from(line.text).reduce(
      (w, ch) => w + (/[ -ÿ]/.test(ch) ? 0.55 : 1.0),
      0
    ) * 1.04;
  const rawSize = (line.sizePct / 100) * canvasH;
  const side: "left" | "right" = line.xPct < 50 ? "left" : "right";
  const sideWidthPct = side === "left" ? 38 : 36; // 顔帯(40〜62)の外側の幅
  const sideFit = (canvasW * (sideWidthPct / 100)) / Math.max(1, emUnits);

  if (sideFit >= rawSize * 0.72) {
    const fontSize = Math.min(rawSize, sideFit);
    const halfWPct = ((emUnits * fontSize) / 2 / canvasW) * 100 + 1;
    const halfHPct = ((fontSize / canvasH) * 100) / 2 + 1;
    const xMin = side === "left" ? halfWPct + 1 : 62 + halfWPct;
    const xMax = side === "left" ? 40 - halfWPct : 99 - halfWPct;
    const xPct = Math.min(Math.max(line.xPct, xMin), Math.max(xMin, xMax));
    const yPct = Math.min(Math.max(line.yPct, halfHPct + 2), 60);
    return { fontSize, xPct, yPct, halfWPct, halfHPct, side };
  }
  const fontSize = Math.min(
    rawSize,
    canvasH * 0.13,
    (canvasW * 0.94) / Math.max(1, emUnits)
  );
  const halfWPct = ((emUnits * fontSize) / 2 / canvasW) * 100 + 1;
  const halfHPct = ((fontSize / canvasH) * 100) / 2 + 1;
  const xPct = Math.min(Math.max(line.xPct, halfWPct + 1), 99 - halfWPct);
  const yPct = Math.max(Math.min(line.yPct, 18 - halfHPct), halfHPct + 2);
  return { fontSize, xPct, yPct, halfWPct, halfHPct, side };
}

const ThumbText: React.FC<{ line: ThumbLine; font: string; canvasH: number }> = ({
  line,
  font,
  canvasH,
}) => {
  const { width: canvasW } = useVideoConfig();
  const layout = layoutCallout(line, canvasW, canvasH);
  const fontSize = layout.fontSize;
  const clampedXPct = layout.xPct;
  const clampedYPct = layout.yPct;
  const fill = PALETTE[line.color] ?? PALETTE.ink;
  const outerW = fontSize * 0.18; // 黒輪郭
  const innerW = fontSize * 0.1; // 白リング
  const seed = seedFrom("thumbtext", line.text, line.xPct, line.yPct);
  // 手描き感の静的な微傾き(±1.2度)
  const jitter = seededRange(seed, 1, -1.2, 1.2);

  const typography: React.CSSProperties = {
    margin: 0,
    padding: 0,
    fontFamily: font,
    fontSize,
    lineHeight: 1,
    fontWeight: 400,
    whiteSpace: "nowrap",
    letterSpacing: "0.02em",
  };

  const strokeLayer = (
    color: string,
    strokeColor: string,
    strokeW: number
  ): React.CSSProperties => ({
    ...typography,
    position: "absolute",
    left: 0,
    top: 0,
    color,
    WebkitTextStrokeWidth: `${strokeW}px`,
    WebkitTextStrokeColor: strokeColor,
    // csstype に paintOrder が無い環境向けにキャスト経由で付与
    ...({ paintOrder: "stroke" } as React.CSSProperties),
  });

  return (
    <div
      style={{
        position: "absolute",
        left: `${clampedXPct}%`,
        top: `${clampedYPct}%`,
        transform: `translate(-50%, -50%) rotate(${(line.rotateDeg ?? 0) + jitter}deg)`,
      }}
    >
      <div
        style={{
          position: "relative",
          // 黒輪郭のさらに外に薄い影を敷いて、明るい素材上でも縁を立たせる
          filter: `drop-shadow(0 ${fontSize * 0.03}px 0 rgba(27,26,23,0.35))`,
        }}
      >
        {/* 寸法確定用のスペーサ(不可視・inフロー) */}
        <span style={{ ...typography, visibility: "hidden" }}>{line.text}</span>
        {/* 1) 黒の太い輪郭 */}
        <span style={strokeLayer(PALETTE.ink, PALETTE.ink, outerW)}>
          {line.text}
        </span>
        {/* 2) 白のリング */}
        <span style={strokeLayer(PALETTE.paper, PALETTE.paper, innerW)}>
          {line.text}
        </span>
        {/* 3) パレット色の塗り */}
        <span style={{ ...typography, position: "absolute", left: 0, top: 0, color: fill }}>
          {line.text}
        </span>
      </div>
    </div>
  );
};

// ---- アクセント -----------------------------------------------------------

/** 黄色の放射(DoodleCharacter の halo 様式を静止に固めたもの)。 */
const BurstAccent: React.FC<{
  a: Extract<ThumbAccent, { type: "burst" }>;
  width: number;
  height: number;
}> = ({ a, width, height }) => {
  const cx = (a.xPct / 100) * width;
  const cy = (a.yPct / 100) * height;
  const rMax = ((a.radiusPct ?? 30) / 100) * height;
  const color = PALETTE[a.color ?? "yellow"];
  const seed = seedFrom("burst", a.xPct, a.yPct);
  const spin = seededRange(seed, 0, 0, (Math.PI * 2) / 16); // 静的な回転オフセット
  const rays = 16;
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < rays; i++) {
    const ang = (i / rays) * Math.PI * 2 + spin;
    const long = i % 2 === 0;
    const len = long ? rMax : rMax * 0.66;
    const halfW = (long ? 0.11 : 0.07) * Math.PI;
    const inner = rMax * 0.12;
    const p0x = cx + Math.cos(ang) * len;
    const p0y = cy + Math.sin(ang) * len;
    const p1x = cx + Math.cos(ang - halfW) * inner;
    const p1y = cy + Math.sin(ang - halfW) * inner;
    const p2x = cx + Math.cos(ang + halfW) * inner;
    const p2y = cy + Math.sin(ang + halfW) * inner;
    nodes.push(
      <path
        key={i}
        d={`M ${p0x.toFixed(1)} ${p0y.toFixed(1)} L ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)} Z`}
        fill={color}
        opacity={long ? 0.92 : 0.62}
      />
    );
  }
  return (
    <AbsoluteFill>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <circle cx={cx} cy={cy} r={rMax * 0.14} fill={color} opacity={0.9} />
        {nodes}
      </svg>
    </AbsoluteFill>
  );
};

/**
 * §13の固定構造の主役アクセント。主人公を指す手描きの矢印。
 * わずかにカーブしたシャフト(roughArrow のジッタ流儀)+ 太い三角の矢じり。
 * from=一言の根本 → to=主人公の体の縁。矢じり側(to)が先端。既存アクセントと
 * 同じ seedFrom による決定論(同じ座標なら常に同じ歪み)。
 */
const ArrowAccent: React.FC<{
  a: Extract<ThumbAccent, { type: "arrow" }>;
  width: number;
  height: number;
}> = ({ a, width, height }) => {
  const x1 = (a.fromXPct / 100) * width;
  const y1 = (a.fromYPct / 100) * height;
  const x2 = (a.toXPct / 100) * width;
  const y2 = (a.toYPct / 100) * height;
  const stroke = PALETTE[a.color ?? "red"];
  const seed = seedFrom(
    "thumb-arrow",
    a.fromXPct,
    a.fromYPct,
    a.toXPct,
    a.toYPct
  );

  // 直線方向(from→to)。矢じりの向きとシャフト末端の後退量に使う。
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy; // 進行方向に対して垂直
  const ny = ux;

  // 極太マーカー(720p基準で ~14px、12〜16px相当)。
  const strokeW = Math.max(12, height * 0.02);
  // 太い三角の矢じり(先端〜底辺の長さ・底辺の半幅)。
  const headLen = Math.max(30, height * 0.075);
  const headHalf = headLen * 0.62;

  // シャフトは矢じりの底のやや内側で止め、丸端を三角で覆う。
  const shaftEndX = x2 - ux * headLen * 0.72;
  const shaftEndY = y2 - uy * headLen * 0.72;
  // わずかにカーブしたシャフト(head は自前で描くため shaft のみ使う)。
  const { shaft } = roughArrow(x1, y1, shaftEndX, shaftEndY, seed, 0, 0.1);

  // 三角の矢じり: tip=to、底辺は進行方向の後方へ。
  const bx = x2 - ux * headLen;
  const by = y2 - uy * headLen;
  const c1x = bx + nx * headHalf;
  const c1y = by + ny * headHalf;
  const c2x = bx - nx * headHalf;
  const c2y = by - ny * headHalf;
  const headPath = `M ${x2.toFixed(1)} ${y2.toFixed(1)} L ${c1x.toFixed(1)} ${c1y.toFixed(1)} L ${c2x.toFixed(1)} ${c2y.toFixed(1)} Z`;

  return (
    <AbsoluteFill>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{
          // 明るい紙にもキャラ上にも縁が立つよう、わずかな影を敷く。
          filter: `drop-shadow(0 ${(strokeW * 0.22).toFixed(1)}px 0 rgba(27,26,23,0.28))`,
        }}
      >
        <path
          d={shaft}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={headPath}
          fill={stroke}
          stroke={stroke}
          strokeWidth={strokeW * 0.5}
          strokeLinejoin="round"
        />
      </svg>
    </AbsoluteFill>
  );
};

/** 赤の手描き円(既存 doodle-svg の roughCirclePath を静止描画)。 */
const DangerCircleAccent: React.FC<{
  a: Extract<ThumbAccent, { type: "dangerCircle" }>;
  width: number;
  height: number;
}> = ({ a, width, height }) => {
  const cx = (a.xPct / 100) * width;
  const cy = (a.yPct / 100) * height;
  const r = ((a.radiusPct ?? 26) / 100) * height;
  const stroke = PALETTE[a.color ?? "red"];
  const seed = seedFrom("thumb-danger", a.xPct, a.yPct, a.radiusPct ?? 26);
  const path = roughCirclePath(cx, cy, r, seed, 0.05);
  return (
    <AbsoluteFill>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={Math.max(10, r * 0.11)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </AbsoluteFill>
  );
};

/** 手描きの下線(roughLinePath)。 */
const UnderlineAccent: React.FC<{
  a: Extract<ThumbAccent, { type: "underline" }>;
  width: number;
  height: number;
}> = ({ a, width, height }) => {
  const cx = (a.xPct / 100) * width;
  const cy = (a.yPct / 100) * height;
  const w = ((a.widthPct ?? 26) / 100) * width;
  const stroke = PALETTE[a.color ?? "red"];
  const seed = seedFrom("thumb-underline", a.xPct, a.yPct);
  const path = roughLinePath(cx - w / 2, cy, cx + w / 2, cy, seed, 6, 8);
  return (
    <AbsoluteFill>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={Math.max(10, height * 0.018)}
          strokeLinecap="round"
        />
      </svg>
    </AbsoluteFill>
  );
};

/** 中央の手描き仕切り + 「vs」文字。数字・対比押し案の見せ場。 */
const VsAccent: React.FC<{
  a: Extract<ThumbAccent, { type: "vs" }>;
  width: number;
  height: number;
  font: string;
}> = ({ a, width, height, font }) => {
  const cx = ((a.xPct ?? 50) / 100) * width;
  const cy = ((a.yPct ?? 50) / 100) * height;
  const color = PALETTE[a.color ?? "ink"];
  const seed = seedFrom("thumb-vs", a.xPct ?? 50, a.yPct ?? 50);
  const half = height * 0.34;
  const divider = roughLinePath(cx, cy - half, cx, cy + half, seed, 7, 8);
  const badgeR = height * 0.11;
  const vsSize = height * 0.13;
  const vsTypo: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    margin: 0,
    fontFamily: font,
    fontSize: vsSize,
    lineHeight: 1,
    fontWeight: 400,
  };
  return (
    <AbsoluteFill>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <path
          d={divider}
          fill="none"
          stroke={color}
          strokeWidth={Math.max(10, height * 0.016)}
          strokeLinecap="round"
        />
        <circle
          cx={cx}
          cy={cy}
          r={badgeR}
          fill={PALETTE.paper}
          stroke={PALETTE.ink}
          strokeWidth={Math.max(8, height * 0.012)}
        />
      </svg>
      {/* 「vs」文字を白バッジの上に太縁取りで置く */}
      <div
        style={{
          position: "absolute",
          left: cx,
          top: cy,
          transform: "translate(-50%, -50%)",
        }}
      >
        <div style={{ position: "relative" }}>
          <span style={{ ...vsTypo, visibility: "hidden" }}>vs</span>
          <span
            style={{
              ...vsTypo,
              color: PALETTE.red,
              WebkitTextStrokeWidth: `${vsSize * 0.12}px`,
              WebkitTextStrokeColor: PALETTE.ink,
              ...({ paintOrder: "stroke" } as React.CSSProperties),
            }}
          >
            vs
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---- 動画内シーンの静止描画 -----------------------------------------------

/**
 * 動画内の実シーンをサムネ背景として1フレーム描画する層。
 * registry の既存解決(shots.json と同じ)でコンポーネントを引き、
 * Remotion の Freeze で指定フレームに固定する(useCurrentFrame に依存する
 * シーンでも、出現アニメ完了後などの任意フレームを静止画として見せられる)。
 */
const SceneLayer: React.FC<{ scene: ThumbScene }> = ({ scene }) => {
  const Comp =
    resolveComponent(scene.component) ??
    // 利便: "custom:" を省いた <Name> 単独指定も customRegistry から解決する
    resolveComponent(`${CUSTOM_COMPONENT_PREFIX}${scene.component}`);
  if (!Comp) {
    // 契約違反はレンダリングを止めて明示する(render-thumbs が失敗として報告)
    throw new Error(
      `thumbnails.json: scene.component "${scene.component}" が src/scenes/registry.ts で解決できません`
    );
  }
  return (
    <AbsoluteFill>
      <Freeze frame={scene.frame ?? 0}>
        <Comp {...(scene.props ?? {})} />
      </Freeze>
    </AbsoluteFill>
  );
};

// ---- 本体 ----------------------------------------------------------------

export const Thumbnail: React.FC<ThumbnailProps> = ({
  episodeDir,
  variant,
  spec,
  library,
}) => {
  const { width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  if (!spec || !library) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "black",
          color: "white",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 28,
          fontFamily: "sans-serif",
          textAlign: "center",
          padding: 40,
        }}
      >
        publish/thumbnails.json / library.json が読み込めませんでした({episodeDir}
        / variant {variant})
      </AbsoluteFill>
    );
  }

  const bg = resolveBackground(spec.background);
  const accents = spec.accents ?? [];
  const bursts = accents.filter(
    (a): a is Extract<ThumbAccent, { type: "burst" }> => a.type === "burst"
  );

  // 矢印の自動アンカー(§13固定構造): 一言とキャラの両方があるとき、
  // 矢印を「一言の下端(キャラ側の端)→ キャラの胴の縁」へ自動接続する。
  // 一言の自動レイアウト(顔帯回避)に矢印が追従し、顔に被らない。
  const firstLine = (spec.lines ?? [])[0];
  const autoAnchor =
    firstLine && spec.character
      ? (() => {
          const l = layoutCallout(firstLine, width, height);
          const charX = spec.character.xPct ?? 50;
          const charY = spec.character.yPct ?? 56;
          return {
            fromXPct:
              l.side === "left"
                ? l.xPct + l.halfWPct * 0.5
                : l.xPct - l.halfWPct * 0.5,
            fromYPct: l.yPct + l.halfHPct + 1,
            toXPct: charX + (l.side === "left" ? -7 : 7),
            toYPct: charY + 1,
          };
        })()
      : null;
  let anchorUsed = false;
  const frontAccents = accents
    .filter((a) => a.type !== "burst")
    // 自動アンカー時、旧テキスト座標に紐づく下線は省略する(位置が追従しないため)
    .filter((a) => !(autoAnchor && a.type === "underline"))
    .map((a) => {
      if (a.type === "arrow" && autoAnchor && !anchorUsed) {
        anchorUsed = true;
        return { ...a, ...autoAnchor };
      }
      return a;
    });

  return (
    <AssetProvider library={library}>
      <AbsoluteFill style={{ backgroundColor: bg, overflow: "hidden" }}>
        {/* 動画内シーン(背景の直上・他要素の背面): §13「動画内の実素材を使う」 */}
        {spec.scene ? <SceneLayer scene={spec.scene} /> : null}

        {/* 背面: 放射(halo 様式) */}
        {bursts.map((a, i) => (
          <BurstAccent key={`burst-${i}`} a={a} width={width} height={height} />
        ))}

        {/* キャラクター(透過PNG) */}
        {spec.character ? (
          <DoodleCharacter
            assetId={spec.character.assetId}
            xPct={spec.character.xPct ?? 50}
            yPct={spec.character.yPct ?? 56}
            heightPct={spec.character.heightPct ?? 90}
            flip={spec.character.flip ?? false}
            entrance="none"
            motion="none"
          />
        ) : null}

        {/* 前面アクセント(矢印・円・下線・vs) */}
        {frontAccents.map((a, i) => {
          if (a.type === "arrow") {
            return (
              <ArrowAccent
                key={`acc-${i}`}
                a={a}
                width={width}
                height={height}
              />
            );
          }
          if (a.type === "dangerCircle") {
            return (
              <DangerCircleAccent
                key={`acc-${i}`}
                a={a}
                width={width}
                height={height}
              />
            );
          }
          if (a.type === "underline") {
            return (
              <UnderlineAccent
                key={`acc-${i}`}
                a={a}
                width={width}
                height={height}
              />
            );
          }
          if (a.type === "vs") {
            return (
              <VsAccent
                key={`acc-${i}`}
                a={a}
                width={width}
                height={height}
                font={font}
              />
            );
          }
          return null;
        })}

        {/* 文字(最前面) */}
        {(spec.lines ?? []).map((line, i) => (
          <ThumbText key={`line-${i}`} line={line} font={font} canvasH={height} />
        ))}
      </AbsoluteFill>
    </AssetProvider>
  );
};
