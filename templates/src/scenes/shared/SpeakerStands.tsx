import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { useOptionalAsset } from "../asset-context";
import * as channelStyle from "../style";
import { PALETTE } from "../style";
import { DEFAULT_EXPRESSION } from "../../schemas/types";
import type { Expression, TimingFile } from "../../schemas/types";

/**
 * 立ち絵+口パクレイヤー(bible §8「標準解説レイアウト」)。
 *
 * 画面左右下に話者の立ち絵を常時表示し、timing.json の phrase 区間と同期して
 * 口パク(open/closed 差分の交互表示)させる。Episode.tsx が LAYER 契約の
 * stands 層(シーンより前面・字幕より背面)として1回だけマウントする。
 *
 * チャンネル可変設定は style.ts の SPEAKER_STANDS(話者キー → side/assetPrefix/表情差分)。
 * エクスポートの無いチャンネルでは何も描画しない(FRAME_STYLE / SPEAKER_STYLE と
 * 同じ防御的読み込み = テンプレ互換)。
 *
 * 素材は assetId 規約 `<assetPrefix>-open` / `<assetPrefix>-closed` の2枚を
 * library.json から引く。未登録の間は「立ち絵未登録: <assetId>」と書いた
 * 点線の仮枠(話者accent色)を描く — 本番に混入したら一目でわかるための意匠で、
 * レンダー自体は止めない(素材登録前でも検証パイプラインを通せる)。
 *
 * 表情(timing.json の行 `expression`、台本注釈 `- expression:` 由来):
 * 話者ごとに「直近に始まった自分の行」の表情を保持する(次に自分が話すまで持続する
 * = 相手の話を驚いた顔で聞き続けられる)。表情の解決は3段のフォールバックで、
 * どの段でも**登録済み素材しか参照しない**(bible §10):
 *   1. style.ts の expressionPrefixes に宣言があり、かつ library.json に登録済み → それを描く
 *   2. 宣言が無い / 宣言はあるが未登録 → assetPrefix(既定表情)へ落ちる
 *   3. assetPrefix すら未登録 → 点線の仮枠(レンダーは止めない)
 * 1→2 のフォールバックが起きた行は開発時に console.warn で可視化する。
 */

export type SpeakerStandConfig = {
  /** 立ち絵を置く側(bible §8 が話者ごとの左右を定める) */
  side: "left" | "right";
  /**
   * 既定表情の assetId 接頭辞。"<prefix>-open" / "<prefix>-closed" の2枚を引く。
   * 表情解決の最終フォールバック先でもあるため、必ず登録済みの素材を指すこと。
   */
  assetPrefix: string;
  /**
   * このチャンネルが素材を持つ表情のみを宣言する(表情キー → assetId 接頭辞)。
   * 省略・未宣言の表情は assetPrefix へ落ちるため、表情差分を持たないチャンネルは
   * このフィールドごと省略してよい(従来どおり既定表情が描かれる)。
   */
  expressionPrefixes?: Partial<Record<Expression, string>>;
};

/** style.ts の SPEAKER_STANDS(無いチャンネルでは空 = 何も描画しない) */
const STANDS: Record<string, SpeakerStandConfig> =
  ((channelStyle as Record<string, unknown>).SPEAKER_STANDS as
    | Record<string, SpeakerStandConfig>
    | undefined) ?? {};

/** 字幕の話者色と同じ accent を仮枠の色に流用する(無ければ ink) */
const SPEAKER_STYLE: Record<string, { accent: string; label: string }> =
  ((channelStyle as Record<string, unknown>).SPEAKER_STYLE as
    | Record<string, { accent: string; label: string }>
    | undefined) ?? {};

/** 立ち絵の高さ(キャンバス高さ比) */
const STAND_HEIGHT_PCT = 0.45;
/** 左右端からの内側マージン(キャンバス幅比) */
const EDGE_INSET_PCT = 0.02;
/** 口パクの open/closed 切り替え間隔(秒) ≈ 120ms */
const MOUTH_TOGGLE_SEC = 0.12;
/** 発話中の上下揺れの振幅(px)。常に上方向へ 0〜BOB_TRAVEL_PX 動く */
const BOB_TRAVEL_PX = 3;
/** 上下揺れの周波数(Hz) */
const BOB_FREQ_HZ = 2;

/**
 * 立ち絵専用の寛容な assetId 解決。
 * useOptionalAsset は未登録IDに明確なエラーを投げる契約(タイポ検出)だが、
 * 立ち絵は「未登録でも仮枠を描いてレンダーを止めない」層なので、ここでだけ
 * undefined へ落とす(仮枠の文言が代わりに未登録を可視化する)。
 * useOptionalAsset は throw の前に必ず useContext を1回呼ぶため、
 * try/catch で包んでも hooks の呼び出し順序は安定している。
 */
function useStandAsset(assetId: string | undefined): string | undefined {
  try {
    return useOptionalAsset(assetId);
  } catch {
    return undefined;
  }
}

/** 表情フォールバックの警告を1組み合わせにつき1回だけ出すための記録(開発時の可視化) */
const warnedExpressionFallbacks = new Set<string>();

