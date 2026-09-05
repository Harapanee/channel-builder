/**
 * 章ファイルと timing.json から cuts.json を起こす。
 *   npx tsx src/pipeline/h3/build-cuts.ts <epId>
 *
 * v2 は章ファイルが割りも兼ねていたので、そこから台帳を逆生成する。
 * 尺は**タイムライン区間**(その行の startSec から次の行の startSec まで)で決める。
 * 発話区間(endSec - startSec)で決めると行間の無音ぶんだけ短い動画になる(ep015 実測で 130 秒不足)。
 *
 * place / subject / role は空で出す(h3-cut-planner が埋める欄。既存 ep の移設では未使用)。
 *
 * **束ね(1カットが複数 lineIds を持つ)を持つ既存 cuts.json は再生成しない。**
 * 束ねは h3-cut-planner の意味判断の産物で、shots/<章>.ts の宣言(cid→1行)からは復元できない。
 * 復元できないものを黙って上書きする道具にしないため、束ねが1件でもあれば exit 2 で止める
 * (Task 3 実測: ep016-honeybee は束ね155件・ep017-cuckoo は111件でこの経路。
 *  build-cuts.ts が正当に扱えるのは束ねゼロの ep015-salmon のような未加工エピソードだけ)。
 *
 * `npx tsx -e` は使わない。tsx の -e は esbuild が cjs 出力へ変換するため
 * トップレベル await が使えず、動的 import を含むワンライナーは1行も動かない。
 */
import { basename, join, resolve } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { MIN_CLIP_SEC, SPEEDUP_ADVISE, spanSeconds, speedupRatios, type TimingLine } from "./plan";
import { MAX_FRAMES, framesForSeconds } from "./frames";
import type { Chapter, Cut, CutsFile, ShotDecl } from "./types";

const ROOT = resolve(import.meta.dirname, "../../..");

/**
 * 既存 cuts.json の holdSlow を新しい cuts へ引き継ぐ。
 * holdSlow は宣言(shots/<章>.ts)側に欄が無く h3-cut-planner が cuts.json にだけ書く値なので、
 * 宣言から素朴に組み直すと黙って消える(= 後続の早回し是正が無言で無効化される)。
 * 既存が無い/壊れている場合は呼び出し側が existingCuts に undefined を渡し、引き継がずに続行する。
 */
export function carryHoldSlow(
  cuts: Record<string, Cut>,
  existingCuts: Record<string, Cut> | undefined,
): { cuts: Record<string, Cut>; carried: number } {
  if (!existingCuts) return { cuts, carried: 0 };
  let carried = 0;
  const out: Record<string, Cut> = {};
  for (const [cutId, cut] of Object.entries(cuts)) {
    if (existingCuts[cutId]?.holdSlow) {
      out[cutId] = { ...cut, holdSlow: true };
      carried += 1;
    } else {
      out[cutId] = cut;
    }
  }
  return { cuts: out, carried };
}

/**
 * lineIds が2つ以上(束ね済み)のカットIDを返す。
 * 束ねは h3-cut-planner の意味判断の産物で shots/<章>.ts の宣言からは復元できないため、
 * これが1件でもある既存 cuts.json は再生成の対象外と判定する材料にする。
 */
export function mergedCutIds(cuts: Record<string, Cut>): string[] {
  return Object.entries(cuts)
    .filter(([, c]) => c.lineIds.length > 1)
    .map(([cutId]) => cutId);
}

