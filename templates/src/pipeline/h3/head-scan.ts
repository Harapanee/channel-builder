/**
 * 生成クリップ冒頭のゴミコマ(白紙・白からのフェード・無関係な絵からの切り替わり)を測り、
 * cuts.json の skipHeadFrames の推奨値を出す。**GPU は使わない**(ローカルの mp4 を読むだけ)。
 *
 *   npm run h3:head-scan -- <epId> [章ID] [--apply] [--window N] [--dir <クリップ置き場>]
 *
 * H3 は seed によって冒頭数コマに無関係な絵を出し、文面でも seed でも消えない
 * (memory: h3-head-frame-garbage-skipheadframes / h3-panda-paw-and-long-prompt-pitfalls。
 * 1話 14〜18本)。これまでは人が「開始+0.15秒」の一覧を目で見て決めていた。
 *
 * 見るもの(先頭 window コマ。既定 12 = 0.5秒):
 *   - 白紙   … 輝度std がほぼ 0、または白画素(≥235)が 9割以上
 *   - フェード … 輝度std が「本編の安定値」(window 以降 12コマの中央値)から ±20% を外れる
 *   - 急変   … 次のコマとの平均差が大きい(= そこで別の絵から本編へ切り替わった)
 * 推奨値 = 最後のゴミコマの番号 + 1 + 余白 2コマ(HEAD_SCAN.margin の較正を参照)。
 *
 * **検出できないもの**: 本編と同じ明るさ・同じ複雑さの「別の絵」(顔・手・文字)が
 * 切り替わりなしに溶けていく型。これは機械では拾えないので、表の結果は目視の代わりではなく
 * 目視の当たり付けとして使う。`--apply` は既存値を**小さくしない**(大きい方を採る)。
 */
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseLumaSamples } from "./clip-metrics";
import { ROOT, clipsDir } from "./config";
import type { CutsFile } from "./types";

/** 1コマの指標 */
export interface FrameStat {
  /** 輝度の標準偏差(0〜127)。低いほど平坦(紙だけ・白紙) */
  std: number;
  /** 白画素(輝度 ≥ 235)の割合(0〜1) */
  white: number;
  /** 前のコマとの平均絶対差(0〜255)。1コマ目は 0 */
  diffPrev: number;
}

export interface HeadScanResult {
  /** 推奨する skipHeadFrames(0 = 捨てなくてよい)。garbage + 余白 */
  skip: number;
  /** 機械が検出したゴミコマの数(先頭から。余白を足す前) */
  garbage: number;
  /** 検出の理由(白紙 / フェード / 急変) */
  reasons: string[];
  /** 窓の端までゴミが続いた(推奨値は窓で頭打ち。目視で決める) */
  unsettled: boolean;
  /** 本編の安定値(輝度std) */
  refStd: number;
  /** 1コマも読めなかったら false */
  measured: boolean;
}

/** 較正値(ep043/044/045 の実クリップ 277本・人の既知値 47本で決めた) */
export const HEAD_SCAN = {
  /** 既定の窓(コマ)。レビュー計画 F2 の「冒頭 0〜12 コマ」 */
  window: 12,
  /** 本編の安定値を取るコマ数(窓の直後から) */
  refFrames: 12,
  /** これ未満の輝度std は白紙 */
  blankStd: 8,
  /** 白画素の割合がこれ以上なら白紙 */
  blankWhite: 0.9,
  /** 安定値からのずれがこの割合を超えたらフェード中 */
  settleRatio: 0.2,
  /** 次コマとの平均差がこれ以上なら切り替わり(下限) */
  jumpDiff: 20,
  /** 切り替わりは本編の前コマ差(90%点)のこの倍以上 */
  jumpOverMotion: 2,
  /** 1コマ目がこれ以上ずれていればフェードの起点と見なす(白紙でなくても) */
  fadeStartRatio: 0.5,
  /**
   * 検出したゴミコマに足す余白(コマ)。フェードの尻尾・ワイプの縁は輝度std では安定値に
   * 入って見えても目では残る。ep043/044/045 で人が目視で決めた既知値 45本と突き合わせ、
   * 余白 0 では平均 −2.4 コマ(捨て足りない側)、2 で −0.4 コマになった
   */
  margin: 2,
  /** 白の閾値(8bit 輝度) */
  whiteLevel: 235,
  /** 縮小サイズ(clip-metrics の輝度サンプリングと同じ) */
  sampleW: 128,
  sampleH: 72,
} as const;

