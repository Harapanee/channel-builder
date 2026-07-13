import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { popIn, seedFrom, shake } from "../../motion";
import { roughClosedPath, roughLinePath } from "../doodle-svg";
import { PALETTE } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";
import { DoodleCharacter } from "../core/DoodleCharacter";

/**
 * 共有スパイン(汎用: 「掲げられた肩書き/評価が章ごとに剥がれ・書き換わる」演出)。
 * 中央にキャラクターの肖像、周囲に最大 5 枚の木札(藍の看板・白文字)を吊るす。
 *
 * 各章が 1 枚ずつ外す/書き換える構成を想定するコンポーネント。具体的な札の
 * 内容・除去順・除去タイミングは呼び出し側(storyboard / shots.json)で規定する。
 * priorRemoved[] で「既に外れた札」を外れたまま保持するので、各章は自分の
 * remove/downgrade を積むだけでよい(累積状態は priorRemoved が運ぶ契約)。
 *
 * props 契約: mode / removeIndex / priorRemoved / downgradeText / boards /
 * charAssetId / strippedLabel は固定。
 * 表示用の任意 props(appearFrames / removeFrame / fallFrame / showPortrait /
 * keepStruckBoards)は既定値ありの非破壊追加(ThreeFaces と同じ運用)。
 */
export type LegendBoardProps = {
  /** intro=五札掲示 / remove=1枚を外し落とす / downgrade=1枚を書換 / stripped=全札なし・等身大 */
  mode: "intro" | "remove" | "downgrade" | "stripped";
  /** remove/downgrade で対象になる札(0〜4のインデックス) */
  removeIndex?: 0 | 1 | 2 | 3 | 4;
  /** 既に外れている札(外れたまま=取り消し線の残骸として薄く保持) */
  priorRemoved?: number[];
  /** downgrade(index=3)で札に書き直す文字。例「保証人」「仲介者のひとり」 */
  downgradeText?: string;
  /** 五札のラベル。既定 ["項目1","項目2","項目3","項目4","項目5"](呼び出し側で必ず上書きすること) */
  boards?: [string, string, string, string, string];
  /** 中央の肖像(library の assetId)。stripped で等身大があらわになる */
  charAssetId?: string;
  /** stripped 時に肖像の下に残す実像の一言(例「規格外の、等身大」) */
  strippedLabel?: string;
  /** intro の各札の出現フレーム(スタッガー)。既定 [0,10,20,30,40] */
  appearFrames?: number[];
  /** remove/downgrade で対象札が動き始めるフレーム。既定 12 */
  removeFrame?: number;
  /** stripped で全札が落ち始めるフレーム。既定 8 */
  fallFrame?: number;
  /** 中央肖像を描くか。既定 true */
  showPortrait?: boolean;
  /**
   * stripped で「札を落とさず取り消し線を掛けたまま」保持する。既定 false。
   * 終章 L158–159(全札に取り消し線)は true、L174(等身大)は false で二拍に分ける。
   */
  keepStruckBoards?: boolean;
};

const DEFAULT_BOARDS: [string, string, string, string, string] = [
  "項目1",
  "項目2",
  "項目3",
  "項目4",
  "項目5",
];

/** 五札の配置(キャンバス幅/高さに対する中心比率)。中央肖像を囲む輪。 */
const BOARD_POS = [
  { xf: 0.205, yf: 0.30 }, // 0 左上
  { xf: 0.16, yf: 0.605 }, // 1 左下
  { xf: 0.5, yf: 0.155 }, // 2 上
  { xf: 0.795, yf: 0.30 }, // 3 右上
  { xf: 0.84, yf: 0.605 }, // 4 右下
];

/** 直線の辺を細分して手描きの矩形(角の立った箱)を作る。 */
function subdivide(
  corners: Array<[number, number]>,
  step: number
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < corners.length; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  return out;
}

