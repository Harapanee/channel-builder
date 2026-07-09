import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { seedFrom, shake } from "../../motion";
import {
  roughCirclePath,
  roughClosedPath,
  roughLinePath,
} from "../doodle-svg";
import { PALETTE } from "../style";
import { DoodleCharacter } from "../core/DoodleCharacter";

/**
 * 共有スパイン(Group α 実装 / bible §4 チャンネル署名オープニング)。
 * 現代の「あなた」がトラックに撥ねられ、白い光を経て戦国へ落ちる 0.0〜約5.2秒。
 * §12 記号表現厳守: 血・衝突の生々しさは描かない。接近 → ドン(SE)+ 白光 → 落下。
 *
 * L01+L02 を 1 ショットとして描く。L03 の祝福(信長登場)は別ショットで接続する。
 *
 * 内部タイムライン(既定・fps=30 基準、props で微調整可):
 *   0.0–1.1s  横断歩道を you-modern が歩く(スマホの白い光)。ほぼ無音
 *   1.1–3.0s  赤信号(赤い手描き円)点滅 / トラックが右外周から侵入・拡大(§8 危険)
 *   3.0–3.9s  トラックが迫る(BigShadow 級)。you 立ち止まり。無音づくり
 *   ~4.15s    衝突: you=hit-launched・画面が揺れ・トラック停止。SE ドン(序盤最大の一撃)
 *   4.3–4.7s  白い光が満ちる。魂(soul)が浮く
 *   4.7–5.2s  白の中を転生先へ落下。転生先の人物の輪郭が結ばれる(次ショットの祝福へ橋渡し)
 *
 * SE / 無音は shots.json 側で設計する(このコンポーネントは絵のみ)。
 */
export type TruckIsekaiProps = {
  /** 歩く現代のあなた(walking-on-phone) */
  youWalkingAssetId?: string;
  /** 撥ねられた瞬間のあなた(hit-launched) */
  youHitAssetId?: string;
  /** 抜けた魂(soul) */
  youSoulAssetId?: string;
  /** トラックが画面外(右)から侵入し始める秒。既定 1.1 */
  truckEnterSec?: number;
  /** 衝突(ドン)の秒。序盤最大の一撃。既定 4.15 */
  impactSec?: number;
  /** 白光が満ちきる秒。既定 4.7 */
  whiteFullSec?: number;
};

