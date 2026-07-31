/**
 * storyboard.md の「使用素材」列と composition.html の実装を突き合わせる(HF経路)。
 *
 * なぜ必要か:
 *   ep012-octopus の cL26/33/36/37/38 は storyboard が
 *   `[char_octopus_paralarva_canonical]` を指定していたのに、実装は素材を使わず
 *   SVG で体を描き起こしていた。結果、同じキャラが画像と図形で交互に切り替わる
 *   状態のままレンダー・承認まで通った。review-checklist の
 *   「絵コンテの演出指定が実装で格下げされていない」「library.json に素材があるのに
 *   図形で代用しているカットが無い」は 2026-07-30 に `@frame`(廃止した
 *   compliance-reviewer が判定)から `@human`(ユーザーの目視)へ移っており、
 *   11分超の動画を人が全カット見る前提になっていた。ここは機械で数えられる。
 *
 * 何を見るか:
 *   storyboard の clip 行が挙げた assetId が、その clip の実装から参照されているか。
 *   参照は「HF.A のキー名の文字列」「const で束ねた舞台キー(REEF 等)」「共有ヘルパー
 *   経由(epBase / paralarva / eggChandelier 等)」の3経路を解決してから数える。
 *
 * 使い方:
 *   npx tsx src/pipeline/check-storyboard-assets.ts episodes/<epId>
 *
 * exit: 0 = 報告のみ(既定) / 1 = --strict かつ BLOCK あり / 2 = 実行エラー
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type Severity = "BLOCK" | "ADVISE";

export interface MissingAsset {
  clipId: string;
  assetId: string;
  severity: Severity;
}

/** HF.A の資産表 `keyName: { p: "...", ... }, // asset_id` から キー→assetId を読む */
export function parseAssetTable(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*\{\s*p:\s*"[^"]+"[^}]*\}\s*,\s*\/\/\s*((?:char|prop|place)_[a-z0-9_]+)/gm;
  for (const m of html.matchAll(re)) map.set(m[1], m[2]);
  return map;
}

/** `const REEF = "rockyReefSeafloorJpBase";` のような舞台キーの別名を読む */
export function parseConstAliases(html: string, keys: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([A-Za-z][A-Za-z0-9]*)"\s*;/g)) {
    if (keys.has(m[2])) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * `start` の位置にある `{` から対応する `}` までを返す(文字列・コメントを飛ばす)。
 * 見つからない場合は末尾まで。
 */
export function blockAt(src: string, start: number, brace: "{" | "[" = "{"): string {
  const close = brace === "{" ? "}" : "]";
  const open = src.indexOf(brace, start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i);
      if (i < 0) break;
      i++;
      continue;
    }
    if (c === brace) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * `SCENES.cLxx = ...` の本文を clipId ごとに取り出す。
 * ep009/ep010 は `(g,D)=>{`、ep011/ep012 は `function (g, D) {` と書き方が違うので両対応する。
 */
export function parseClipBlocks(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/SCENES\.(\w+)\s*=\s*(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{/g)) {
    map.set(m[1], blockAt(html, m.index! + m[0].length - 1));
  }
  return map;
}

/**
 * トップレベルの宣言(関数・const)の本文を名前ごとに取り出す。
 * const も拾うのは、房の定義(CHAND)・粒の定義(GRAIN)のように
 * 「素材キーを持つデータをトップレベルの const に置き、clip はそれを参照するだけ」
 * という書き方が実際にあるため。ここを見ないと参照を取りこぼして誤検知になる。
 */
export function parseHelperBlocks(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    map.set(m[1], blockAt(html, m.index! + m[0].length - 1));
  }
  for (const m of html.matchAll(/^(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    const value = declValue(html, m.index! + m[0].length);
    /* 素材テーブルそのもの(const A = {...})は除外する。これを継承させると
       pic() 経由で全clipが全素材を参照していることになり、検査が常に緑になる */
    if (!value || isAssetTableSource(value)) continue;
    map.set(m[1], value);
  }
  return map;
}

/** 素材テーブル本体か(`// char_xxx` 付きの行が複数ある)を判定する */
export function isAssetTableSource(src: string): boolean {
  return (src.match(/\/\/\s*(?:char|prop|place)_[a-z0-9_]+/g) ?? []).length >= 2;
}

/** `= ` の直後から、宣言の値の範囲を返す(`{`/`[` は対応括弧まで、それ以外は行末まで) */
export function declValue(src: string, from: number): string {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === "{" || src[i] === "[") return blockAt(src, i, src[i] as "{" | "[");
  const nl = src.indexOf("\n", i);
  return src.slice(i, nl < 0 ? src.length : nl);
}

/**
 * ソース片が直接参照している HF.A のキー。
 * 参照の書き方はエピソードで違う — ep011/ep012 は文字列リテラル `pic(c, "keyName")`、
 * ep009/ep010 はプロパティ参照 `char(c, A.keyName)`。両方を拾う。
 */
export function keysIn(src: string, keys: Set<string>, aliases: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/["'.]\s*([A-Za-z][A-Za-z0-9]*)/g)) if (keys.has(m[1])) out.add(m[1]);
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]{1,})\b/g)) {
    const k = aliases.get(m[1]);
    if (k) out.add(k);
  }
  return out;
}

