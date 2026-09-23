/**
 * 鎖の古さ検出(純関数)。
 *
 * 鎖のカット(chain / chainFrom)は起点クリップの最終コマを1コマ目にして生成する。
 * **起点を作り直したのに下流を作り直していない**と、下流の1コマ目は古い起点の絵のまま残り、
 * つなぎ目で絵が飛ぶ。h3:reject は下流を連れて行かないので、mtime で拾う:
 * 下流クリップの mtime が起点クリップより古ければ、その下流は古い起点から作られている。
 *
 * 使う側: run-chapter の `--plan`(警告表示)/ assemble(ストリーム C)。
 * ファイルシステムには触らない(mtime は mtimeOf で受け取る)。
 */
import type { Cut } from "./types";

/** 並び(章)と台帳。CutsFile をそのまま渡せる最小の形 */
export interface ChainLedger {
  chapters: { cuts: string[] }[];
  cuts: Record<string, Cut>;
}

/** クリップの mtime(ms)。クリップが無ければ null / undefined */
export type MtimeOf = (cutId: string) => number | null | undefined;

/**
 * そのカットの鎖の起点。chainFrom が chain より強い(run-chapter の resolveChain と同じ解決)。
 * chain: true で直前が無い(章の先頭)なら null — 台帳の不正は resolveChain / check:h3 が止めるので、ここでは飛ばす。
 */
export function chainSourceOf(cut: Cut | undefined, prev: string | null): string | null {
  if (!cut) return null;
  if (cut.chainFrom) return cut.chainFrom;
  if (cut.chain) return prev;
  return null;
}

function orderOf(ledger: ChainLedger | Record<string, Cut>): { chapters: string[][]; cuts: Record<string, Cut> } {
  const l = ledger as ChainLedger;
  if (Array.isArray(l.chapters) && l.cuts && typeof l.cuts === "object") {
    return { chapters: l.chapters.map((c) => c.cuts), cuts: l.cuts };
  }
  // cuts の Record だけ: cuts.json のキー順(= 台帳の並び)を1本の並びとして扱う
  const cuts = ledger as Record<string, Cut>;
  return { chapters: [Object.keys(cuts)], cuts };
}

/**
 * 下流クリップの mtime が起点クリップより**厳密に**古いカットの ID(章順)。
 * どちらかのクリップが無いものは判定しない(未生成は古さではない)。
 */
export function findStaleChains(ledger: ChainLedger | Record<string, Cut>, mtimeOf: MtimeOf): string[] {
  const { chapters, cuts } = orderOf(ledger);
  const out: string[] = [];
  for (const order of chapters) {
    let prev: string | null = null;
    for (const id of order) {
      const from = chainSourceOf(cuts[id], prev);
      prev = id;
      if (!from) continue;
      const own = mtimeOf(id);
      const src = mtimeOf(from);
      if (own == null || src == null) continue;
      if (own < src) out.push(id);
    }
  }
  return out;
}
