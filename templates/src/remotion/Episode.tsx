import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";
import { resolveComponent } from "../scenes/registry";
import { PlaceholderBase } from "../scenes/core/PlaceholderBase";
import { AssetProvider } from "../scenes/asset-context";
import { SpeakerStandsLayer } from "../scenes/shared/SpeakerStands";
import { DOODLE_FONT_STACK, useDoodleFont } from "../scenes/use-doodle-font";
import { PALETTE } from "../scenes/style";
import * as channelStyle from "../scenes/style";
import type { LibraryFile, Shot, ShotsFile, TimingFile } from "../schemas/types";

/**
 * §7.5: Episode.tsx は shots.json と timing.json を input props として受け取り、
 * 各ショットを <Sequence> に変換する。scene.component はレジストリで解決し、
 * props はそのまま渡す。音声トラック・字幕もここで組み立てる。
 *
 * このファイルは全チャンネル共通(check-template-sync の IDENTICAL 区分)。
 * チャンネルごとの見た目の違い(黒帯・字幕様式・背景色)は style.ts の
 * FRAME_STYLE(チャンネル可変)で表現し、ロジックをここに分岐で持ち込まない。
 */
export type EpisodeProps = {
  /** プロジェクトルートからの相対パス。例: "episodes/ep000-test" */
  episodeDir: string;
  /** calculateMetadata が読み込んで注入する。コンポーネント本体はfs等のNode専用APIを使わない */
  shots?: ShotsFile;
  timing?: TimingFile;
  library?: LibraryFile;
  narrationAvailable?: boolean;
  /** true のときショットにデバッグ情報(shotId/role/intent)を重畳する。既定 false */
  debug?: boolean;
};

/**
 * 画面フレーム設定(チャンネル可変の見た目)。style.ts が FRAME_STYLE を
 * エクスポートしていれば上書きされ、無ければ従来のDoodle系既定
 * (帯なし・角丸字幕・紙背景)で動く。旧版 style.ts のチャンネルでも
 * コンパイル・動作が壊れないよう、名前空間経由の防御的読み込みにしている。
 */
type FrameStyle = {
  /** 上下黒帯の高さ(キャンバス高さ比)。0で帯なし(従来既定) */
  letterboxPct: number;
  /** 帯の色(letterboxPct > 0 のときのみ使用) */
  letterboxColor?: string;
  /** 横型字幕の様式: "rounded"=角丸ボックス(従来) / "band"=下帯内の帯文字 */
  subtitleVariant: "rounded" | "band";
  /** 横型字幕のフォントスタック(未指定はチャンネルの手描きフォント) */
  subtitleFontFamily?: string;
  /** 横型字幕の文字色(band様式のとき。未指定は #F2EFE6) */
  subtitleColor?: string;
  /** 横型のルート背景色(未指定は PALETTE.paper) */
  rootBackground?: string;
};
const FRAME: FrameStyle = {
  letterboxPct: 0,
  subtitleVariant: "rounded",
  ...(((channelStyle as Record<string, unknown>).FRAME_STYLE as
    | Partial<FrameStyle>
    | undefined) ?? {}),
};

/**
 * 話者別字幕スタイル(2話者掛け合いチャンネルのみ style.ts が SPEAKER_STYLE を
 * エクスポートする)。timing.json の行に speaker があれば字幕文字色を accent に
 * 切り替える。エクスポートの無いチャンネル・speaker の無い行は従来色のまま
 * (FRAME_STYLE と同じ防御的読み込み)。
 */
const SPEAKER_STYLE: Record<string, { accent: string; label: string }> =
  ((channelStyle as Record<string, unknown>).SPEAKER_STYLE as
    | Record<string, { accent: string; label: string }>
    | undefined) ?? {};

/**
 * 立ち絵レイヤーの有効判定(2話者掛け合いチャンネルのみ style.ts が
 * SPEAKER_STANDS をエクスポートする)。無いチャンネルでは描画しない
 * (SPEAKER_STYLE と同じ防御的読み込み)。実体は SpeakerStandsLayer 参照。
 */
