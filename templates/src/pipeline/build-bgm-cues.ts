/**
 * BGMキューを「包絡線 × 曲の割り当て」の宣言(bgm-plan.json)から機械生成する。
 *
 * なぜ契約にするか:
 *   BGMの敷き方は storyboard の散文が正本で、SEのように実装から機械抽出はできない。
 *   そのため毎回**使い捨ての生成器**が書かれてきた(ep011 `.audio-build.py` →
 *   ep012 `build-audio-cues.mjs` → 2026-08-01 `tools/rebuild-bgm-cues.mjs`)。
 *   「基調曲を差し替えたい」のような後からの指示が来るたびに、停止帯・-6dB・フェードといった
 *   **設計済みの包絡線を人が写し直す**ことになり、写し間違いが音の事故に直結する。
 *   包絡線(envelope)と曲の割り当て(assignment)を分離して宣言に落とせば、
 *   曲を替える指示は assignment の1行書き換えで済む。
 *
 * 契約(episodes/<epId>/bgm-plan.json):
 *   baseVolume  BGMの基準音量(ナレーションの下に敷く床)
 *   tracks      キー → { src }(尺は ffprobe で実測するので書かない)
 *   envelope    時刻ごとの音量倍率。**覆っていない時間帯 = BGM完全停止**
 *                 [start, end, gain] か
 *                 { start, gain: [g0, g1], steps, stepSec }(直線フェード)
 *   assignment  [start, end, trackKey] の並び。全尺を隙間なく覆うこと
 *   crossfade   曲の切り替え境界に挟む段(既定 0.4秒×2段)。
 *               ただし境界の前後が停止帯のときは挟まない(無音からの復帰はカット・イン)
 */

/** クロスフェードの既定(ep012/ep013 の実装と同じ 0.4秒×2段) */
export const DEFAULT_CROSSFADE = { stepSec: 0.4, out: [0.5625, 0.1875], in: [0.1875, 0.5625] };

export type EnvelopeSegment =
  | [number, number, number]
  | { start: number; gain: [number, number]; steps: number; stepSec: number };

export interface BgmPlan {
  baseVolume: number;
  tracks: Record<string, { src: string }>;
  envelope: EnvelopeSegment[];
  assignment: Array<[number, number, string]>;
  crossfade?: { stepSec: number; out: number[]; in: number[] };
}

/** 素材の実尺(秒)。CLI が ffprobe で埋める */
export type TrackLengths = Record<string, number>;

export interface BgmCue {
  id: string;
  src: string;
  start: number;
  volume: number;
  duration: number;
  mediaStart: number;
}