/** グレースケール生バッファ(w*h バイト/コマの連結)から、コマごとの指標を出す */
export function frameStats(raw: Buffer, w: number, h: number): FrameStat[] {
  const size = w * h;
  const stds = parseLumaSamples(raw, w, h);
  const out: FrameStat[] = [];
  for (let f = 0; f < stds.length; f += 1) {
    const off = f * size;
    let white = 0;
    let diff = 0;
    for (let i = 0; i < size; i += 1) {
      const v = raw[off + i];
      if (v >= HEAD_SCAN.whiteLevel) white += 1;
      if (f > 0) diff += Math.abs(v - raw[off - size + i]);
    }
    out.push({ std: stds[f], white: white / size, diffPrev: f > 0 ? diff / size : 0 });
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 分位点(最近傍順位。q は 0〜1) */
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/**
 * 推奨 skipHeadFrames を決める。純関数(テスト対象)。
 * stats は先頭から window + refFrames コマ程度あればよい(足りなければあるだけで測る)。
 */
export function recommendSkip(stats: FrameStat[], opts: { window?: number } = {}): HeadScanResult {
  const window = opts.window ?? HEAD_SCAN.window;
  if (stats.length === 0) return { skip: 0, garbage: 0, reasons: [], unsettled: false, refStd: 0, measured: false };
  // 本編の安定値。窓の直後が無い短い読み出しでは後半半分で代用する
  const refSlice = stats.length > window
    ? stats.slice(window, window + HEAD_SCAN.refFrames)
    : stats.slice(Math.floor(stats.length / 2));
  const refStd = median(refSlice.map((s) => s.std));
  // 本編そのものが平坦(章カードの紙地など)なら、白紙・フェードの判定は意味を持たない
  const flatClip = refStd < HEAD_SCAN.blankStd;
  // 急変の閾値は本編の動きの量に対して相対で決める。最初から速く動き続ける絵
  // (前コマ差が本編でも 20 前後)を切り替わりと誤認しないため(ep044 cL83/cL84 の誤検知)
  // 中央値ではなく上位(90%点)で測る: 同じコマが2枚ずつ続く絵は前コマ差が 0 と 20 を交互に取り、
  // 中央値だと本編の動きを半分に見積もる(ep044 cL83 の誤検知)
  const jumpAt = Math.max(HEAD_SCAN.jumpDiff, HEAD_SCAN.jumpOverMotion * quantile(refSlice.map((s) => s.diffPrev), 0.9));

  const reasons = new Set<string>();
  let last = -1;
  let prevBad = false;
  const upto = Math.min(window, stats.length);
  for (let i = 0; i < upto; i += 1) {
    const s = stats[i];
    let bad = false;
    const dev = refStd > 0 ? Math.abs(s.std - refStd) / refStd : 0;
    if (!flatClip && (s.std < HEAD_SCAN.blankStd || s.white >= HEAD_SCAN.blankWhite)) {
      reasons.add("白紙");
      bad = true;
    } else if (!flatClip && dev > HEAD_SCAN.settleRatio && (prevBad || (i === 0 && dev > HEAD_SCAN.fadeStartRatio))) {
      // フェードは「白紙・急変・大きく外れた1コマ目」から途切れずに続く区間だけを数える。
      // 起点の無いゆっくりした std の変化はカメラの寄り引きで、ゴミではない(ep043 cL03 / ep045 cL08 の誤検知)
      reasons.add("フェード");
      bad = true;
    }
    const next = stats[i + 1];
    if (next && next.diffPrev >= jumpAt) {
      reasons.add("急変");
      bad = true;
    }
    if (bad) last = i;
    prevBad = bad;
  }
  const garbage = last + 1;
  const skip = garbage > 0 ? garbage + HEAD_SCAN.margin : 0;
  return { skip, garbage, reasons: [...reasons], unsettled: last >= window - 1, refStd, measured: true };
}

/**
 * 推奨値を cuts.json へ当てる。**既存値は小さくしない**(人が目で見て大きめに取った値を尊重する)。
 * 入力は変更せず、新しい object と変更の一覧を返す。推奨 0 のカットには欄を生やさない。
 */
export function applySkips(
  cuts: CutsFile,
  recommended: Record<string, number>,
): { next: CutsFile; changes: { id: string; from: number | undefined; to: number }[] } {
  const next = structuredClone(cuts);
  const changes: { id: string; from: number | undefined; to: number }[] = [];
  for (const [id, rec] of Object.entries(recommended)) {
    const cut = next.cuts[id];
    if (!cut || !(rec > 0)) continue;
    const from = cut.skipHeadFrames;
    const to = Math.max(from ?? 0, Math.floor(rec));
    if (to === (from ?? 0)) continue;
    cut.skipHeadFrames = to;
    changes.push({ id, from, to });
  }
  return { next, changes };
}

export interface HeadScanArgs {
  epId: string;
  chapterId: string | undefined;
  apply: boolean;
  window: number;
  dir: string | undefined;
}

/** 引数を読む。**値の無いオプション・知らないオプションは例外**(黙って既定へ戻さない) */
export function parseArgs(argv: string[]): HeadScanArgs {
  const pos: string[] = [];
  let apply = false;
  let window: number = HEAD_SCAN.window;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === "--window" || a === "--dir") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} に値がありません`);
      i += 1;
      if (a === "--dir") { dir = v; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--window は正の整数で指定する(受け取った値: ${v})`);
      window = n;
      continue;
    }
    if (a.startsWith("--")) throw new Error(`知らないオプション: ${a}`);
    pos.push(a);
  }
  if (!pos[0]) throw new Error("epId がありません");
  return { epId: pos[0], chapterId: pos[1], apply, window, dir };
}

