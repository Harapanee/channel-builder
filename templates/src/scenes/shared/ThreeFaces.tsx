import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { popIn, seedFrom, shake } from "../../motion";
import { roughEllipsePath } from "../doodle-svg";
import { PALETTE } from "../style";
import { DOODLE_FONT_STACK, useDoodleFont } from "../use-doodle-font";
import { DoodleCharacter } from "../core/DoodleCharacter";

/**
 * 共有スパイン(Group α 実装 / bible §1・全編の背骨モチーフ)。
 * 教科書が塗った「三つの顔(= 三枚の仮面)」を可視化する。
 *   index 0 = 最強の武将(赤い戦仕様の面)
 *   index 1 = 冷酷な魔王(藍・角つきの鬼面)
 *   index 2 = 時代の革新者(黄の光を戴く面)
 *
 * 各章が 1 枚ずつ剥がす(crack)。crack の固定順は
 *   三章=最強[0] → 四章=革新者[2] → 五章=魔王[1] → 終章=fallen(全て割れて落ちる)。
 * priorCracked で「既に割れた面」を割れたまま保持するので、全 Phase 2 が矛盾なく積める。
 *
 * props 契約(§5 / §9): mode / crackIndex / priorCracked / charAssetId は固定。
 * 表示用の任意 props(labels / appearFrames / crackFrame / fallFrame / showLabels)は
 * 既定値ありの非破壊追加。
 */
export type ThreeFacesProps = {
  /** intro=三枚提示 / crack=1枚割る / fallen=全て割れて落ち素顔が残る */
  mode: "intro" | "crack" | "fallen";
  /** crack で割る面(0=最強,1=魔王,2=革新者) */
  crackIndex?: 0 | 1 | 2;
  /** 既に割れている面(割れたまま保持) */
  priorCracked?: number[];
  /** 仮面の奥の信長(library の assetId) */
  charAssetId?: string;
  /** 面のラベル(左→右)。既定 ["最強","魔王","革新者"] */
  labels?: [string, string, string];
  /** intro の各面の出現フレーム(スタッガー)。既定 [0,40,80] */
  appearFrames?: [number, number, number];
  /** crack モードで crackIndex の面が割れ始めるフレーム。既定 12 */
  crackFrame?: number;
  /** fallen モードで面が落ち始めるフレーム。既定 10 */
  fallFrame?: number;
  /** ラベルを表示するか。既定 true(intro の 1 枚目は false で「名前はまだ」も可) */
  showLabels?: boolean;
};

type MaskStyle = {
  faceFill: string;
  outline: string;
};

const MASK_STYLE: MaskStyle[] = [
  { faceFill: PALETTE.paper, outline: PALETTE.red }, // 0 最強
  { faceFill: PALETTE.indigo, outline: PALETTE.ink }, // 1 魔王
  { faceFill: PALETTE.paper, outline: PALETTE.yellow }, // 2 革新者
];