/** フェード宣言を [start, end, gain] の並びへ展開する(純粋関数) */
export function expandEnvelope(envelope: EnvelopeSegment[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const seg of envelope) {
    if (Array.isArray(seg)) {
      out.push(seg);
      continue;
    }
    const { start, gain: [g0, g1], steps, stepSec } = seg;
    if (steps < 2) throw new Error("フェードは steps >= 2 が必要です");
    for (let k = 0; k < steps; k++) {
      const g = g0 + ((g1 - g0) * k) / (steps - 1);
      out.push([start + k * stepSec, start + (k + 1) * stepSec, Number(g.toFixed(4))]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 時刻 t の音量倍率。包絡線が覆っていなければ 0(= 完全停止) */
export function envGainAt(env: Array<[number, number, number]>, t: number): number {
  const seg = env.find(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);
  return seg ? seg[2] : 0;
}

/** 包絡線が覆っていない=BGMが完全に止まる区間(検算・報告用) */
export function silentGaps(
  env: Array<[number, number, number]>,
  totalSec: number
): Array<[number, number]> {
  const sorted = [...env].sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of sorted) {
    if (a > cursor + 1e-6) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < totalSec - 1e-6) gaps.push([cursor, totalSec]);
  return gaps;
}

/**
 * 計画から BGM キュー配列を組む(純粋関数)。
 *
 * ミックス側にフェード機能は無いので、包絡線は区間ごとの volume で階段状に再現する。
 * 素材内の再生位置(mediaStart)を連続させるので波形は途切れない。停止帯をまたいだら頭出しへ戻す。
 */
export function buildBgmCues(plan: BgmPlan, lengths: TrackLengths): BgmCue[] {
  const env = expandEnvelope(plan.envelope);
  const xf = plan.crossfade ?? DEFAULT_CROSSFADE;
  const xfLen = xf.stepSec * xf.out.length;

  /** 曲の切り替え境界にクロスフェードを挟んでよいか(無音明け・無音直前は挟まない) */
  const canCrossfade = (t: number): boolean =>
    envGainAt(env, t - 0.01) > 0 && envGainAt(env, t) > 0 && envGainAt(env, t + xfLen - 0.01) > 0;

  /* 帯を作る: 曲が変わる境界に、入り(xfIn)と出(tail)のクロスフェードを付ける */
  const bands = plan.assignment.map(([from, to, key], i) => {
    const prev = plan.assignment[i - 1];
    const next = plan.assignment[i + 1];
    const xfIn = !!prev && prev[2] !== key && canCrossfade(from);
    const tail = !!next && next[2] !== key && canCrossfade(to);
    return { from, to, key, xfIn, tail, end: tail ? to + xfLen : to };
  });

  /**
   * 帯の中の、クロスフェードによる音量倍率。
   * 段の番号は 1e-6 を足してから floor する — 足し算の誤差で 0.4秒目が 0.3999… になり、
   * 2段目が1段目に落ちてクロスフェードが片側だけ進む事故を防ぐ。
   */
  const bandMult = (band: (typeof bands)[number], t: number): number => {
    const step = (t0: number) => Math.floor((t - t0) / xf.stepSec + 1e-6);
    if (band.xfIn && t < band.from + xfLen - 1e-6) return xf.in[step(band.from)];
    if (band.tail && t >= band.to - 1e-6) return xf.out[step(band.to)];
    return 1;
  };

  /** 次に音量が変わりうる時刻(包絡線の折れ点・クロスフェードの段・帯の端) */
  const nextBreak = (band: (typeof bands)[number], t: number): number => {
    const cands = [band.end];
    for (const [a, b] of env) {
      if (a > t + 1e-9) cands.push(a);
      if (b > t + 1e-9) cands.push(b);
    }
    if (band.xfIn) for (let k = 1; k <= xf.in.length; k++) cands.push(band.from + k * xf.stepSec);
    if (band.tail) for (let k = 0; k <= xf.out.length; k++) cands.push(band.to + k * xf.stepSec);
    return Math.min(...cands.filter((x) => x > t + 1e-9));
  };

  const cues: BgmCue[] = [];
  for (const band of bands) {
    const track = plan.tracks[band.key];
    if (!track) throw new Error(`assignment が知らない曲キーを指しています: ${band.key}`);
    const len = lengths[band.key];
    if (!len || !Number.isFinite(len)) throw new Error(`曲の実尺が取れていません: ${band.key}`);
    let media = 0; // 素材内の再生位置。停止帯をまたいだら頭出しへ戻す
    let t = band.from;
    while (t < band.end - 1e-6) {
      const brk = Math.min(nextBreak(band, t), band.end);
      const gain = envGainAt(env, t) * bandMult(band, t);
      if (gain <= 0) {
        media = 0; // 停止帯。鳴らさず、明けたら曲の頭から
        t = brk;
        continue;
      }
      let cur = t;
      while (cur < brk - 1e-6) {
        if (media >= len - 1e-6) media = 0; // ループ
        const dur = Math.min(brk - cur, len - media);
        cues.push({
          id: `bgm-${cues.length}`,
          src: track.src,
          start: Number(cur.toFixed(3)),
          volume: Number((plan.baseVolume * gain).toFixed(4)),
          duration: Number(dur.toFixed(3)),
          mediaStart: Number(media.toFixed(3)),
        });
        cur += dur;
        media += dur;
      }
      t = brk;
    }
  }
  cues.sort((a, b) => a.start - b.start);
  cues.forEach((c, i) => (c.id = `bgm-${i}`));
  return cues;
}

/** 計画の自己検査(契約違反を先に潰す) */
export function validateBgmPlan(plan: BgmPlan, totalSec: number): string[] {
  const errors: string[] = [];
  if (!(plan.baseVolume > 0)) errors.push("baseVolume が正の数ではありません");
  const keys = new Set(Object.keys(plan.tracks ?? {}));
  if (keys.size === 0) errors.push("tracks が空です");

  const asg = [...(plan.assignment ?? [])].sort((a, b) => a[0] - b[0]);
  if (asg.length === 0) errors.push("assignment が空です");
  for (const [, , key] of asg) {
    if (!keys.has(key)) errors.push(`assignment が知らない曲キーを指しています: ${key}`);
  }
  /* 割り当ては全尺を隙間なく覆うこと(覆い漏れは「その区間だけ無音」になる) */
  let cursor = 0;
  for (const [a, b] of asg) {
    if (a > cursor + 1e-3) errors.push(`assignment に隙間: ${cursor.toFixed(3)}–${a.toFixed(3)}s`);
    if (a < cursor - 1e-3) errors.push(`assignment が重複: ${a.toFixed(3)}s`);
    cursor = Math.max(cursor, b);
  }
  if (cursor < totalSec - 1e-2) {
    errors.push(`assignment が末尾を覆っていません: ${cursor.toFixed(3)}–${totalSec.toFixed(3)}s`);
  }

  /* 包絡線は重なってはいけない(重なると envGainAt が先勝ちで黙って片方を捨てる) */
  const env = expandEnvelope(plan.envelope ?? []);
  for (let i = 1; i < env.length; i++) {
    if (env[i][0] < env[i - 1][1] - 1e-6) {
      errors.push(`envelope が重複: ${env[i - 1].join(",")} と ${env[i].join(",")}`);
    }
  }
  return errors;
}

/**
 * チャンネルの BGM 方針(`channel/bgm-policy.json`)。**2026-09-05 に追加。**
 * ep012〜ep026 の15本すべてが冒頭 wafu(太鼓)で始まる慣行だったが、どこにも明文化されておらず
 * ep027 で tense 始まりにして視聴者に即座に気づかれ、組み立て直しが1回発生した。
 * 教義は bible §11、機械契約はこのファイル。audio-cues を組む前に検査する。
 */
export interface BgmPolicy {
  /** 冒頭(assignment の先頭)に置く曲キー */
  openingTrack?: string;
  /** baseVolume の許容範囲(過去の実績値) */
  baseVolume?: { min: number; max: number };
}

export function validateBgmPolicy(plan: BgmPlan, policy: BgmPolicy): string[] {
  const errors: string[] = [];
  if (policy.openingTrack) {
    const first = [...(plan.assignment ?? [])].sort((a, b) => a[0] - b[0])[0];
    if (first && first[2] !== policy.openingTrack) {
      errors.push(`冒頭の曲が ${first[2]}(方針は ${policy.openingTrack}。チャンネルの署名。bible §11 / channel/bgm-policy.json)`);
    }
  }
  if (policy.baseVolume && Number.isFinite(plan.baseVolume)) {
    const { min, max } = policy.baseVolume;
    if (plan.baseVolume < min || plan.baseVolume > max) {
      errors.push(`baseVolume ${plan.baseVolume} が方針の範囲 ${min}〜${max} の外(channel/bgm-policy.json)`);
    }
  }
  return errors;
}