/** クリップ先頭 n コマを縮小グレースケールで読む */
function readHead(mp4: string, n: number): FrameStat[] {
  const { sampleW: w, sampleH: h } = HEAD_SCAN;
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-i", mp4, "-frames:v", String(n),
    "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`ffmpeg の起動に失敗: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg が失敗(${r.status}): ${r.stderr.toString("utf8").slice(0, 300)}`);
  return frameStats(r.stdout, w, h);
}

function main(): void {
  let args: HeadScanArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    console.error("使い方: npm run h3:head-scan -- <epId> [章ID] [--apply] [--window N] [--dir <クリップ置き場>]");
    process.exit(2);
  }
  const cutsPath = join(ROOT, "h3/episodes", args.epId, "cuts.json");
  if (!existsSync(cutsPath)) {
    console.error(`cuts.json がありません: ${relative(ROOT, cutsPath)}`);
    process.exit(2);
  }
  const text = readFileSync(cutsPath, "utf8");
  const cuts = JSON.parse(text) as CutsFile;
  const chapters = args.chapterId ? cuts.chapters.filter((c) => c.id === args.chapterId) : cuts.chapters;
  if (chapters.length === 0) {
    console.error(`章 ${args.chapterId} が cuts.json に無い(ある章: ${cuts.chapters.map((c) => c.id).join(" ")})`);
    process.exit(2);
  }
  // 別の置き場(clips-rejected など)を測った結果を台帳へ書くと、採用していないクリップの値が
  // 本番の assemble に効いてしまう。--apply は既定の置き場のときだけ許す
  if (args.apply && args.dir) {
    console.error("--apply と --dir は併用できない(台帳へ書けるのは既定のクリップ置き場を測ったときだけ)");
    process.exit(2);
  }
  const CLIPS = args.dir ? resolve(args.dir) : clipsDir(args.epId);

  const recommended: Record<string, number> = {};
  const rows: string[] = ["章\tカット\t既存\t推奨\t検出\t理由\t安定std\t先頭コマの輝度std"];
  let flagged = 0;
  let missing = 0;
  const unsettled: string[] = [];
  for (const ch of chapters) {
    for (const id of ch.cuts) {
      const mp4 = join(CLIPS, `${id}.mp4`);
      const known = cuts.cuts[id]?.skipHeadFrames;
      if (!existsSync(mp4)) { missing += 1; continue; }
      let stats: FrameStat[];
      try {
        stats = readHead(mp4, args.window + HEAD_SCAN.refFrames);
      } catch (e) {
        rows.push([ch.id, id, known ?? "-", "?", "-", `読めない(${(e as Error).message.split("\n")[0]})`, "-", "-"].join("\t"));
        continue;
      }
      const r = recommendSkip(stats, { window: args.window });
      recommended[id] = r.skip;
      if (r.skip > 0) flagged += 1;
      if (r.unsettled) unsettled.push(id);
      const head = stats.slice(0, args.window).map((s) => s.std.toFixed(0)).join(" ");
      if (r.skip > 0 || known !== undefined) {
        rows.push([
          ch.id, id, known ?? "-", r.skip + (r.unsettled ? "+" : ""), r.garbage,
          r.reasons.join("・") || "-", r.refStd.toFixed(0), head,
        ].join("\t"));
      }
    }
  }

  console.log(rows.join("\n"));
  const scanned = Object.keys(recommended).length;
  console.log(`\n${scanned}本を測定(窓 ${args.window}コマ)。ゴミコマ候補 ${flagged}本` +
    (missing ? ` / クリップ未生成 ${missing}本` : "") +
    ` / クリップ置き場: ${relative(ROOT, CLIPS).startsWith("..") ? CLIPS : relative(ROOT, CLIPS)}`);
  if (unsettled.length > 0) {
    console.log(`⚠️ 窓の端まで落ち着かない(推奨値は窓で頭打ち・「+」印)${unsettled.length}本: ${unsettled.join(" ")}` +
      ` — --window を広げるか目視で決める`);
  }
  console.log("※ 本編と同じ明るさの「別の絵」(顔・手・文字)が切り替わりなしに溶ける型は拾えない。焼く前の目視は続ける");

  if (!args.apply) {
    console.log("(書き込みなし。--apply で cuts.json へ反映する。既存値は小さくしない)");
    return;
  }
  const { next, changes } = applySkips(cuts, recommended);
  if (changes.length === 0) {
    console.log("--apply: 変更なし");
    return;
  }
  // 元ファイルの末尾改行の有無を保つ(差分を最小にする)
  writeFileSync(cutsPath, JSON.stringify(next, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  console.log(`--apply: ${changes.length}本を書いた: ` +
    changes.map((c) => `${c.id} ${c.from ?? "-"}→${c.to}`).join(" "));
  console.log("※ 反映には h3:assemble(と h3:ambient)の焼き直しが要る");
}

if (process.argv[1] && basename(process.argv[1]) === "head-scan.ts") main();