/** 面の造作(local 座標・原点中心)。index ごとに顔つきを変える。 */
function faceFeatures(index: number, s: number): React.ReactNode {
  const ink = PALETTE.ink;
  const red = PALETTE.red;
  const yellow = PALETTE.yellow;
  const indigo = PALETTE.indigo;
  const sw = s * 0.028;

  if (index === 0) {
    // 最強: 兜の前立て・怒り眉・険しい口
    return (
      <>
        <path
          d={`M 0 ${-0.62 * s} L ${-0.07 * s} ${-0.48 * s} L ${0.07 * s} ${-0.48 * s} Z`}
          fill={indigo}
          stroke={ink}
          strokeWidth={sw * 0.7}
        />
        <path d={`M ${-0.22 * s} ${-0.2 * s} L ${-0.04 * s} ${-0.08 * s}`} stroke={red} strokeWidth={sw} strokeLinecap="round" />
        <path d={`M ${0.22 * s} ${-0.2 * s} L ${0.04 * s} ${-0.08 * s}`} stroke={red} strokeWidth={sw} strokeLinecap="round" />
        <ellipse cx={-0.13 * s} cy={-0.02 * s} rx={0.045 * s} ry={0.03 * s} fill={ink} />
        <ellipse cx={0.13 * s} cy={-0.02 * s} rx={0.045 * s} ry={0.03 * s} fill={ink} />
        <path d={`M ${-0.13 * s} ${0.24 * s} Q 0 ${0.14 * s} ${0.13 * s} ${0.24 * s}`} fill="none" stroke={ink} strokeWidth={sw} strokeLinecap="round" />
      </>
    );
  }
  if (index === 1) {
    // 魔王: 二本角・白目・牙の口
    return (
      <>
        <path d={`M ${-0.12 * s} ${-0.46 * s} L ${-0.3 * s} ${-0.66 * s} L ${-0.02 * s} ${-0.5 * s} Z`} fill={ink} />
        <path d={`M ${0.12 * s} ${-0.46 * s} L ${0.3 * s} ${-0.66 * s} L ${0.02 * s} ${-0.5 * s} Z`} fill={ink} />
        <ellipse cx={-0.13 * s} cy={-0.04 * s} rx={0.07 * s} ry={0.04 * s} fill={PALETTE.paper} stroke={ink} strokeWidth={sw * 0.5} />
        <ellipse cx={0.13 * s} cy={-0.04 * s} rx={0.07 * s} ry={0.04 * s} fill={PALETTE.paper} stroke={ink} strokeWidth={sw * 0.5} />
        <circle cx={-0.12 * s} cy={-0.03 * s} r={0.022 * s} fill={ink} />
        <circle cx={0.14 * s} cy={-0.03 * s} r={0.022 * s} fill={ink} />
        <path
          d={`M ${-0.18 * s} ${0.16 * s} L ${-0.09 * s} ${0.26 * s} L 0 ${0.16 * s} L ${0.09 * s} ${0.26 * s} L ${0.18 * s} ${0.16 * s}`}
          fill="none"
          stroke={PALETTE.paper}
          strokeWidth={sw}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </>
    );
  }
  // 2 革新者: 頭上の光(希望=黄)・穏やかな目・柔らかい口
  const rays: React.ReactNode[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    rays.push(
      <path
        key={i}
        d={`M ${Math.cos(a) * 0.075 * s} ${-0.62 * s + Math.sin(a) * 0.075 * s} L ${Math.cos(a) * 0.11 * s} ${-0.62 * s + Math.sin(a) * 0.11 * s}`}
        stroke={yellow}
        strokeWidth={sw * 0.6}
        strokeLinecap="round"
      />
    );
  }
  return (
    <>
      {rays}
      <circle cx={0} cy={-0.62 * s} r={0.055 * s} fill={yellow} stroke={ink} strokeWidth={sw * 0.5} />
      <circle cx={-0.12 * s} cy={-0.03 * s} r={0.03 * s} fill={ink} />
      <circle cx={0.12 * s} cy={-0.03 * s} r={0.03 * s} fill={ink} />
      <path d={`M ${-0.1 * s} ${0.16 * s} Q 0 ${0.25 * s} ${0.1 * s} ${0.16 * s}`} fill="none" stroke={ink} strokeWidth={sw} strokeLinecap="round" />
    </>
  );
}

/** 面を縦断する亀裂パス(local・原点中心)。pathLength=100 で描き起こし可。 */
function crackPath(s: number): string {
  return (
    `M 0 ${-0.46 * s}` +
    ` L ${0.06 * s} ${-0.2 * s}` +
    ` L ${-0.05 * s} ${0.02 * s}` +
    ` L ${0.07 * s} ${0.22 * s}` +
    ` L ${-0.02 * s} ${0.46 * s}`
  );
}

