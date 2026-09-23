/**
 * H3 合成の成果物(字幕台帳・図解 index・audio-cues・ambient.wav)の鮮度を
 * **入力の中身のハッシュ**で判定する(2026-09-23 レビュー指摘 C1/C2)。
 *
 * なぜ mtime ではないのか:
 *   assemble は figures.json↔index.json と master.mp3↔audio-cues.json の mtime しか見ておらず、
 *   台本修正 → npm run tts で timing.json が変わったあとに h3:subs / h3:figures / h3:audio-cues の
 *   焼き直しを忘れても正常終了した(字幕・図解が旧時刻に載る)。mtime は「触っただけ」でも動き、
 *   逆にクリップの差し替え(h3:reject → h3:run)は cuts.json の mtime を動かさない。
 *   焼く側が「何を読んで焼いたか」を sha1 で残し、assemble が現在の入力と突き合わせる。
 *
 * ハッシュは**ファイルのバイト列の sha1**(render-subs.py の hashlib.sha1 と同じ値になる)。
 *
 * 後方互換: inputs を持たない古い成果物(2026-09-23 以前に焼いたもの)は `legacy` に分け、
 * 警告だけ出して通す。新たに焼いたものは必ず inputs を持つ。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Segment } from "./assemble";

/** 入力の名前。成果物ごとに「どれを読んで焼いたか」をこの名前で記録する */
export type InputName = "timing" | "cuts" | "figures" | "bgmPlan" | "sePlan" | "ambient";
export type Inputs = Partial<Record<InputName, string>>;

export function sha1OfFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/** 名前 → パスを受け、在るファイルだけのハッシュを返す(無いファイルはキーごと落とす) */
export function currentInputs(paths: Partial<Record<InputName, string>>): Inputs {
  const out: Inputs = {};
  for (const [name, p] of Object.entries(paths) as [InputName, string][]) {
    const h = sha1OfFile(p);
    if (h !== null) out[name] = h;
  }
  return out;
}

export interface ArtifactInputs {
  /** 表示名(subs.json など) */
  name: string;
  /** 成果物に記録された inputs。無ければ古い成果物 */
  inputs: Inputs | undefined;
  /** 突き合わせる入力の名前 */
  expect: InputName[];
  /** 焼き直すコマンド */
  rebuild: string;
}

export interface FreshnessResult {
  stale: { name: string; changed: InputName[]; rebuild: string }[];
  legacy: { name: string; rebuild: string }[];
}

/**
 * 記録と現在を突き合わせる(純粋関数)。**記録に無い=そのとき入力ファイルが無かった**とみなすので、
 * 後から se-plan.json を書いた(記録なし → 現在あり)も「変わった」になる。
 */
export function checkFreshness(artifacts: ArtifactInputs[], current: Inputs): FreshnessResult {
  const res: FreshnessResult = { stale: [], legacy: [] };
  for (const a of artifacts) {
    if (a.inputs === undefined) {
      res.legacy.push({ name: a.name, rebuild: a.rebuild });
      continue;
    }
    const changed = a.expect.filter((k) => (a.inputs?.[k] ?? null) !== (current[k] ?? null));
    if (changed.length > 0) res.stale.push({ name: a.name, changed, rebuild: a.rebuild });
  }
  return res;
}

export function formatFreshness(r: FreshnessResult): { errors: string[]; warnings: string[] } {
  return {
    errors: r.stale.map((s) =>
      "inputs_stale: " + s.name + " は焼いたあとに " + s.changed.join(" / ") + " が変わっています。焼き直し: " + s.rebuild),
    warnings: r.legacy.map((l) =>
      l.name + " は入力ハッシュ(inputs)を持たない古い成果物です。鮮度を確かめられないので通します"
        + "(確実にするなら焼き直し: " + l.rebuild + ")"),
  };
}

/**
 * figures/index.json に書く inputs。`--only` の部分焼きでは他の図解が古い入力のままなので、
 * 前回の記録と現在が一致するときだけ現在を書く(違えば前回のまま = assemble が古いと止める)。
 */
export function nextIndexInputs(prev: Inputs | undefined, current: Inputs, partial: boolean): Inputs | undefined {
  if (!partial) return current;
  if (prev === undefined) return undefined;
  return sameInputs(prev, current) ? current : prev;
}

function sameInputs(a: Inputs, b: Inputs): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<InputName>;
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

export interface SubsLedgerEntry {
  id: string;
  png: string;
  start: number;
  end: number;
}

/** subs/subs.json を読む。旧形式(配列)は inputs 無し、新形式は { inputs, entries } */
export function readSubsLedger(raw: unknown): { inputs: Inputs | undefined; entries: SubsLedgerEntry[] } {
  if (Array.isArray(raw)) return { inputs: undefined, entries: raw as SubsLedgerEntry[] };
  const o = raw as { inputs?: Inputs; entries?: SubsLedgerEntry[] };
  if (!o || !Array.isArray(o.entries)) throw new Error("subs.json の形が読めません(配列か { inputs, entries })");
  return { inputs: o.inputs, entries: o.entries };
}

/* ---------------- ambient.wav(C2) ---------------- */

