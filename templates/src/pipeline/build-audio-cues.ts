/**
 * audio-cues.json を composition の SE台帳から機械生成する(工程8.4の入力づくり)。
 *
 * なぜ要るか:
 *   ep012 は SE 71件 + BGM 18区間の audio-cues.json を人手で書いていた(ep011 は
 *   `.audio-build.py`、ep012 は `build-audio-cues.mjs` という使い捨てを毎回作り直している)。
 *   SEの正本は storyboard の「SE」列であり、その実装は scene-implementer が
 *   `window.__G<n>_SE_CUES` に機械可読で出している。だから**人が書き写す必要はない**。
 *   書き写しはトークンを食うだけでなく、時刻ずれ・取りこぼしという事故の温床でもある。
 *
 * BGMについて(2026-08-02):
 *   BGMの包絡線は storyboard の散文が正本で実装からは抽出できないが、**宣言には落とせる**。
 *   `episodes/<epId>/bgm-plan.json`(包絡線 × 曲の割り当て)から build-bgm-cues が生成する。
 *   これが無い ep は既存 audio-cues.json の bgm 配列を引き継ぐ(後方互換)。
 *   計画も既存も無ければ空になり、check-audio の no_bed で止まる。
 *
 * 使い方:
 *   npx tsx src/pipeline/build-audio-cues.ts episodes/<epId> [--bgm <bgm配列のJSON>] [--dry-run]
 *
 * exit: 0 = OK / 1 = 素材が見つからない等の契約違反 / 2 = 実行エラー
 */
import Ajv from "ajv";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AudioCue, AudioCues } from "./audio-mix";
import {
  buildBgmCues,
  expandEnvelope,
  silentGaps,
  validateBgmPlan,
  type BgmPlan,
} from "./build-bgm-cues";

export type SeLedgerEntry = { clip: string; t: number; se: string };

/**
 * composition.html の `window.__G<n>_SE_CUES = [ { clip, t, se }, ... ]` を全グループぶん読む。
 * JSではなくテキストとして読むのは、composition を実行せずに済ませるため(ブラウザ不要)。
 */