export const ThreeFaces: React.FC<ThreeFacesProps> = ({
  mode,
  crackIndex,
  priorCracked = [],
  charAssetId,
  labels = ["最強", "魔王", "革新者"],
  appearFrames = [0, 40, 80],
  crackFrame = 12,
  fallFrame = 10,
  showLabels = true,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const font = `${fontFamily}, ${DOODLE_FONT_STACK}`;

  const s = 0.26 * height; // 面の高さ単位
  const rx = 0.36 * s;
  const ry = 0.5 * s;
  const cxPct = [26, 50, 74];
  const cy = 0.4 * height;

  // 奥の信長の可視度(fallen で素顔があらわになる)
  const charOpacity =
    mode === "fallen"
      ? interpolate(frame, [fallFrame + 6, fallFrame + 26], [0.28, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0.22;
  const charYPct =
    mode === "fallen"
      ? interpolate(frame, [fallFrame + 6, fallFrame + 30], [60, 56], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 60;

  const maskNodes: React.ReactNode[] = [];
  const labelNodes: React.ReactNode[] = [];

  for (let i = 0; i < 3; i++) {
    const cx = (cxPct[i] / 100) * width;
    const seed = seedFrom("three-faces", i);
    const isPrior = priorCracked.includes(i);
    const isFocus = mode === "crack" && crackIndex === i;
    const isFallen = mode === "fallen";

    // --- 出現 / 変形 ---
    let tx = 0;
    let ty = 0;
    let rot = 0;
    let scale = 1;
    let opacity = 1;

    if (mode === "intro") {
      const p = popIn(frame, fps, { delayFrames: appearFrames[i] });
      scale = p.scale;
      opacity = p.opacity;
    } else if (isFallen) {
      const local = frame - fallFrame - i * 3;
      if (local > 0) {
        const drop = interpolate(local, [0, 30], [0, 0.55 * height], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        ty = drop;
        rot = (i === 1 ? 1 : i === 0 ? -1 : 1) * local * 0.9;
        opacity = interpolate(local, [4, 28], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
      }
    } else if (isFocus) {
      const sh = shake(Math.max(0, frame - crackFrame), fps, {
        seed,
        intensityPx: 10,
        rotDeg: 1.4,
        hz: 20,
        decayFrames: 14,
      });
      tx = sh.x;
      ty = sh.y;
      rot = sh.rotate;
    } else if (isPrior) {
      opacity = 0.92;
      rot = i === 1 ? 2 : -2;
    }

    // --- 亀裂の進行 ---
    let crackProgress = 0;
    if (isPrior || isFallen) crackProgress = 1;
    else if (isFocus)
      crackProgress = interpolate(frame, [crackFrame, crackFrame + 16], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

    // --- 割れる瞬間の赤フラッシュ(focus) ---
    const flash = isFocus
      ? interpolate(frame, [crackFrame - 1, crackFrame + 2, crackFrame + 14], [0, 0.5, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;

    // --- 落ちる欠片(focus / fallen)---
    const chipStart = isFallen ? fallFrame + i * 3 : crackFrame + 2;
    const chipLocal = frame - chipStart;
    const chips: React.ReactNode[] = [];
    if ((isFocus || isFallen) && chipLocal > 0) {
      for (let c = 0; c < 3; c++) {
        const dir = c - 1;
        const cl = chipLocal - c * 2;
        if (cl <= 0) continue;
        const cyDrop = interpolate(cl, [0, 26], [0, 0.4 * height], { extrapolateRight: "clamp" });
        const cxDrift = dir * 0.05 * s * Math.min(1, cl / 12);
        const cop = interpolate(cl, [0, 22], [0.9, 0], { extrapolateRight: "clamp" });
        chips.push(
          <path
            key={c}
            d={`M ${dir * 0.1 * s} ${-0.1 * s} L ${dir * 0.1 * s + 0.05 * s} ${0.02 * s} L ${dir * 0.1 * s - 0.03 * s} ${0.06 * s} Z`}
            transform={`translate(${cxDrift}, ${cyDrop}) rotate(${cl * (dir + 0.5) * 3})`}
            fill={MASK_STYLE[i].faceFill}
            stroke={MASK_STYLE[i].outline}
            strokeWidth={s * 0.012}
            opacity={cop}
          />
        );
      }
    }

    maskNodes.push(
      <g key={i} transform={`translate(${cx + tx}, ${cy + ty}) rotate(${rot}) scale(${scale})`} opacity={opacity}>
        <path
          d={roughEllipsePath(0, 0, rx, ry, seed, 0.06, 18)}
          fill={MASK_STYLE[i].faceFill}
          stroke={MASK_STYLE[i].outline}
          strokeWidth={s * 0.05}
          strokeLinejoin="round"
        />
        {faceFeatures(i, s)}
        {crackProgress > 0 ? (
          <path
            d={crackPath(s)}
            pathLength={100}
            fill="none"
            stroke={PALETTE.red}
            strokeWidth={s * 0.022}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={100}
            strokeDashoffset={100 * (1 - crackProgress)}
          />
        ) : null}
        {flash > 0 ? (
          <path d={roughEllipsePath(0, 0, rx, ry, seed, 0.06, 18)} fill={PALETTE.red} opacity={flash} />
        ) : null}
        {chips}
      </g>
    );

    // --- ラベル(面の下)---
    if (showLabels) {
      const labelOpacity =
        mode === "intro"
          ? popIn(frame, fps, { delayFrames: appearFrames[i] + 4 }).opacity
          : isFallen
            ? interpolate(frame - fallFrame - i * 3, [0, 10], [1, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            : 1;
      const cracked = isPrior || isFallen || (isFocus && crackProgress > 0.6);
      labelNodes.push(
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${cxPct[i]}%`,
            top: `${((cy + ry + 0.045 * height) / height) * 100}%`,
            transform: "translate(-50%, -50%)",
            fontFamily: font,
            fontSize: height * 0.045,
            color: cracked ? PALETTE.red : PALETTE.ink,
            letterSpacing: "0.06em",
            whiteSpace: "nowrap",
            opacity: labelOpacity,
            textDecoration: cracked ? "line-through" : "none",
          }}
        >
          {labels[i]}
        </div>
      );
    }
  }

  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.paper }}>
      {/* 奥の信長(素顔)*/}
      {charAssetId ? (
        <AbsoluteFill style={{ opacity: charOpacity }}>
          <DoodleCharacter
            assetId={charAssetId}
            xPct={50}
            yPct={charYPct}
            heightPct={mode === "fallen" ? 52 : 48}
            motion="idle"
            motionIntensity={0.4}
          />
        </AbsoluteFill>
      ) : null}

      {/* 三枚の仮面 */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {maskNodes}
      </svg>

      {labelNodes}
    </AbsoluteFill>
  );
};