export const TruckIsekai: React.FC<TruckIsekaiProps> = ({
  youWalkingAssetId,
  youHitAssetId,
  youSoulAssetId,
  truckEnterSec = 1.1,
  impactSec = 4.15,
  whiteFullSec = 4.7,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const seed = seedFrom("truck-isekai", width, height);

  const enterF = truckEnterSec * fps;
  const impactF = impactSec * fps;
  const whiteStartF = impactF + 4;
  const whiteFullF = whiteFullSec * fps;
  const silhouetteF = whiteFullF + 6;

  const hit = frame >= impactF;

  // ---- 衝突時の画面揺れ(§8 線の震え / 減衰) ----------------------------
  const sh = hit
    ? shake(frame - impactF, fps, {
        seed,
        intensityPx: 20,
        rotDeg: 2,
        hz: 22,
        decayFrames: 16,
      })
    : { x: 0, y: 0, rotate: 0 };

  // ---- 歩行するあなた: 左 → 中央 へ、以後は待機 --------------------------
  const walkXPct = interpolate(frame, [0, enterF + 6], [21, 46], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });

  // ---- トラック(右外周から侵入して拡大・迫る)---------------------------
  const truckCxPct = interpolate(frame, [enterF, impactF], [128, 72], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const truckScale = interpolate(frame, [enterF, impactF], [0.45, 1.5], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const truckCx = (truckCxPct / 100) * width;
  const truckCy = 0.74 * height;
  const truckVisible = frame >= enterF - 2;

  // ---- 赤信号(危険 = 赤い手描き円・点滅)-------------------------------
  const signalCx = 0.15 * width;
  const signalCy = 0.2 * height;
  const signalR = 0.055 * height;
  const signalOn = frame >= enterF - 8 && !hit;
  const blink = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(frame * 0.9));
  const signalPath = roughCirclePath(signalCx, signalCy, signalR, seed ^ 0x51, 0.05, 22, 1.06);

  // ---- スマホの白い光(歩行中の手元)------------------------------------
  const phoneOpacity = interpolate(frame, [4, 12, impactF - 14, impactF - 2], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const phoneCx = ((walkXPct + 5) / 100) * width;
  const phoneCy = 0.6 * height;

  // ---- 白い光(§4)------------------------------------------------------
  const white = interpolate(
    frame,
    [whiteStartF, whiteFullF, whiteFullF + 8, silhouetteF + 8],
    [0, 1, 1, 0.55],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ---- 魂(soul): 白の中を浮いて → 戦国へ落下 ---------------------------
  const soulYPct = interpolate(frame, [whiteStartF, whiteFullF, silhouetteF + 10], [60, 45, 76], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  const soulOpacity = interpolate(frame, [whiteStartF + 1, whiteStartF + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ---- 転生先の人物の輪郭(着地の予感・次ショットへ橋渡し)---------------
  const silOpacity = interpolate(frame, [silhouetteF, silhouetteF + 10], [0, 0.42], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const silCx = 0.5 * width;
  const silHeadCy = 0.44 * height;
  const silHeadR = 0.06 * height;

  // ---- 横断歩道(手描きの縞)--------------------------------------------
  const roadTop = 0.78 * height;
  const roadBottom = 0.94 * height;
  const stripes: React.ReactNode[] = [];
  for (let i = 0; i < 7; i++) {
    const x = 0.1 * width + i * 0.12 * width;
    stripes.push(
      <path
        key={i}
        d={roughClosedPath(
          [
            [x, roadTop + 8],
            [x + 0.06 * width, roadTop + 8],
            [x + 0.06 * width, roadBottom - 8],
            [x, roadBottom - 8],
          ],
          seed ^ (i + 7),
          5
        )}
        fill={PALETTE.paper}
        stroke={PALETTE.ink}
        strokeWidth={3}
        opacity={0.85}
      />
    );
  }

  // ---- トラック(SVG コード生成・前面 = 左向き)-------------------------
  // 「箱型の荷台(大きな長方形)+ 前方の低い運転席キャビン + 大きな車輪2つ」の
  // 明確なトラックシルエット。荷台をキャビンより高くし、間に隙間を置くことで
  // バス(一体の長い箱)に見えないようにする。
  // Catmull-Rom 平滑化で角が丸まりすぎないよう、各辺に中間点を挿入して
  // 「角の立った箱 + 手描きジッタ」を両立する。
  const subdivide = (corners: Array<[number, number]>, step: number): Array<[number, number]> => {
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
  };
  const truck = (
    <g transform={`translate(${truckCx}, ${truckCy}) scale(${truckScale})`}>
      {/* 荷台(箱型の大きな長方形・車体後方) */}
      <path
        d={roughClosedPath(
          subdivide(
            [
              [-52, -262],
              [338, -262],
              [338, -26],
              [-52, -26],
            ],
            62
          ),
          seed ^ 0x11,
          5
        )}
        fill={PALETTE.indigo}
        stroke={PALETTE.ink}
        strokeWidth={11}
        strokeLinejoin="round"
      />
      {/* 荷台のパネル線(コンテナの箱感) */}
      <path
        d={roughLinePath(-38, -196, 324, -196, seed ^ 0x44, 4, 10)}
        fill="none"
        stroke={PALETTE.ink}
        strokeWidth={5}
        opacity={0.5}
      />
      {/* 運転席キャビン(前方 = 左。荷台より低く、フロントはわずかに傾斜) */}
      <path
        d={roughClosedPath(
          subdivide(
            [
              [-268, -26],
              [-268, -104],
              [-236, -150],
              [-64, -150],
              [-64, -26],
            ],
            52
          ),
          seed ^ 0x22,
          5
        )}
        fill={PALETTE.indigo}
        stroke={PALETTE.ink}
        strokeWidth={11}
        strokeLinejoin="round"
      />
      {/* 窓(フロントガラス) */}
      <path
        d={roughClosedPath(
          subdivide(
            [
              [-242, -134],
              [-146, -134],
              [-146, -80],
              [-250, -80],
            ],
            40
          ),
          seed ^ 0x33,
          3
        )}
        fill={PALETTE.paper}
        stroke={PALETTE.ink}
        strokeWidth={6}
        strokeLinejoin="round"
      />
      {/* 大きな車輪2つ(前 = キャビン下 / 後 = 荷台下) */}
      {[
        [-166, 14],
        [230, 14],
      ].map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r={62} fill={PALETTE.ink} />
          <circle cx={cx} cy={cy} r={22} fill={PALETTE.paper} />
        </g>
      ))}
      {/* ヘッドライト(前面 = 左・小さめ) */}
      <circle cx={-260} cy={-46} r={13} fill={PALETTE.yellow} stroke={PALETTE.ink} strokeWidth={5} />
    </g>
  );

  return (
    <AbsoluteFill style={{ backgroundColor: PALETTE.paper }}>
      {/* --- 揺れる本体レイヤー --- */}
      <AbsoluteFill
        style={{ transform: `translate(${sh.x}px, ${sh.y}px) rotate(${sh.rotate}deg)` }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
        >
          {/* 車道 */}
          <path
            d={roughLinePath(0, roadTop, width, roadTop, seed ^ 0x99, 5, 16)}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth={4}
            opacity={0.3}
          />
          {stripes}
          {/* 赤信号(危険 = 赤円・点滅) */}
          {signalOn ? (
            <g opacity={blink}>
              <path
                d={signalPath}
                fill="none"
                stroke={PALETTE.red}
                strokeWidth={10}
                strokeLinecap="round"
              />
              <circle cx={signalCx} cy={signalCy} r={signalR * 0.5} fill={PALETTE.red} />
            </g>
          ) : null}
          {/* トラック */}
          {truckVisible ? truck : null}
          {/* スマホの白い光 */}
          {phoneOpacity > 0.01 ? (
            <g opacity={phoneOpacity}>
              <circle cx={phoneCx} cy={phoneCy} r={0.03 * height} fill={PALETTE.paper} />
              <circle
                cx={phoneCx}
                cy={phoneCy}
                r={0.03 * height}
                fill="none"
                stroke={PALETTE.yellow}
                strokeWidth={4}
                opacity={0.7}
              />
            </g>
          ) : null}
        </svg>

        {/* 歩く / 撥ねられる あなた */}
        {hit ? (
          <DoodleCharacter
            assetId={youHitAssetId}
            xPct={41}
            yPct={53}
            heightPct={40}
            motion="shake"
            motionIntensity={0.9}
          />
        ) : (
          <DoodleCharacter
            assetId={youWalkingAssetId}
            xPct={walkXPct}
            yPct={62}
            heightPct={40}
            motion="idle"
            motionIntensity={0.5}
          />
        )}
      </AbsoluteFill>

      {/* --- 白い光(§4)--- */}
      {white > 0.01 ? (
        <AbsoluteFill style={{ backgroundColor: "#FFFFFF", opacity: white, pointerEvents: "none" }} />
      ) : null}

      {/* --- 転生先の人物の輪郭(着地の予感) --- */}
      {silOpacity > 0.01 ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ position: "absolute", inset: 0, overflow: "visible", opacity: silOpacity }}
        >
          <circle
            cx={silCx}
            cy={silHeadCy}
            r={silHeadR}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth={7}
          />
          <path
            d={roughClosedPath(
              [
                [silCx - 0.09 * width, 0.78 * height],
                [silCx - 0.07 * width, silHeadCy + silHeadR + 6],
                [silCx + 0.07 * width, silHeadCy + silHeadR + 6],
                [silCx + 0.09 * width, 0.78 * height],
              ],
              seed ^ 0x77,
              7
            )}
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth={7}
            strokeLinejoin="round"
          />
        </svg>
      ) : null}

      {/* --- 魂(soul)は光の中で浮く --- */}
      {soulOpacity > 0.01 ? (
        <AbsoluteFill style={{ opacity: soulOpacity }}>
          <DoodleCharacter
            assetId={youSoulAssetId}
            xPct={50}
            yPct={soulYPct}
            heightPct={30}
            motion="idle"
            motionIntensity={0.7}
          />
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