function warnExpressionFallback(assetId: string, fallbackAssetId: string): void {
  if (warnedExpressionFallbacks.has(assetId)) return;
  warnedExpressionFallbacks.add(assetId);
  console.warn(
    `[SpeakerStands] 表情素材 "${assetId}" が assets/library.json に未登録のため ` +
      `"${fallbackAssetId}" へフォールバックしました。表情差分を使うには ` +
      `素材を人間承認のうえ library.json へ登録し、style.ts の ` +
      `SPEAKER_STANDS.expressionPrefixes に宣言してください。`
  );
}

const StandFigure: React.FC<{
  speakerKey: string;
  config: SpeakerStandConfig;
  /** 現在フレームがこの話者の phrase 区間内か */
  speaking: boolean;
  /** この話者の現在の表情(直近に始まった自分の行由来。既定は DEFAULT_EXPRESSION) */
  expression: Expression;
  tSec: number;
}> = ({ speakerKey, config, speaking, expression, tSec }) => {
  const { width, height } = useVideoConfig();

  // 口パク: 発話中は open/closed を MOUTH_TOGGLE_SEC ごとに交互、区間外は closed
  const mouthOpen =
    speaking && Math.floor(tSec / MOUTH_TOGGLE_SEC) % 2 === 0;
  const mouth = mouthOpen ? "open" : "closed";

  // 表情解決。既定表情(assetPrefix)を必ずフォールバックに持つ。
  // 両方の useStandAsset を毎フレーム無条件に呼ぶことで hooks の呼び出し順序を固定する
  // (表情が変わっても hooks 数は変わらない)。
  const expressionPrefix = config.expressionPrefixes?.[expression];
  const expressionAssetId = expressionPrefix
    ? `${expressionPrefix}-${mouth}`
    : undefined;
  const fallbackAssetId = `${config.assetPrefix}-${mouth}`;
  const expressionSrc = useStandAsset(expressionAssetId);
  const fallbackSrc = useStandAsset(fallbackAssetId);

  // 宣言があるのに未登録 = 契約と素材の乖離。既定表情へ落としつつ開発時に警告する
  if (expressionAssetId && !expressionSrc) {
    warnExpressionFallback(expressionAssetId, fallbackAssetId);
  }

  const src = expressionSrc ?? fallbackSrc;
  // 仮枠に出す ID は「実際に引こうとして引けなかった素材」= 既定表情の側
  const assetId = expressionSrc ? expressionAssetId! : fallbackAssetId;

  // 発話中だけ sine で上下に揺れる(常に上方向 0〜BOB_TRAVEL_PX。下端は切らない)
  const bobY = speaking
    ? -((Math.sin(tSec * Math.PI * 2 * BOB_FREQ_HZ) + 1) / 2) * BOB_TRAVEL_PX
    : 0;

  const standH = Math.round(height * STAND_HEIGHT_PCT);
  const inset = Math.round(width * EDGE_INSET_PCT);
  const accent = SPEAKER_STYLE[speakerKey]?.accent ?? PALETTE.ink;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        ...(config.side === "left" ? { left: inset } : { right: inset }),
        height: standH,
        transform: `translateY(${bobY}px)`,
      }}
    >
      {src ? (
        <Img
          src={src}
          style={{ height: "100%", width: "auto", display: "block" }}
        />
      ) : (
        // 未登録の仮枠: 点線ボックス+話者accent色+assetId明記(本番混入の検出用)
        <div
          style={{
            height: "100%",
            width: Math.round(standH * 0.55),
            boxSizing: "border-box",
            border: `6px dashed ${accent}`,
            borderRadius: 16,
            background: "rgba(255, 255, 255, 0.55)",
            color: accent,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
            padding: 20,
            fontSize: 26,
            lineHeight: 1.5,
            fontFamily: "sans-serif",
            fontWeight: 700,
            overflowWrap: "anywhere",
          }}
        >
          立ち絵未登録: {assetId}
        </div>
      )}
    </div>
  );
};

/**
 * Episode.tsx から描画される立ち絵レイヤー本体。
 * zIndex は Episode.tsx の LAYER 契約(scenes < stands < letterbox < subtitle)を
 * 単一真実源とし、prop で受け取る。
 */
export const SpeakerStandsLayer: React.FC<{
  timing: TimingFile;
  zIndex: number;
}> = ({ timing, zIndex }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tSec = frame / fps;

  const entries = Object.entries(STANDS);
  if (entries.length === 0) {
    // SPEAKER_STANDS 未定義チャンネル = 何も描画しない(テンプレ互換)
    return null;
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex }}>
      {entries.map(([speakerKey, config]) => {
        const ownLines = timing.lines.filter(
          (line) => line.speaker === speakerKey
        );
        const speaking = ownLines.some((line) =>
          line.phrases.some((p) => tSec >= p.startSec && tSec < p.endSec)
        );
        // 表情は「直近に始まった自分の行」のものを保持する(次に自分が話すまで持続)。
        // 自分の最初の行より前・expression 注釈の無い行・expression の無い
        // 旧 timing.json は DEFAULT_EXPRESSION へ落ちる(後方互換)。
        let expression: Expression = DEFAULT_EXPRESSION;
        for (const line of ownLines) {
          if (line.startSec > tSec) break;
          expression = line.expression ?? DEFAULT_EXPRESSION;
        }
        return (
          <StandFigure
            key={speakerKey}
            speakerKey={speakerKey}
            config={config}
            speaking={speaking}
            expression={expression}
            tSec={tSec}
          />
        );
      })}
    </AbsoluteFill>
  );
};
