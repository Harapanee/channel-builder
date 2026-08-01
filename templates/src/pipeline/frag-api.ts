/**
 * JSソース(共通ヘルパー / 章グループのフラグメント)から「他が呼べる部品」の一覧を作る。
 *
 * なぜ要るか(ep013 実測):
 *   共有装置の実装オーナー(G1)以外の5グループは、装置の使い方を知るために
 *   `_frag/G1.js` を**全文Read**していた(25k字 × 複数回。G5 は4回読んでいる)。
 *   読んだ内容はそのエージェントの残り全ターンのコンテキストに乗り続けるため、
 *   コスト(ターン単価 約$0.15)にそのまま効く。装置は「名前と引数と一行説明」が
 *   分かれば呼べるので、本体ではなく API 表を配る。
 *
 * 使い方:
 *   npx tsx src/pipeline/frag-api.ts <jsファイル> [-o 出力先.md]
 *   例) 共有装置オーナーの完了後:
 *       npx tsx src/pipeline/frag-api.ts episodes/<epId>/_frag/G1.js
 *       → episodes/<epId>/_frag/G1.api.md(他グループへはこのパスだけ渡す)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ApiEntry = {
  /** 呼び出し名(`pic` / `DEV.nestSection`) */
  name: string;
  /** 引数つきの見出し(`pic(host, key, o)`)。値なら名前のみ */
  signature: string;
  /** 直前のコメントから取った一行説明(無ければ空) */
  doc: string;
};

/**
 * 直前のコメント塊から一行説明を拾う。
 *
 * JSDoc は**先頭が要約**なので、後ろから最初に見つかった行(`@example` 等のタグ本文に
 * なりがち)ではなく、塊をソース順に戻して最初の非タグ行を採る。
 */
export function docAbove(lines: string[], index: number): string {
  const block: string[] = [];
  for (let i = index - 1; i >= 0 && i >= index - 20; i--) {
    const raw = lines[i].trim();
    if (raw === "") {
      if (block.length > 0) break; // コメント塊の直前の空行で打ち切る
      continue;
    }
    if (!/^(\/\/|\/\*|\*)/.test(raw)) break; // コメントでなければ説明ではない
    block.push(raw);
    if (/^\/\*/.test(raw)) break; // 塊の先頭に到達
  }
  for (const raw of block.reverse()) {
    const text = raw
      .replace(/^\/\*+/, "")
      .replace(/\*+\/$/, "")
      .replace(/^\*\s?/, "")
      .replace(/^\/\/+\s?/, "")
      .trim();
    if (!text || text.startsWith("@")) continue; // @param / @returns / @example は要約ではない
    return text.slice(0, 120);
  }
  return "";
}

/**
 * 呼べる部品を抽出する。拾う形は3つ:
 *   1. `function name(args) {`                      … トップレベル関数
 *   2. `NS.name = function (args) {`                … 名前空間に生やす装置(DEV.wob 等)
 *   3. `NS.name = { ... }` / `= [ ... ]` / `= 値`   … 装置が使う定数表(DEV.NEST 等)
 */
export function extractApi(src: string): ApiEntry[] {
  const lines = src.split("\n");
  const out: ApiEntry[] = [];
  const seen = new Set<string>();
  const push = (name: string, signature: string, i: number): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, signature, doc: docAbove(lines, i) });
  };

  lines.forEach((line, i) => {
    let m = /^function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(line);
    if (m) {
      /* 内部専用の目印(先頭 __)は配らない */
      if (!m[1].startsWith("__")) push(m[1], `${m[1]}(${m[2].trim()})`, i);
      return;
    }
    m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*function\s*\(([^)]*)\)/.exec(line);
    if (m) {
      push(`${m[1]}.${m[2]}`, `${m[1]}.${m[2]}(${m[3].trim()})`, i);
      return;
    }
    m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*(?!function)(.+)$/.exec(line);
    if (m) {
      /* `DEV.wipeIn = wipeIn; DEV.buryUp = buryUp;` のような再輸出は、本体側(function)で
         既に拾えているので配らない。1行に複数並ぶので最初の文だけを見る */
      const value = m[3].split(";")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(value)) return;
      const kind = value.startsWith("{") ? "{...}" : value.startsWith("[") ? "[...]" : "値";
      push(`${m[1]}.${m[2]}`, `${m[1]}.${m[2]} = ${kind}`, i);
    }
  });
  return out;
}

/** API一覧をMarkdownにする */
export function renderApiMarkdown(title: string, entries: ApiEntry[]): string {
  const body = entries.map((e) => `- \`${e.signature}\`${e.doc ? ` — ${e.doc}` : ""}`).join("\n");
  return (
    `# ${title}\n\n` +
    `他グループはこの表だけを読むこと(本体を全文Readしない — 読んだ内容は残り全ターンのコンテキストに乗り続ける)。\n` +
    `挙動の詳細が要るときだけ、該当箇所を grep で当てる。\n\n` +
    `${body}\n`
  );
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

if (process.argv[1] && path.basename(process.argv[1]) === "frag-api.ts") {
  const args = process.argv.slice(2);
  const src = args.find((a) => !a.startsWith("-"));
  if (!src) {
    console.error("使い方: npx tsx src/pipeline/frag-api.ts <jsファイル> [-o 出力先.md]");
    process.exit(2);
  }
  if (!existsSync(src)) {
    console.error(`ERROR: ファイルがありません: ${src}`);
    process.exit(2);
  }
  const oIndex = args.indexOf("-o");
  const out = oIndex >= 0 ? args[oIndex + 1] : src.replace(/\.js$/, ".api.md");
  const entries = extractApi(readFileSync(src, "utf8"));
  writeFileSync(out, renderApiMarkdown(`${path.basename(src)} の部品一覧`, entries));
  console.log(`OK: ${out} — ${entries.length}件の部品(他グループへはこのパスだけ渡す)`);
}