/** ソース片が参照している宣言名(呼び出しに限らない — CHAND のようなデータ参照も拾う) */
export function refsIn(src: string, names: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) if (names.has(m[1])) out.add(m[1]);
  return out;
}

/**
 * 各ヘルパーが(自分が呼ぶヘルパーも含めて)最終的に参照するキーを求める。
 * 相互再帰しても止まるよう、増えなくなるまで回す不動点計算。
 */
export function resolveHelperKeys(
  helpers: Map<string, string>,
  keys: Set<string>,
  aliases: Map<string, string>
): Map<string, Set<string>> {
  const names = new Set(helpers.keys());
  const direct = new Map<string, Set<string>>();
  const calls = new Map<string, Set<string>>();
  for (const [name, src] of helpers) {
    direct.set(name, keysIn(src, keys, aliases));
    calls.set(name, refsIn(src, names));
  }
  const resolved = new Map([...direct].map(([n, s]) => [n, new Set(s)]));
  for (let pass = 0; pass < names.size + 1; pass++) {
    let grew = false;
    for (const name of names) {
      const mine = resolved.get(name)!;
      for (const callee of calls.get(name)!) {
        if (callee === name) continue;
        for (const k of resolved.get(callee)!) if (!mine.has(k)) (mine.add(k), (grew = true));
      }
    }
    if (!grew) break;
  }
  return resolved;
}

/** clip ごとに「その実装が到達する assetId の集合」を求める */
export function resolveClipAssets(html: string): Map<string, Set<string>> {
  const keyToAsset = parseAssetTable(html);
  const keys = new Set(keyToAsset.keys());
  const aliases = parseConstAliases(html, keys);
  const helperKeys = resolveHelperKeys(parseHelperBlocks(html), keys, aliases);
  const helperNames = new Set(helperKeys.keys());

  const out = new Map<string, Set<string>>();
  for (const [clipId, src] of parseClipBlocks(html)) {
    const ks = keysIn(src, keys, aliases);
    for (const callee of refsIn(src, helperNames)) for (const k of helperKeys.get(callee)!) ks.add(k);
    out.set(clipId, new Set([...ks].map((k) => keyToAsset.get(k)!).filter(Boolean)));
  }
  return out;
}

/** storyboard.md の clip 表から clipId → 指定 assetId[] を読む(角括弧は未生成マーカーなので外す) */
export function parseStoryboardRows(md: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of md.split("\n")) {
    const head = /^\|\s*(cL\d+[a-z]?)\s*\|/.exec(line);
    if (!head) continue;
    const ids = [...line.matchAll(/\b(?:char|prop|place)_[a-z0-9_]+/g)].map((m) => m[0]);
    const prev = rows.get(head[1]) ?? [];
    rows.set(head[1], [...new Set([...prev, ...ids])]);
  }
  return rows;
}

/**
 * 指定されたのに実装から参照されていない素材(純粋関数)。
 *
 * 二値で出すのは、未参照が必ずしも事故ではないため —
 * 「遠景は SVG の楕円連なりで軽くし、近景だけ描き込み素材を重ねる」(ep012 cL09)の
 * ように、絵コンテ自身が素材とコード描画の併用を指定していることがある。
 *   BLOCK  … キャラ素材(char_)を指定しているのに、その clip が**素材を1枚も使っていない**。
 *            = 「library.json に素材があるのに図形で代用しているカット」の最も確実な形。
 *            ep012 の幼生タコ(cL26/33/36)はここで止まる。
 *   ADVISE … それ以外の未参照。人が絵コンテ側の指定の古さと突き合わせて判断する。
 */