/** ambient.wav の横に置く記録(narration/ambient.inputs.json) */
export interface AmbientRecord {
  inputs: Inputs;
  /** クリップID → 指紋(サイズ:mtime)。章カードは使わないので入らない */
  clips: Record<string, string>;
}

export const AMBIENT_EXPECT: InputName[] = ["timing", "cuts", "ambient"];

/**
 * クリップの指紋。中身の sha1 は 100本×数十MB を毎回読むことになるので、サイズと mtime で足りるとした
 * (h3:reject → h3:run の作り直しは必ず新しいファイル = 新しい mtime になる)。
 */
export function clipFingerprint(st: { size: number; mtimeMs: number }): string {
  return st.size + ":" + st.mtimeMs;
}

/** 章カード以外で、実在するクリップの指紋を集める */
export function collectClipFingerprints(segments: Segment[], clipPath: (s: Segment) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of segments) {
    if (s.card) continue;
    const p = clipPath(s);
    if (!existsSync(p)) continue;
    out[s.clipId] = clipFingerprint(statSync(p));
  }
  return out;
}

/** ambient.wav の記録と現在を突き合わせる(純粋関数) */
export function checkAmbientRecord(rec: AmbientRecord, current: AmbientRecord): string[] {
  const out: string[] = [];
  const changedInputs = AMBIENT_EXPECT.filter((k) => (rec.inputs[k] ?? null) !== (current.inputs[k] ?? null));
  const ids = [...new Set([...Object.keys(rec.clips), ...Object.keys(current.clips)])].sort();
  const changedClips = ids.filter((id) => (rec.clips[id] ?? null) !== (current.clips[id] ?? null));
  if (changedInputs.length > 0 || changedClips.length > 0) {
    out.push(
      "ambient_stale: ambient.wav を焼いたあとに変わっています("
        + [
          changedInputs.length > 0 ? "入力: " + changedInputs.join(" / ") : "",
          changedClips.length > 0
            ? "クリップ " + changedClips.length + "本: " + changedClips.slice(0, 10).join(", ") + (changedClips.length > 10 ? " ..." : "")
            : "",
        ].filter(Boolean).join("、")
        + ")— npm run h3:ambient -- <epId>",
    );
  }
  return out;
}

/* ---------------- エピソード単位の突合(assemble / preview が使う) ---------------- */

/** 入力ファイルの場所(root はチャンネルのルート。テストでは一時ディレクトリを渡す) */
export function episodeInputPaths(root: string, epId: string): Record<InputName, string> {
  const e = join(root, "episodes", epId);
  const h = join(root, "h3/episodes", epId);
  return {
    timing: join(e, "timing.json"),
    cuts: join(h, "cuts.json"),
    figures: join(h, "figures.json"),
    bgmPlan: join(e, "bgm-plan.json"),
    sePlan: join(e, "se-plan.json"),
    ambient: join(h, "ambient.json"),
  };
}

/**
 * 字幕台帳・図解 index・audio-cues の記録を現在の入力と突き合わせる。
 * 成果物が無いものは数えない(無いことは各呼び出し側が別に止める)。
 * 図解は figures.json が無ければ見ない(--no-figures の経路)。
 */
export function loadEpisodeFreshness(root: string, epId: string): FreshnessResult {
  const paths = episodeInputPaths(root, epId);
  const h = join(root, "h3/episodes", epId);
  const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
  const artifacts: ArtifactInputs[] = [];
  const subsPath = join(h, "subs", "subs.json");
  if (existsSync(subsPath)) {
    artifacts.push({
      name: "subs/subs.json", inputs: readSubsLedger(readJson(subsPath)).inputs,
      expect: ["timing"], rebuild: "npm run h3:subs " + epId,
    });
  }
  const idxPath = join(h, "figures", "index.json");
  if (existsSync(paths.figures) && existsSync(idxPath)) {
    artifacts.push({
      name: "figures/index.json", inputs: (readJson(idxPath) as { inputs?: Inputs }).inputs,
      expect: ["timing", "cuts", "figures"], rebuild: "npm run h3:figures -- " + epId,
    });
  }
  const cuesPath = join(root, "episodes", epId, "audio-cues.json");
  if (existsSync(cuesPath)) {
    artifacts.push({
      name: "audio-cues.json", inputs: (readJson(cuesPath) as { inputs?: Inputs }).inputs,
      expect: ["timing", "bgmPlan", "sePlan"],
      rebuild: "npm run h3:audio-cues -- " + epId + " → npm run audio-mix episodes/" + epId,
    });
  }
  return checkFreshness(artifacts, currentInputs(paths));
}

/** ambient.wav の現在の状態(入力のハッシュ+クリップの指紋)。build-ambient が書き、assemble / preview が突き合わせる */
export function currentAmbientRecord(root: string, epId: string, segments: Segment[], clipPath: (s: Segment) => string): AmbientRecord {
  const paths = episodeInputPaths(root, epId);
  return {
    inputs: currentInputs({ timing: paths.timing, cuts: paths.cuts, ambient: paths.ambient }),
    clips: collectClipFingerprints(segments, clipPath),
  };
}
