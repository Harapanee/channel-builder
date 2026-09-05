/**
 * H3経路の audio-cues.json を composition.html 無しで作る(工程8.4の入力づくり)。
 *
 * なぜ別スクリプトなのか:
 *   `src/pipeline/build-audio-cues.ts` は SE台帳を composition の `window.__G<n>_SE_CUES`
 *   から抜く設計なので `composition.html` を必須にしており、無いと
 *   「composition.html がありません(HF経路専用です)」で止まる。**HF実装を持たない新規の
 *   H3エピソードでは master.mp3 が焼けず、h3:assemble がそこで止まる。**
 *   build-audio-cues.ts / audio-mix.ts はテンプレート同期区分 HF_IDENTICAL(バイト一致必須)
 *   で改変できないが、`audio-mix.ts` は audio-cues.json を消費するだけで composition への
 *   `<audio src>` 差し替えは「存在するときだけ」の条件付き処理である。だから
 *   **cues をこちらで作れば、既存の audio-mix がそのまま使える。**
 *
 * H3経路の音:
 *   ナレーション(VOICEVOX)+ BGM に加え、MiniMax が同時生成する音は捨てない。
 *   `npm run h3:ambient` が環境音トラック(narration/ambient.wav)へまとめ、組み立ての最終muxで
 *   master.mp3 の下に敷く。ここが作る audio-cues.json の **SE は空のまま**である
 *   (環境音は audio-mix を通さない — audio-mix はテンプレート同期でバイト一致必須で改変できない
 *   うえ、SEを1本ずつ -22 LUFS へ正規化する設計のため、静かな環境音を通すと持ち上がって鳴り
 *   続けてしまう)。SEが無いので `seLedgerHash` も書かない(空台帳のハッシュを書くと
 *   check:audio が「突合できた」ように見えてしまう。H3経路では check:audio を走らせない)。
 *
 * BGMの計算は HF経路と同一である:
 *   包絡線 × 曲の割り当て(bgm-plan.json)からの生成は `build-bgm-cues.ts` の
 *   `buildBgmCues` をそのまま呼ぶ。契約検査も `validateBgmPlan` と JSON Schema で同じ。
 *   違いは総尺の出どころだけで、HFは composition の data-duration、H3は timing.json の
 *   totalDurationSec を使う(ep015-salmon では両者とも 974.935 で一致する)。
 *
 * 使い方:
 *   npm run h3:audio-cues -- <epId> [--out <ファイル名>] [--dry-run] [--force]
 *   → episodes/<epId>/audio-cues.json を書き、次は npm run audio-mix episodes/<epId>
 *
 * exit: 0 = OK / 1 = 契約違反 / 2 = 実行エラー
 */
import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AudioCue, AudioCues } from "../audio-mix";
import {
  buildBgmCues,
  expandEnvelope,
  silentGaps,
  validateBgmPlan,
  validateBgmPolicy,
  type BgmPlan,
  type BgmPolicy,
  type TrackLengths,
} from "../build-bgm-cues";
import { ROOT } from "./config";
import type { TimingLine } from "./plan";

export type { BgmPlan, TrackLengths };

/**
 * 計画が総尺より後ろへはみ出してよい猶予(秒)。
 *
 * なぜゼロにしないか: bgm-plan.json の秒は storyboard から写した丸めた値で、末尾は
 * 総尺をわずかに越えるのが普通である(ep015-salmon は assignment/envelope が 974.94、
 * timing の総尺は 974.935 で 0.005 秒の超過)。audio-mix は `-t <総尺>` で切るので
 * この程度の超過は無害。一方で桁違いのはみ出しは「別の timing.json 用の計画を当てている」
 * ことを意味するので、そこは黙って通さない。
 *
 * 実証されている必要量は ep015-salmon の 0.005秒なので、猶予はその10倍で足りる。
 * 広く取るほど取り違えの検出が鈍る。
 */
export const OVER_TOLERANCE_SEC = 0.05;

/** 計画が総尺を大きくはみ出していないか(はみ出しは計画とtimingの取り違え) */
function overrunErrors(plan: BgmPlan, total: number): string[] {
  const errors: string[] = [];
  const ends = (segs: Array<[number, number, unknown]>): number =>
    segs.length === 0 ? 0 : Math.max(...segs.map((s) => s[1]));
  const asgEnd = ends(plan.assignment ?? []);
  if (asgEnd > total + OVER_TOLERANCE_SEC) {
    errors.push(`assignment が総尺を超えています: ${asgEnd.toFixed(3)}s > 総尺 ${total.toFixed(3)}s`);
  }
  const envEnd = ends(expandEnvelope(plan.envelope ?? []));
  if (envEnd > total + OVER_TOLERANCE_SEC) {
    errors.push(`envelope が総尺を超えています: ${envEnd.toFixed(3)}s > 総尺 ${total.toFixed(3)}s`);
  }
  return errors;
}