export function parseSeLedgers(html: string): SeLedgerEntry[] {
  const out: SeLedgerEntry[] = [];
  for (const m of html.matchAll(/window\.__G\w*_SE_CUES\s*=\s*\[([\s\S]*?)\]\s*;/g)) {
    for (const e of m[1].matchAll(
      /\{\s*clip\s*:\s*["']([^"']+)["']\s*,\s*t\s*:\s*([\d.]+)\s*,\s*se\s*:\s*["']([^"']+)["']/g
    )) {
      out.push({ clip: e[1], t: Number(e[2]), se: e[3] });
    }
  }
  return out.sort((a, b) => a.t - b.t || a.clip.localeCompare(b.clip));
}

/**
 * SE台帳の内容ハッシュ。audio-cues.json に埋め、check-audio がレンダー前に突合する。
 *
 * なぜ要るか: 焼き直し漏れの検査は「cues より master が新しいか」しか見ておらず、
 * **ミックス後に実装側でSEを足したり時刻を動かしたりしても全部緑**だった。
 * SEの正本は composition の `window.__G<n>_SE_CUES` なので、そこから直接測る。
 */
export function seLedgerHash(entries: SeLedgerEntry[]): string {
  const canon = [...entries]
    .sort((a, b) => a.t - b.t || a.clip.localeCompare(b.clip) || a.se.localeCompare(b.se))
    .map((e) => `${e.clip}@${e.t.toFixed(3)}:${e.se}`)
    .join("|");
  return createHash("sha1").update(canon).digest("hex").slice(0, 16);
}

/** composition.html から直接 SE台帳ハッシュを求める */
export function seLedgerHashOf(html: string): string {
  return seLedgerHash(parseSeLedgers(html));
}

/** SE名(台帳の `se` 値)から実ファイルの相対パスを引く表を作る */
export function indexAudioFiles(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    const key = path.basename(f).replace(/\.[^.]+$/, "");
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

/** 台帳 + 素材表から SE キューを組む(純粋関数) */
export function buildSeCues(
  ledger: SeLedgerEntry[],
  index: Map<string, string>
): { cues: AudioCue[]; missing: string[] } {
  const cues: AudioCue[] = [];
  const missing: string[] = [];
  ledger.forEach((e, i) => {
    const src = index.get(e.se);
    if (!src) {
      if (!missing.includes(e.se)) missing.push(e.se);
      return;
    }
    /* volume は audio-mix の normalizeSeGain が素材の実測ラウドネスから決める。
       ここでは 1.0 を置くだけにして、二重に音量設計をしない */
    cues.push({ id: `se-${e.clip}-${i}`, src, start: e.t, volume: 1.0 });
  });
  return { cues, missing };
}

/** composition のルート要素から総尺を読む */
export function readTotalDuration(html: string): number {
  const rootTag = html.match(/<[^<>]*\bdata-composition-id="[^"]+"[^<>]*>/)?.[0];
  const dur = rootTag?.match(/\bdata-duration="([\d.]+)"/)?.[1];
  if (!dur) throw new Error("composition のルート要素から data-duration を読めません");
  return Number(dur);
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/** bgm-plan.json の形を契約(JSON Schema)で検証する */
function schemaErrors(plan: unknown): string[] {
  const schemaPath = path.join(process.cwd(), "src", "schemas", "bgm-plan.schema.json");
  if (!existsSync(schemaPath)) return [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (validate(plan)) return [];
  return (validate.errors ?? []).map((e) => `bgm-plan.json${e.instancePath}: ${e.message}`);
}

/** 音源の実尺(秒)。曲の尺を計画に手書きさせないため、ここで実測する */
function probeDurationSec(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  const n = Number((r.stdout ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`音源の尺を測れません: ${file}`);
  return n;
}

/** assets/audio 配下の音源を再帰的に集める(プロジェクトルート基準の相対パス) */
function listAudioFiles(root: string): string[] {
  const base = path.join(root, "assets", "audio");
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(mp3|wav|m4a|ogg)$/i.test(entry.name)) out.push(path.relative(root, p));
    }
  };
  walk(base);
  return out.sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const epArg = args.find((a) => !a.startsWith("--"));
  if (!epArg) fail("使い方: npx tsx src/pipeline/build-audio-cues.ts episodes/<epId> [--bgm <json>] [--dry-run]");
  const root = process.cwd();
  const epDir = path.resolve(root, epArg);
  const compositionPath = path.join(epDir, "composition.html");
  if (!existsSync(compositionPath)) fail("composition.html がありません(HF経路専用です)");

  const html = readFileSync(compositionPath, "utf8");
  const ledger = parseSeLedgers(html);
  if (ledger.length === 0) {
    console.error(
      "WARN: composition に window.__G<n>_SE_CUES がありません。" +
        "SEの台帳は scene-implementer が出す約束です(storyboard の SE列が正本)。" +
        "台帳が無いと、この工程はSEを1件も起こせません"
    );
  }

  const index = indexAudioFiles(listAudioFiles(root));
  const { cues, missing } = buildSeCues(ledger, index);

  const cuesPath = path.join(epDir, "audio-cues.json");
  const prev: Partial<AudioCues> = existsSync(cuesPath)
    ? JSON.parse(readFileSync(cuesPath, "utf8"))
    : {};

  /* BGM: bgm-plan.json(包絡線 × 曲の割り当ての宣言)があればそこから機械生成する。
     無ければ既存 cues の bgm を引き継ぐ(--bgm で明示指定も可) */
  const bgmArg = args.indexOf("--bgm");
  const planPath = path.join(epDir, "bgm-plan.json");
  let bgm: AudioCue[];
  let bgmSource: string;
  if (bgmArg >= 0) {
    bgm = JSON.parse(readFileSync(args[bgmArg + 1], "utf8"));
    bgmSource = "--bgm で指定";
  } else if (existsSync(planPath)) {
    const plan: BgmPlan = JSON.parse(readFileSync(planPath, "utf8"));
    const total = readTotalDuration(html);
    /* 形は JSON Schema、意味(隙間・重なり・未知の曲キー)は validateBgmPlan で見る */
    const errors = [...schemaErrors(plan), ...validateBgmPlan(plan, total)];
    if (errors.length > 0) {
      console.error(`NG: bgm-plan.json の契約違反:\n  - ${errors.join("\n  - ")}`);
      process.exit(1);
    }
    const lengths: Record<string, number> = {};
    for (const [key, t] of Object.entries(plan.tracks)) {
      if (!existsSync(path.join(root, t.src))) fail(`bgm-plan.json の音源がありません: ${t.src}`);
      lengths[key] = probeDurationSec(path.join(root, t.src));
    }
    bgm = buildBgmCues(plan, lengths) as unknown as AudioCue[];
    bgmSource = "bgm-plan.json から生成";
    for (const [a, b] of silentGaps(expandEnvelope(plan.envelope), total)) {
      console.log(`  BGM完全停止: ${a.toFixed(3)}–${b.toFixed(3)}s`);
    }
  } else {
    bgm = prev.bgm ?? [];
    bgmSource = prev.bgm ? "既存 audio-cues.json から引き継ぎ" : "無し";
  }

  const narration = ["narration/narration.wav", "narration/narration.mp3"]
    .map((p) => path.join(path.relative(root, epDir), p))
    .find((p) => existsSync(path.join(root, p)));
  if (!narration) fail(`${epArg}/narration/ にナレーション音源がありません(先に npm run tts)`);

  const out: AudioCues = {
    total: readTotalDuration(html),
    narration,
    bgm,
    se: cues,
    seLedgerHash: seLedgerHash(ledger),
  };

  console.log(`SE台帳 ${ledger.length}件 → キュー ${cues.length}件 / BGM ${bgm.length}区間(${bgmSource})`);
  if (missing.length > 0) {
    console.error(
      `NG: assets/audio 配下に見つからないSEがあります: ${missing.join(", ")}` +
        "(assets/audio/LICENSES.md に記録のある素材のみ使用できます)"
    );
    process.exit(1);
  }
  if (bgm.length === 0) {
    console.error(
      "WARN: BGM が0区間です。BGMの包絡線は storyboard の「BGM」節が正本で、機械では起こせません。" +
        "書き足してから npm run audio-mix してください(このままだと check-audio の no_bed で止まります)"
    );
  }

  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(out, null, 1));
    return;
  }
  writeFileSync(cuesPath, JSON.stringify(out, null, 1) + "\n");
  console.log(`OK: ${path.relative(root, cuesPath)} — 次は npm run audio-mix ${epArg}`);
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "build-audio-cues.ts") main();