const SPEAKER_STANDS_ENABLED = Boolean(
  (channelStyle as Record<string, unknown>).SPEAKER_STANDS
);

/**
 * calculateMetadata / コンポーネント双方から呼ばれるため、Node.js と
 * ブラウザ(Remotionのレンダリング用Chrome)の両方で動く必要がある。
 * そのため `node:fs` は使わず、Remotionの静的配信サーバ経由の
 * `fetch(staticFile(...))` で読む(remotion.config.ts で publicDir を
 * プロジェクトルートに設定し、episodes/ 配下を配信できるようにしてある)。
 */
function episodeAssetUrl(episodeDir: string, ...segments: string[]): string {
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

async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * shots.json / timing.json を読み、
 * durationInFrames = narration.durationSec × fps を算出する。
 */
export const calculateEpisodeMetadata: CalculateMetadataFunction<
  EpisodeProps
> = async ({ props }) => {
  const { episodeDir } = props;

  const [shots, timing, library] = await Promise.all([
    fetchJson<ShotsFile>(episodeAssetUrl(episodeDir, "shots.json")),
    fetchJson<TimingFile>(episodeAssetUrl(episodeDir, "timing.json")),
    fetchJson<LibraryFile>(staticFile("assets/library.json")),
  ]);

  const narrationAvailable = await urlExists(
    episodeAssetUrl(episodeDir, shots.narration.file)
  );

  const durationInFrames = Math.max(
    1,
    Math.round(shots.narration.durationSec * shots.fps)
  );

  return {
    durationInFrames,
    fps: shots.fps,
    width: shots.resolution.w,
    height: shots.resolution.h,
    props: {
      ...props,
      shots,
      timing,
      library,
      narrationAvailable,
    },
  };
};

const ShotRenderer: React.FC<{ shot: Shot; debug?: boolean }> = ({
  shot,
  debug,
}) => {
  const Component = resolveComponent(shot.scene.component);
  return (
    <AbsoluteFill>
      {Component ? (
        <Component {...shot.scene.props} />
      ) : (
        <PlaceholderBase
          label={`Unresolved: ${shot.scene.component}`}
          color="#adb5bd"
        />
      )}
      {debug ? (
        <div
          style={{
            position: "absolute",
            top: 24,
            left: 24,
            padding: "8px 16px",
            background: "rgba(0,0,0,0.6)",
            color: "white",
            fontFamily: "monospace",
            fontSize: 22,
            borderRadius: 8,
            lineHeight: 1.5,
          }}
        >
          <div>shotId: {shot.shotId}</div>
          <div>role: {shot.role}</div>
          {shot.intent ? <div>intent: {shot.intent}</div> : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * 上下黒帯オーバーレイ(FRAME_STYLE.letterboxPct > 0 のチャンネルのみ。横型専用)。
 * 全ショットの最前面に重畳する — ショット側は帯を意識せずフルフレームで描く。
 * 字幕は下帯の中に載せるため、SubtitleLayer はこの帯より前面に置く。
 */
/**
 * 合成のレイヤ契約(全チャンネル共通)。
 *
 * 「字幕は必ずシーンより前面」をシステムとして保証する。シーン(場面演出)側が
 * 内部で zIndex を使うと、CSSの描画順では **positioned + 正のzIndex** の要素が
 * z-index:auto の兄弟(=従来の SubtitleLayer)より上のペイント層に来るため、
 * 字幕が絵の下に潜って消える(ep011 で全編の約3割が字幕消失)。
 *
 * 対策は2段構え:
 *   1. シーン群を isolation:isolate の層に閉じ込める → シーン内部の zIndex が
 *      この層の外へ影響しない(何を書かれても字幕を越えられない)
 *   2. 黒帯・字幕に明示的な zIndex を与える → DOM順に依存せず前後関係が確定する
 * 既存エピソード(シーンが zIndex 未使用)の見え方は変わらない(字幕は元から最前面)。
 */
const LAYER = {
  scenes: 0,
  /** 立ち絵(SPEAKER_STANDS チャンネルのみ): シーンより前面・黒帯/字幕より背面 */
  stands: 5,
  letterbox: 10,
  subtitle: 20,
} as const;

const LetterboxBars: React.FC = () => {
  const { width, height } = useVideoConfig();
  // 帯なしチャンネル・縦型ショート(height > width)には適用しない
  if (FRAME.letterboxPct <= 0 || height > width) {
    return null;
  }
  const barStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    height: `${FRAME.letterboxPct * 100}%`,
    backgroundColor: FRAME.letterboxColor ?? "#000000",
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: LAYER.letterbox }}>
      <div style={{ ...barStyle, top: 0 }} />
      <div style={{ ...barStyle, bottom: 0 }} />
    </AbsoluteFill>
  );
};

const SubtitleLayer: React.FC<{ timing: TimingFile }> = ({ timing }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fontFamily = useDoodleFont();
  const tSec = frame / fps;
  // 縦型ショート(height > width)だけ字幕を大きく・中央少し下へ寄せる。
  // 横型は FRAME_STYLE.subtitleVariant に従う(既定は従来の角丸ボックス)。
  const isVertical = height > width;

  // 字幕の表示窓: 発話時間ちょうどで消すと短い句が読み切れない。
  // 次のフレーズ開始まで余韻として残し(上限LINGER)、短い句には最低表示時間を保証する。
  const LINGER_SEC = 1.2;
  const MIN_READ_SEC = 1.6;
  // `- subtitle: off` の行(画面内テキストと重複)は字幕として描かないが、
  // 余韻の締切としては数える。除外してから次フレーズを探すと、その行を飛び越えて
  // 前行の字幕が残り、順位カード等の画面文字に重なる。
  const allPhrases = timing.lines
    .flatMap((line) =>
      line.phrases.map((phrase) => ({
        ...phrase,
        noSubtitle: Boolean(line.noSubtitle),
        speaker: line.speaker,
      }))
    )
    .sort((a, b) => a.startSec - b.startSec)
    .map((phrase, i, arr) => {
      const nextStart =
        i + 1 < arr.length ? arr[i + 1].startSec : Number.POSITIVE_INFINITY;
      const wantedEnd = Math.max(
        phrase.endSec + LINGER_SEC,
        phrase.startSec + MIN_READ_SEC
      );
      return { ...phrase, displayEndSec: Math.min(nextStart, wantedEnd) };
    })
    .filter((phrase) => !phrase.noSubtitle);
  const active = allPhrases.find(
    (phrase) => tSec >= phrase.startSec && tSec < phrase.displayEndSec
  );

  if (!active) {
    return null;
  }

  // 話者別の字幕文字色(2話者掛け合い)。speaker の無い行は undefined = 従来色
  const speakerAccent = active.speaker
    ? SPEAKER_STYLE[active.speaker]?.accent
    : undefined;

  if (isVertical) {
    // 縦型ショート専用: 垂直中央より少し下(中心が高さの約60%)・幅基準の大きめ文字。
    return (
      <AbsoluteFill style={{ zIndex: LAYER.subtitle }}>
        <div
          style={{
            position: "absolute",
            top: "60%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background: "rgba(27, 26, 23, 0.82)",
            color: speakerAccent ?? PALETTE.paper,
            fontSize: Math.round(width * 0.058),
            padding: "12px 30px",
            borderRadius: 14,
            fontFamily: `${fontFamily}, ${DOODLE_FONT_STACK}`,
            maxWidth: "88%",
            textAlign: "center",
            letterSpacing: "0.03em",
          }}
        >
          {active.displayText ?? active.text}
        </div>
      </AbsoluteFill>
    );
  }

  if (FRAME.subtitleVariant === "band") {
    // 帯様式: 下帯(LetterboxBars)の中に表示する。角丸ボックスは使わない(帯が背景)。
    // 最大2行・帯内に収める。
    const bandPct = FRAME.letterboxPct > 0 ? FRAME.letterboxPct : 0.12;
    return (
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          zIndex: LAYER.subtitle,
        }}
      >
        <div
          style={{
            height: `${bandPct * 100}%`,
            width: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div
            style={{
              color: speakerAccent ?? FRAME.subtitleColor ?? "#F2EFE6",
              fontSize: 44,
              lineHeight: 1.35,
              fontFamily:
                FRAME.subtitleFontFamily ?? `${fontFamily}, ${DOODLE_FONT_STACK}`,
              fontWeight: 500,
              maxWidth: "88%",
              textAlign: "center",
              letterSpacing: "0.06em",
              // 帯内に収める安全網: 2行を超える異常長の句は3行目以降を切る
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical" as const,
              overflow: "hidden",
            }}
          >
            {active.displayText ?? active.text}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  // 角丸ボックス様式(従来既定)
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 72,
        zIndex: LAYER.subtitle,
      }}
    >
      <div
        style={{
          background: "rgba(27, 26, 23, 0.82)",
          color: speakerAccent ?? PALETTE.paper,
          fontSize: 46,
          padding: "12px 30px",
          borderRadius: 14,
          fontFamily:
            FRAME.subtitleFontFamily ?? `${fontFamily}, ${DOODLE_FONT_STACK}`,
          maxWidth: "82%",
          textAlign: "center",
          letterSpacing: "0.03em",
        }}
      >
        {active.displayText ?? active.text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * bgmTracks 1区間ぶんの再生。フェードアウト/無音ギャップの音量計算は
 * Sequence相対フレーム(useCurrentFrame)で行う。<Audio loop> の volume
 * コールバック引数はループ1周ごとに0へリセットされるため、区間をまたぐ
 * フェード計算には使えない(実測で発覚した罠)。
 */
const BgmSegment: React.FC<{
  src: string;
  base: number;
  audibleEndF: number;
  fadeOutF: number;
}> = ({ src, base, audibleEndF, fadeOutF }) => {
  const f = useCurrentFrame();
  let v = 0;
  if (f < audibleEndF) {
    const vOut =
      fadeOutF > 0 ? Math.min(1, (audibleEndF - f) / fadeOutF) : 1;
    v = base * Math.max(0, vOut);
  }
  return <Audio src={src} volume={v} loop />;
};

export const Episode: React.FC<EpisodeProps> = ({
  episodeDir,
  shots,
  timing,
  library,
  narrationAvailable,
  debug = false,
}) => {
  const { fps, width, height } = useVideoConfig();
  // 縦型ショート(height > width)は従来の紙背景のまま一切変えない。
  // 横型のルート背景は FRAME_STYLE.rootBackground(未指定は紙背景)。
  const isVertical = height > width;

  if (!shots || !timing || !library) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "black",
          color: "white",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 32,
          fontFamily: "sans-serif",
          padding: 48,
          textAlign: "center",
        }}
      >
        shots.json / timing.json / library.json が読み込めませんでした ({episodeDir})
      </AbsoluteFill>
    );
  }

  const narrationSrc =
    narrationAvailable && shots.narration.file
      ? episodeAssetUrl(episodeDir, shots.narration.file)
      : undefined;

  // gainDb → Remotion volume(振幅比)。0dB=1.0
  const dbToVolume = (db: number | undefined) =>
    Math.pow(10, (db ?? 0) / 20);

  return (
    <AssetProvider library={library}>
      <AbsoluteFill
        style={{
          backgroundColor: isVertical
            ? PALETTE.paper
            : FRAME.rootBackground ?? PALETTE.paper,
        }}
      >
        {narrationSrc ? <Audio src={narrationSrc} /> : null}
        {shots.bgmTracks && shots.bgmTracks.length > 0 ? (
          // 章別BGM(bgmTracksはbgmより優先)。各区間内でループ再生。
          // 曲が切り替わる境界では「前曲フェードアウト → 約3秒の無音 →
          // 区間頭(=次章の頭)から次曲がフェードインなしで鳴る」。
          // 同一曲のゲイン変更(ダッキング)連結ではフェード・無音を入れない。
          // 最終区間は動画末尾に向けてフェードアウトのみ(無音ギャップなし)。
          (shots.bgmTracks.map((t, i) => {
            const BGM_FADE_SEC = 1.5; // フェードアウトの長さ
            const BGM_GAP_SEC = 3; // 曲切り替え前の無音の長さ
            const tracks = shots.bgmTracks!;
            const durF = Math.max(1, Math.round((t.endSec - t.startSec) * fps));
            const next = tracks[i + 1];
            const contiguousNext =
              next &&
              next.file === t.file &&
              Math.abs(t.endSec - next.startSec) < 0.05;
            // 次と地続きの同一曲: フェードなし / 曲が変わる: 無音ギャップあり /
            // 最終区間: ギャップなしで末尾フェードアウト
            const gapF =
              next && !contiguousNext
                ? Math.min(durF, Math.round(BGM_GAP_SEC * fps))
                : 0;
            const fadeOutF = contiguousNext
              ? 0
              : Math.min(durF - gapF, Math.round(BGM_FADE_SEC * fps));
            const audibleEndF = durF - gapF; // ここで音量0に到達し、以降は無音
            const base = dbToVolume(t.gainDb);
            return (
              <Sequence
                key={`bgm-${i}`}
                from={Math.round(t.startSec * fps)}
                durationInFrames={durF}
                name={`bgm:${t.file}`}>
                <BgmSegment
                  src={staticFile(`assets/${t.file}`)}
                  base={base}
                  audibleEndF={audibleEndF}
                  fadeOutF={fadeOutF}
                />
              </Sequence>
            );
          }))
        ) : shots.bgm ? (
          <Audio
            src={staticFile(`assets/${shots.bgm.file}`)}
            volume={dbToVolume(shots.bgm.gainDb)}
            loop
          />
        ) : null}
        {/* シーン層: isolation:isolate で独立したスタック文脈に閉じ込める。
            シーン側が内部で zIndex を使っても、この層より前面(=字幕・黒帯)には出られない */}
        <AbsoluteFill style={{ zIndex: LAYER.scenes, isolation: "isolate" }}>
          {shots.shots.map((shot, i) => {
            // 秒→フレームの丸めを start/end 独立に行うと連続ショット間に
            // 1フレームの穴が空き、ルート背景(紙)が露出して白フラッシュになる。
            // 各ショットの終端は「次ショットの開始フレーム」に必ず接続する。
            const from = Math.round(shot.startSec * fps);
            const next = shots.shots[i + 1];
            const endF = next
              ? Math.round(next.startSec * fps)
              : Math.round(shot.endSec * fps);
            const durationInFrames = Math.max(1, endF - from);
            return (
              <Sequence
                key={shot.shotId}
                from={from}
                durationInFrames={durationInFrames}
                name={shot.shotId}
              >
                <ShotRenderer shot={shot} debug={debug} />
                {(shot.sfx ?? []).map((s, i) => (
                  // atSec はショット開始からの相対秒。cue は assets/audio/se/ のファイル名
                  (<Sequence
                    key={`${shot.shotId}-sfx-${i}`}
                    from={Math.round(s.atSec * fps)}
                    name={`sfx:${s.cue}`}
                  >
                    <Audio
                      src={staticFile(`assets/audio/se/${s.cue}`)}
                      // SEはgainDb未指定だと0dB=フル音量でナレーションより目立つため、
                      // 既定を-9dBに下げる(明示指定があればそちらを使う)
                      volume={dbToVolume(s.gainDb ?? -9)}
                    />
                  </Sequence>)
                ))}
              </Sequence>
            );
          })}
        </AbsoluteFill>
        {/* 立ち絵+口パク(SPEAKER_STANDS チャンネル・横型のみ。縦型ショートは非表示) */}
        {SPEAKER_STANDS_ENABLED && !isVertical ? (
          <SpeakerStandsLayer timing={timing} zIndex={LAYER.stands} />
        ) : null}
        {/* 上下黒帯(FRAME_STYLE準拠・横型のみ)→ その上に字幕(帯様式なら下帯の中に載る) */}
        <LetterboxBars />
        <SubtitleLayer timing={timing} />
      </AbsoluteFill>
    </AssetProvider>
  );
};