export function findMissingAssets(
  storyboard: Map<string, string[]>,
  implemented: Map<string, Set<string>>
): MissingAsset[] {
  const out: MissingAsset[] = [];
  for (const [clipId, ids] of storyboard) {
    const used = implemented.get(clipId);
    if (!used) continue; // 実装が無いclipは被覆検査(scaffold/check)の担当
    for (const assetId of ids) {
      if (used.has(assetId)) continue;
      const noCharAsset = ![...used].some((a) => a.startsWith("char_"));
      const severity: Severity = assetId.startsWith("char_") && noCharAsset ? "BLOCK" : "ADVISE";
      out.push({ clipId, assetId, severity });
    }
  }
  return out;
}

/* ----------------------------- 以下 CLI(I/O) ----------------------------- */

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const epArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!epArg) fail("使い方: npx tsx src/pipeline/check-storyboard-assets.ts episodes/<epId> [--strict]");
  const epDir = path.resolve(process.cwd(), epArg);
  const compositionPath = path.join(epDir, "composition.html");
  const storyboardPath = path.join(epDir, "storyboard.md");
  if (!existsSync(compositionPath)) fail("composition.html がありません(HF経路専用の検査です)");
  if (!existsSync(storyboardPath)) fail("storyboard.md がありません");

  const html = readFileSync(compositionPath, "utf8");
  /* 素材表が機械可読でない旧形式(ep009・ep010 = scaffold-composition.ts 導入前)は検査できない。
     全clipを誤って赤にするより、検査していないことを明示して抜ける。 */
  if (parseAssetTable(html).size === 0) {
    console.log(
      "SKIP: composition.html に機械可読な素材表(`key: { p: ... }, // asset_id`)がありません。" +
        "scaffold-composition.ts 導入前の旧形式のため検査を行いません。"
    );
    process.exit(0);
  }
  const storyboard = parseStoryboardRows(readFileSync(storyboardPath, "utf8"));
  const implemented = resolveClipAssets(html);
  const missing = findMissingAssets(storyboard, implemented);
  const blocks = missing.filter((m) => m.severity === "BLOCK");
  const advises = missing.filter((m) => m.severity === "ADVISE");

  const checked = [...storyboard.keys()].filter((c) => implemented.has(c)).length;
  console.log(`絵コンテ素材の突合: ${checked} clip を検査(storyboard ${storyboard.size} 行 / 実装 ${implemented.size} clip)`);

  const group = (ms: MissingAsset[]) => {
    const byClip = new Map<string, string[]>();
    for (const m of ms) byClip.set(m.clipId, [...(byClip.get(m.clipId) ?? []), m.assetId]);
    return byClip;
  };
  for (const [clipId, ids] of group(advises)) {
    console.log(`ADVISE ${clipId}: ${ids.join(" / ")} が実装から参照されていない(コード描画との併用かもしれない)`);
  }
  for (const [clipId, ids] of group(blocks)) {
    console.error(`BLOCK ${clipId}: ${ids.join(" / ")} を指定しているのに、この clip はキャラ素材を1枚も使っていない`);
  }
  if (blocks.length === 0) {
    console.log(`OK: BLOCK なし(ADVISE ${group(advises).size} clip)`);
    process.exit(0);
  }
  console.error(
    `\n${group(blocks).size} clip で絵コンテと実装が食い違っています。どちらかが間違いです —\n` +
      `  (a) 実装が素材を使わず図形で代用している(review-checklist「library.json に素材が` +
      `あるのに図形で代用しているカットが無い」)。ep012 の幼生タコがこれ\n` +
      `  (b) 絵コンテがコード描画のclipに参考として素材名を書いている。storyboard の凡例は` +
      `「素材なしclipは —(コード描画)と書く」なので、その場合は絵コンテ側を直す`
  );
  /* 既定は報告のみ(exit 0)。既存エピソードには (b) 由来の食い違いが積み上がっており、
     いきなり遮断するとレンダーキューが止まるため。負債を解消したチャンネルは --strict で
     ゲートに格上げできる。 */
  process.exit(strict ? 1 : 0);
}

/* テストから import したときは走らせない */
if (process.argv[1] && path.basename(process.argv[1]) === "check-storyboard-assets.ts") main();