async function main(): Promise<void> {
  const epId = process.argv[2];
  if (!epId) {
    console.error("使い方: npx tsx src/pipeline/h3/build-cuts.ts <epId>");
    process.exit(2);
  }

  const timing = JSON.parse(readFileSync(join(ROOT, "episodes", epId, "timing.json"), "utf8")) as {
    totalDurationSec: number;
    lines: TimingLine[];
  };
  const indexOf = new Map(timing.lines.map((l, i) => [l.lineId, i]));
  const epDir = join(ROOT, "h3/episodes", epId);

  // 既存 cuts.json の読み込み(無い/壊れていれば undefined のまま初回生成として続行)
  let existingCuts: Record<string, Cut> | undefined;
  try {
    const prev = JSON.parse(readFileSync(join(epDir, "cuts.json"), "utf8")) as CutsFile;
    existingCuts = prev.cuts;
  } catch {
    existingCuts = undefined;
  }

  // 束ねを持つ既存台帳は h3-cut-planner が書いたものなので再生成しない
  if (existingCuts) {
    const merged = mergedCutIds(existingCuts);
    if (merged.length > 0) {
      console.error(
        "このエピソードは h3-cut-planner が書いた台帳を持っている(束ね " + merged.length + "件)ので再生成しません。" +
        "例: " + merged.slice(0, 5).join(", "),
      );
      process.exit(2);
    }
  }

  const chapters: Chapter[] = [];
  const cuts: Record<string, Cut> = {};
  for (const f of readdirSync(join(epDir, "shots")).filter((x) => x.endsWith(".ts")).sort()) {
    const chId = f.replace(/\.ts$/, "");
    const shots = (await import(join(epDir, "shots", f))).default as Record<string, ShotDecl>;
    const ids = Object.keys(shots);
    chapters.push({ id: chId, title: "", name: "", cuts: ids });
    for (const cid of ids) {
      const lineId = "L" + cid.slice(2);
      const i = indexOf.get(lineId);
      if (i === undefined) throw new Error(cid + ": timing.json に " + lineId + " がありません");
      const span = spanSeconds(timing.lines, i, i, timing.totalDurationSec);
      const decl = shots[cid];
      cuts[cid] = {
        lineIds: [lineId],
        seconds: Math.max(MIN_CLIP_SEC, Math.ceil(span * 10) / 10),
        place: "",
        subject: "",
        role: "",
        ...(decl.chain ? { chain: true } : {}),
        ...(decl.chainFrom ? { chainFrom: decl.chainFrom } : {}),
        ...(decl.hi ? { hi: true } : {}),
        ...(decl.text ? { text: true } : {}),
        ...(decl.card ? { card: decl.card } : {}),
      };
    }
  }

  const { cuts: mergedCuts, carried } = carryHoldSlow(cuts, existingCuts);

  // 自己検算(書き出す前に全部通す。例外で落ちても壊れた cuts.json をディスクに残さないため)
  const n = Object.keys(mergedCuts).length;
  const span = Object.values(mergedCuts).reduce((s, c) => {
    const i = indexOf.get(c.lineIds[0]) as number;
    return s + spanSeconds(timing.lines, i, indexOf.get(c.lineIds.at(-1) as string) as number, timing.totalDurationSec);
  }, 0);
  const grid = Object.values(mergedCuts).filter((c) => {
    try {
      framesForSeconds(c.seconds);
      return false;
    } catch {
      return true;
    }
  }).length;
  console.log("章 " + chapters.length + " / カット " + n);
  console.log("区間合計 " + span.toFixed(2) + "秒 / 総尺 " + timing.totalDurationSec.toFixed(2) + "秒");
  console.log("グリッド外 " + grid + "件");
  if (Math.abs(span - timing.totalDurationSec) > 0.05) throw new Error("区間合計が総尺と合いません(取りこぼしがある)");
  // speedupRatios は内部で framesForSeconds を呼ぶため、グリッド外(上限15秒相当超)の
  // カットが残っていると生のスタックトレースで落ちる。件数を出したあとに意図した異常終了へ変える
  if (grid > 0) {
    console.error("❌ グリッド外(上限 " + MAX_FRAMES + "F 相当を超える)カットがあります: " + grid + "件。"
      + "cuts.json の seconds を短くするか、束ねを見直してください");
    process.exit(2);
  }

  const speedups = speedupRatios(mergedCuts, timing.lines, timing.totalDurationSec);
  const over = speedups.filter((s) => s.ratio > SPEEDUP_ADVISE).sort((a, b) => b.ratio - a.ratio);
  const genSec = speedups.reduce((s, r) => s + r.generatedSeconds, 0);
  console.log(
    "生成 " + genSec.toFixed(1) + "秒 / タイムライン " + timing.totalDurationSec.toFixed(1) +
    "秒(余剰 " + (genSec - timing.totalDurationSec).toFixed(1) + "秒)",
  );
  console.log("早回し ×" + SPEEDUP_ADVISE + " 超: " + over.length + "本" +
    (over.length > 0 ? "(最大 ×" + over[0].ratio.toFixed(2) + " " + over[0].cutId + ")" : ""));

  // ここまで来て初めて安全に書き出せる
  const out: CutsFile = { episodeId: epId, chapters, cuts: mergedCuts };
  mkdirSync(epDir, { recursive: true });
  writeFileSync(join(epDir, "cuts.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("holdSlow 引き継ぎ: " + carried + "件");
}

if (process.argv[1] && basename(process.argv[1]) === "build-cuts.ts") await main();