/**
 * audio-cues.json の中身を組む(純粋関数 — ファイルは読み書きしない)。
 *
 * `lengths` は曲キー → 実尺(秒)。HF経路と同じく ffprobe の実測値を CLI が渡す
 * (曲の尺を計画に手書きさせないため)。
 */
export function buildCues(
  epId: string,
  lines: TimingLine[],
  totalDurationSec: number,
  plan: BgmPlan,
  lengths: TrackLengths,
  policy?: BgmPolicy,
): AudioCues {
  if (lines.length === 0) throw new Error("timing.json に台本行がありません(先に npm run tts)");
  /* 総尺は小数3桁へ丸める。audio-mix が `-t <total.toFixed(3)>` で切るので実効値は同じで、
     HF経路が composition の data-duration(3桁)から書く値とも一致する */
  const total = Number(totalDurationSec.toFixed(3));
  const lastEnd = Math.max(...lines.map((l) => l.endSec));
  if (lastEnd > total + 1e-6) {
    throw new Error(
      `ナレーションが総尺を超えています: ${lastEnd.toFixed(3)}s > 総尺 ${total.toFixed(3)}s`
    );
  }
  /* 形(JSON Schema)は CLI 側。ここは意味(隙間・重なり・未知の曲キー・はみ出し)を見る */
  const errors = [...validateBgmPlan(plan, total), ...overrunErrors(plan, total), ...validateBgmPolicy(plan, policy ?? {})];
  if (errors.length > 0) throw new Error(`bgm-plan.json の契約違反:\n  - ${errors.join("\n  - ")}`);

  const bgm: AudioCue[] = buildBgmCues(plan, lengths);
  return {
    total,
    narration: `episodes/${epId}/narration/narration.wav`,
    bgm,
    se: [],
  };
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/**
 * SE の宣言(episodes/<epId>/se-plan.json)。**H3経路にはSE台帳の出どころが無い**
 * (HF経路は composition の `window.__G<n>_SE_CUES` から作るが、H3に composition は無い)。
 * そこで storyboard の「SE設計」節+clip表のSE列を、bgm-plan.json と同じ立て付けの
 * 宣言ファイルへ落として読む。音量は 1.0 で出し、素材ごとの -22 LUFS 正規化は
 * 従来どおり audio-mix が行う(ここで音量を決め打たない)。
 *
 * 形: { "se": [ { "clipId": "cL001", "start": 0.0, "src": "assets/audio/se/pop.mp3" } ] }
 */
export type SePlan = { se?: { clipId?: string; start: number; src: string }[] };

export function buildSeCues(plan: SePlan, total: number, exists: (rel: string) => boolean): AudioCue[] {
  const items = [...(plan.se ?? [])].sort((a, b) => a.start - b.start);
  const errors: string[] = [];
  const cues: AudioCue[] = items.map((it, i) => {
    if (!(it.start >= 0) || it.start > total) {
      errors.push(`${it.clipId ?? i} の start ${it.start} が 0〜${total.toFixed(3)}s の外です`);
    }
    if (!exists(it.src)) errors.push(`${it.clipId ?? i} の音源がありません: ${it.src}`);
    return { id: `se-${it.clipId ?? i}-${i}`, src: it.src, start: it.start, volume: 1 };
  });
  if (errors.length > 0) throw new Error(`se-plan.json の契約違反:\n  - ${errors.join("\n  - ")}`);
  return cues;
}

/** チャンネルの BGM 方針(channel/bgm-policy.json)。無ければ方針なし */
export function readBgmPolicy(): BgmPolicy {
  const p = path.join(ROOT, "channel", "bgm-policy.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BgmPolicy) : {};
}

/** bgm-plan.json の形を契約(JSON Schema)で検証する(HF経路と同じ) */
function schemaErrors(plan: unknown): string[] {
  const schemaPath = path.join(ROOT, "src", "schemas", "bgm-plan.schema.json");
  if (!existsSync(schemaPath)) return [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (validate(plan)) return [];
  return (validate.errors ?? []).map((e) => `bgm-plan.json${e.instancePath}: ${e.message}`);
}

/** 音源の実尺(秒)。曲の尺を計画に手書きさせないため、ここで実測する(HF経路と同じ) */
function probeDurationSec(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  const n = Number((r.stdout ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`音源の尺を測れません: ${file}`);
  return n;
}

function main(): void {
  const args = process.argv.slice(2);
  const epArg = args.find((a) => !a.startsWith("--"));
  if (!epArg) {
    fail("使い方: npm run h3:audio-cues -- <epId> [--out <ファイル名>] [--dry-run] [--force]");
  }
  const epId = epArg.replace(/^episodes\//, "").replace(/\/+$/, "");
  const epDir = path.join(ROOT, "episodes", epId);
  if (!existsSync(epDir)) fail(`エピソードがありません: ${path.relative(ROOT, epDir)}`);

  const timingPath = path.join(epDir, "timing.json");
  if (!existsSync(timingPath)) fail(`timing.json がありません(先に npm run tts): ${timingPath}`);
  const timing = JSON.parse(readFileSync(timingPath, "utf8")) as {
    totalDurationSec: number;
    lines: TimingLine[];
  };

  const planPath = path.join(epDir, "bgm-plan.json");
  if (!existsSync(planPath)) {
    fail(
      `bgm-plan.json がありません: ${path.relative(ROOT, planPath)}\n` +
        "  BGMの敷き方(storyboard の「BGM」節)の機械可読版を先に書いてください(工程8.4-1)"
    );
  }
  const plan: BgmPlan = JSON.parse(readFileSync(planPath, "utf8"));
  const shapeErrors = schemaErrors(plan);
  if (shapeErrors.length > 0) {
    console.error(`NG: bgm-plan.json の契約違反:\n  - ${shapeErrors.join("\n  - ")}`);
    process.exit(1);
  }

  const lengths: TrackLengths = {};
  for (const [key, t] of Object.entries(plan.tracks ?? {})) {
    const abs = path.join(ROOT, t.src);
    if (!existsSync(abs)) fail(`bgm-plan.json の音源がありません: ${t.src}`);
    lengths[key] = probeDurationSec(abs);
  }

  let cues: AudioCues;
  try {
    cues = buildCues(epId, timing.lines, timing.totalDurationSec, plan, lengths, readBgmPolicy());
  } catch (e) {
    console.error(`NG: ${(e as Error).message}`);
    process.exit(1);
  }

  /* SEの宣言があれば載せる。無ければ従来どおり SE 0件(環境音だけ) */
  let seCount = 0;
  const sePlanPath = path.join(epDir, "se-plan.json");
  if (existsSync(sePlanPath)) {
    const rawSe = readFileSync(sePlanPath, "utf8");
    try {
      cues.se = buildSeCues(JSON.parse(rawSe) as SePlan, cues.total, (rel) =>
        existsSync(path.join(ROOT, rel)),
      );
    } catch (e) {
      console.error(`NG: ${(e as Error).message}`);
      process.exit(1);
    }
    seCount = cues.se.length;
    /* 焼き直し漏れを後から突合できるように宣言の内容ハッシュを残す。
       HF経路の `seLedgerHash` とは別名にする — 同名にすると上書き保護が自分自身を弾く */
    (cues as AudioCues & { sePlanHash?: string }).sePlanHash = createHash("sha256")
      .update(rawSe)
      .digest("hex")
      .slice(0, 16);
  }

  if (!existsSync(path.join(ROOT, cues.narration))) {
    fail(`ナレーション音源がありません: ${cues.narration}(先に npm run tts)`);
  }

  const outArg = args.indexOf("--out");
  const outName = outArg >= 0 ? args[outArg + 1] : "audio-cues.json";
  if (!outName || outName.startsWith("--")) fail("--out にはファイル名が要ります");
  const outPath = path.join(epDir, outName);

  /* 既存の cues が **HF経路の産物なら** 上書きしない(ep015-salmon はHF実装とH3が同居している)。
     判定は `seLedgerHash` の有無で行う — SE件数で見ると、SEが0件のHFエピソードや、
     ハッシュだけ持つ cues を黙って潰してしまう。H3が作った cues(ハッシュ無し)の
     焼き直しは素通しでよい */
  if (existsSync(outPath) && !args.includes("--force")) {
    const prev = JSON.parse(readFileSync(outPath, "utf8")) as Partial<AudioCues>;
    if ("seLedgerHash" in prev) {
      fail(
        `${path.relative(ROOT, outPath)} はHF経路(npm run audio-cues)が作ったものです(seLedgerHash がある)。` +
          `H3経路のcuesはSEを持たないので、上書きすると SE ${(prev.se ?? []).length}件とその台帳ハッシュが消えます。` +
          "--out で別名にするか、承知のうえなら --force"
      );
    }
  }

  console.log(
    `BGM ${cues.bgm.length}区間(bgm-plan.json から生成)/ SE ${seCount}件` +
      (seCount === 0
        ? `(se-plan.json が無いのでSEなし。生成クリップの音は npm run h3:ambient が ambient.wav へまとめます)`
        : `(se-plan.json から生成。生成クリップの音は別トラックの ambient.wav)`)
  );
  for (const [a, b] of silentGaps(expandEnvelope(plan.envelope), cues.total)) {
    console.log(`  BGM完全停止: ${a.toFixed(3)}–${b.toFixed(3)}s`);
  }
  if (cues.bgm.length === 0) {
    console.error(
      "WARN: BGM が0区間です。包絡線(envelope)が全時間帯を覆っていないと BGM は鳴りません"
    );
  }

  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(cues, null, 1));
    return;
  }
  writeFileSync(outPath, JSON.stringify(cues, null, 1) + "\n");
  console.log(
    `OK: ${path.relative(ROOT, outPath)} — 次は npm run audio-mix episodes/${epId}` +
      (outName === "audio-cues.json" ? "" : `(audio-mix が読むのは audio-cues.json だけ)`)
  );
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "build-audio-cues-h3.ts") main();