export const LegendBoard: React.FC<LegendBoardProps> = ({
  mode,
  removeIndex,
  priorRemoved = [],
  downgradeText,
  boards = DEFAULT_BOARDS,
  charAssetId,
  strippedLabel,
  appearFrames = [0, 10, 20, 30, 40],
  removeFrame = 12,
  fallFrame = 8,
  showPortrait = true,
  keepStruckBoards = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  const bw = 0.19 * width; // 札の幅
  const bh = 0.088 * height; // 札の高さ

  // 看板を吊る中央の環(肖像の頭上あたり)。ここから各札へ紐が伸びる。
  const ringX = 0.5 * width;
  const ringY = 0.325 * height;

  // ---- 中央の肖像(stripped で等身大があらわに)------------------------
  const stripped = mode === "stripped";
  const portraitHeightPct = stripped && !keepStruckBoards ? 60 : 44;
  const portraitYPct =
    stripped && !keepStruckBoards
      ? interpolate(frame, [fallFrame + 6, fallFrame + 30], [58, 55], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 58;
  const portraitOpacity =
    stripped && !keepStruckBoards
      ? interpolate(frame, [fallFrame + 4, fallFrame + 24], [0.55, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0.92;

  const boardNodes: React.ReactNode[] = [];
  const labelNodes: React.ReactNode[] = [];

  for (let i = 0; i < 5; i++) {
    const pos = BOARD_POS[i];
    const cx = pos.xf * width;
    const cy = pos.yf * height;
    const seed = seedFrom("legend-board", i);

    const isPrior = priorRemoved.includes(i);
    const isFocus =
      (mode === "remove" || mode === "downgrade") && removeIndex === i;
    const isDrop = stripped && !keepStruckBoards;
    const isStruck = stripped && keepStruckBoards;

    // --- 出現 / 変形 ---
    let tx = 0;
    let ty = 0;
    let rot = 0;
    let scale = 1;
    let opacity = 1;
    // struck = 赤い取り消し線を掛ける / gone = 描かない(落下済み)
    let struck = false;

    if (isPrior) {
      // 既に外れた札: 薄い残骸(取り消し線つき・その場に薄く残す)
      opacity = 0.18;
      rot = i % 2 === 0 ? -3 : 3;
      struck = true;
    } else if (mode === "intro") {
      const p = popIn(frame, fps, { delayFrames: appearFrames[i] ?? i * 10 });
      scale = p.scale;
      opacity = p.opacity;
    } else if (isStruck) {
      // 終章 前半: 全札に取り消し線を掛けたまま(落とさない)
      const p = interpolate(frame, [fallFrame + i * 3, fallFrame + i * 3 + 14], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      struck = p > 0.55;
      rot = (i % 2 === 0 ? -1 : 1) * 2;
    } else if (isDrop) {
      // 終章 後半: 全札が順に外れ落ちて等身大の実像が残る
      const local = frame - fallFrame - i * 3;
      if (local > 0) {
        ty = interpolate(local, [0, 30], [0, 0.7 * height], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        rot = (i % 2 === 0 ? -1 : 1) * local * 1.1;
        opacity = interpolate(local, [4, 26], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
      }
    } else if (isFocus && mode === "remove") {
      // この章で外す札: 紐が切れて回転しながら落ちる
      const local = frame - removeFrame;
      if (local > 0) {
        ty = interpolate(local, [0, 30], [0, 0.72 * height], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        tx = interpolate(local, [0, 30], [0, (i < 2 ? -1 : 1) * 0.06 * width], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        rot = (i < 2 ? -1 : 1) * local * 1.4;
        opacity = interpolate(local, [8, 30], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
      } else {
        // 切れる直前の震え
        const sh = shake(Math.max(0, frame - removeFrame + 8), fps, {
          seed,
          intensityPx: 6,
          rotDeg: 1.2,
          hz: 20,
          decayFrames: 10,
        });
        tx = sh.x;
        ty = sh.y;
        rot = sh.rotate;
      }
    } else if (isFocus && mode === "downgrade") {
      // この章で書き換える札: 落とさず、震えてから文字が書き換わる
      const sh = shake(Math.max(0, frame - removeFrame), fps, {
        seed,
        intensityPx: 7,
        rotDeg: 1.4,
        hz: 18,
        decayFrames: 14,
      });
      tx = sh.x;
      ty = sh.y;
      rot = sh.rotate;
    }

    // 対象札の「切れる/書き換わる」瞬間の赤フラッシュ
    const flash =
      isFocus && !isPrior
        ? interpolate(
            frame,
            [removeFrame - 1, removeFrame + 2, removeFrame + 14],
            [0, 0.5, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          )
        : 0;

    // downgrade の書き換え進行(0=旧ラベル / 1=新ラベル)
    const downgraded =
      isFocus && mode === "downgrade"
        ? interpolate(frame, [removeFrame + 6, removeFrame + 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        : 0;

    // 落下しきった/落下済みの札は描かない
    const gone = opacity <= 0.01;

    // --- 紐(環 → 札の上端)---
    const cordTopX = cx;
    const cordTopY = cy - bh / 2 - 4;
    const cordSnapped = (isFocus && mode === "remove") || isDrop || isPrior;
    const cordProgress =
      mode === "intro"
        ? popIn(frame, fps, { delayFrames: appearFrames[i] ?? i * 10 }).opacity
        : 1;
    const cordOpacity = cordSnapped
      ? mode === "remove" && isFocus
        ? interpolate(frame, [removeFrame - 2, removeFrame + 2], [0.6, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        : isPrior
          ? 0.12
          : interpolate(frame, [fallFrame - 2, fallFrame + 2], [0.6, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
      : 0.6 * cordProgress;

    // --- 札のパス(手描きの箱)---
    const corners: Array<[number, number]> = [
      [-bw / 2, -bh / 2],
      [bw / 2, -bh / 2],
      [bw / 2, bh / 2],
      [-bw / 2, bh / 2],
    ];
    const plaquePath = roughClosedPath(subdivide(corners, 46), seed, 4);
    // 取り消し線(札を横断する赤い二重線)
    const strikeY = 0;
    const strike1 = roughLinePath(-bw / 2 + 10, strikeY - 6, bw / 2 - 10, strikeY - 2, seed ^ 0x31, 3, 6);
    const strike2 = roughLinePath(-bw / 2 + 10, strikeY + 8, bw / 2 - 10, strikeY + 4, seed ^ 0x32, 3, 6);

    if (!gone) {
      boardNodes.push(
        <g key={`cord-${i}`} opacity={cordOpacity}>
          <path
            d={roughLinePath(ringX, ringY, cordTopX, cordTopY, seed ^ 0x77, 3, 6)}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth={5}
            strokeLinecap="round"
          />
        </g>
      );
      boardNodes.push(
        <g
          key={`board-${i}`}
          transform={`translate(${cx + tx}, ${cy + ty}) rotate(${rot}) scale(${scale})`}
          opacity={opacity}
        >
          {/* 影(紙地から浮かせる) */}
          <path
            d={plaquePath}
            transform="translate(6,7)"
            fill={PALETTE.ink}
            opacity={0.14}
          />
          {/* 看板本体(藍) */}
          <path
            d={plaquePath}
            fill={isPrior ? PALETTE.paper : PALETTE.indigo}
            stroke={PALETTE.ink}
            strokeWidth={7}
            strokeLinejoin="round"
          />
          {/* 紐通しの穴 */}
          <circle cx={0} cy={-bh / 2 + 8} r={4} fill={PALETTE.paper} stroke={PALETTE.ink} strokeWidth={2} />
          {/* 取り消し線 */}
          {struck ? (
            <>
              <path d={strike1} fill="none" stroke={PALETTE.red} strokeWidth={9} strokeLinecap="round" />
              <path d={strike2} fill="none" stroke={PALETTE.red} strokeWidth={9} strokeLinecap="round" />
            </>
          ) : null}
          {/* 切れる瞬間の赤フラッシュ */}
          {flash > 0 ? <path d={plaquePath} fill={PALETTE.red} opacity={flash} /> : null}
        </g>
      );

      // --- ラベル(札の中央・HTML で鮮明に)---
      const showNew = downgraded > 0.5 && downgradeText;
      const labelText = showNew ? (downgradeText as string) : boards[i];
      const struckLabel = struck || (isFocus && mode === "remove" && frame >= removeFrame);
      const labelColor = isPrior
        ? PALETTE.red
        : showNew
          ? PALETTE.yellow
          : PALETTE.paper;
      const chars = Math.max(1, labelText.length);
      const labelFont = Math.min(bh * 0.5, (bw * 0.82) / chars);
      labelNodes.push(
        <div
          key={`label-${i}`}
          style={{
            position: "absolute",
            left: cx + tx,
            top: cy + ty,
            transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`,
            fontFamily: font,
            fontSize: labelFont,
            color: labelColor,
            letterSpacing: "0.04em",
            whiteSpace: "nowrap",
            opacity,
            textDecoration: struckLabel && !showNew ? "line-through" : "none",
            textDecorationColor: PALETTE.red,
            fontWeight: 700,
          }}
        >
          {labelText}
        </div>
      );
    }
  }

  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.paper }}>
      {/* 中央の肖像(看板の主) */}
      {showPortrait && charAssetId ? (
        <AbsoluteFill style={{ opacity: portraitOpacity }}>
          <DoodleCharacter
            assetId={charAssetId}
            xPct={50}
            yPct={portraitYPct}
            heightPct={portraitHeightPct}
            motion="idle"
            motionIntensity={0.4}
          />
        </AbsoluteFill>
      ) : null}

      {/* 環(看板を吊る要) */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {mode !== "stripped" ? (
          <circle cx={ringX} cy={ringY} r={0.016 * height} fill="none" stroke={PALETTE.ink} strokeWidth={5} />
        ) : null}
        {boardNodes}
      </svg>

      {labelNodes}

      {/* stripped の実像の一言 */}
      {stripped && strippedLabel ? (
        <div
          style={{
            position: "absolute",
            left: "50%",
            // 字幕帯・人物の足元との衝突回避: 等身大の人物の頭上に宣言として置く
            top: "16%",
            transform: "translate(-50%, -50%)",
            fontFamily: font,
            fontSize: height * 0.05,
            color: PALETTE.ink,
            letterSpacing: "0.06em",
            whiteSpace: "nowrap",
            opacity: interpolate(frame, [fallFrame + 20, fallFrame + 36], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {strippedLabel}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
