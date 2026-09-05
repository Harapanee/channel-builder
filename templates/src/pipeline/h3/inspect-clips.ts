/**
 * 検品の材料を作る。**合否は判定しない。**
 *   npm run h3:inspect -- <epId> <章ID> [--strip cL01,cL02,…] [--max N] [--dir <クリップ置き場>]
 *
 * 出力(既定は review/<epId>/ 配下。`--dir` を使ったときは review/<epId>/<置き場名>/ 配下):
 *   <章>-sheet.png        章のコンタクトシート(まずこれ1枚を見る)
 *   <章>-sheet-1.png …    33本以上の章は32本ずつに分割する(1枚に詰めると1コマが潰れて読めない)
 *   strip-<clipId>.png    6コマ3x2のストリップ(判読できる大きさ)
 *   <章>-metrics.tsv      全クリップの実測値と契約検査の結果
 *
 * Task 9 の較正で、破綻を分離できる機械指標は1つも見つからなかった。したがって
 * 「どのクリップを詳しく見るか」を機械で選ぶ根拠が無い。**既定は章の全クリップ**である。
 * 「鎖区間の端点だけ」に絞る案は、較正で見つかった cL150 / cL154(どちらも鎖区間の中間)を
 * 構造的に取りこぼすと実証された。代表フレーム1枚のシートでも後半進行の破綻は見えない。
 *
 * --strip で対象を明示的に絞ることはできる(直しの確認など、目的が限定されている場合)。
 * --max は暴発防止の上限で、既定 40。超えたら警告して未生成分を明示する。
 */
import { basename, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { framesForSeconds } from "./frames";
import { STRIP, contractIssues, measureClip, stripFrameIndices, stripLayout, type ClipMetrics } from "./clip-metrics";
import { ROOT, clipsDir } from "./config";
import type { CutsFile } from "./types";

const FONT = join(ROOT, "assets/fonts/YuseiMagic-Regular.ttf");
/** 暴発防止の上限。較正で決めた値ではなく、1章が異常に大きいときの安全弁 */
const DEFAULT_MAX_STRIPS = 40;
/**
 * コンタクトシートの体裁。
 * 画像の長辺は API 側で 1568px へ縮むので、**表示される1コマの幅は
 * `1568 / max(列数, 行数×0.5625)`** で決まる(0.5625 = 270/480 のセル比)。
 * 較正は1コマ313pxを「読めない」と実証したので、320px以上を保つには
 * `max(列数, 行数×0.5625) ≤ 4.9` が要る。4列なら8行(=32本)が上限で、
 * このとき1コマは348px。ここを超える章は複数枚へ分ける(37本の ch08 が実際に踏む)。
 */
const SHEET = { cols: 4, rows: 8, cellW: 480, cellH: 270 } as const;
const SHEET_MAX = SHEET.cols * SHEET.rows;

/** ffmpeg を静かに回す。失敗は例外にする(黙って壊れた画像を残さない) */
function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

/** measureClip が落ちたクリップでもストリップは焼きたいので、実デコード数だけ別途取る */
function probeFrameCount(mp4: string): number {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", mp4,
  ], { encoding: "utf8" });
  const n = Number(String(r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** ストリップを焼く。1コマ512px(較正で判読可能と実証)。7秒以下は 6コマ 3x2、7秒超は 9コマ 3x3 */
export function bakeStrip(mp4: string, outPng: string, totalFrames: number, durationSec = 0): number[] {
  const layout = stripLayout(durationSec);
  const idx = stripFrameIndices(totalFrames, layout.frames);
  const sel = idx.map((n) => `eq(n\\,${n})`).join("+");
  ffmpeg([
    "-v", "error", "-i", mp4,
    "-vf", `select='${sel}',scale=${STRIP.cell}:-1,tile=${layout.cols}x${layout.rows}`,
    "-frames:v", "1", "-fps_mode", "passthrough", "-an", "-y", outPng,
  ]);
  return idx;
}

interface SheetClip { id: string; mp4: string; durationSec: number }

/**
 * シートの1コマを抜く。**1本の欠落で章のシートを失わせない。**
 * 切り詰めファイルは尺の申告だけが残るので中央への seek が空振りし、ffmpeg は終了コード0のまま
 * 何も書かずに終わる(実測: 5コマしか読めないコピーで発生)。その状態で xstack へ渡すと
 * 「入力が無い」で章まるごと落ちる = 一番見たい壊れたクリップの材料が消える。
 */
function extractCell(c: SheetClip, frameDir: string): string {
  const png = join(frameDir, `${c.id}.png`);
  rmSync(png, { force: true });
  // 中央 → 先頭 の順に試す(中央が空振りするのは実質「壊れている」ケースだけ)
  for (const seek of [["-ss", (c.durationSec * 0.5).toFixed(3)], []]) {
    try {
      ffmpeg(["-v", "error", ...seek, "-i", c.mp4,
        "-frames:v", "1", "-vf", `scale=${SHEET.cellW}:${SHEET.cellH}`, "-y", png]);
    } catch {
      // 次の手を試す
    }
    if (existsSync(png)) return png;
  }
  ffmpeg(["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${SHEET.cellW}x${SHEET.cellH}`,
    "-frames:v", "1", "-y", png]);
  return png;
}

/** クリップ中央の1枚を並べた章コンタクトシート。**破綻検出には使えない**(較正 §7-3) */
function bakeOneSheet(clips: SheetClip[], frameDir: string, outPng: string): void {
  for (const c of clips) extractCell(c, frameDir);
  const inputs: string[] = [];
  for (const c of clips) inputs.push("-i", join(frameDir, `${c.id}.png`));
  const labels = clips.map((c, i) =>
    `[${i}:v]drawtext=fontfile='${FONT}':text='${c.id}':fontsize=28:fontcolor=white:` +
    `box=1:boxcolor=black@0.7:boxborderw=6:x=8:y=8[c${i}]`);
  if (clips.length === 1) {
    ffmpeg(["-v", "error", "-y", ...inputs, "-filter_complex", `${labels[0]}`, "-map", "[c0]", "-frames:v", "1", outPng]);
    return;
  }
  const layout = clips
    .map((_, i) => `${(i % SHEET.cols) * SHEET.cellW}_${Math.floor(i / SHEET.cols) * SHEET.cellH}`)
    .join("|");
  ffmpeg([
    "-v", "error", "-y", ...inputs,
    "-filter_complex",
    `${labels.join(";")};${clips.map((_, i) => `[c${i}]`).join("")}` +
    `xstack=inputs=${clips.length}:layout=${layout}:fill=black[out]`,
    "-map", "[out]", "-frames:v", "1", outPng,
  ]);
}

/**
 * その章の既存シート(`<章>-sheet.png` / `<章>-sheet-N.png`)を列挙する。
 * **他章のシートと strip-*.png は巻き込まない**(同じ review/<epId>/ に同居している)。
 */
export function staleSheets(outDir: string, chapterId: string): string[] {
  if (!existsSync(outDir)) return [];
  const re = new RegExp(`^${chapterId}-sheet(-\\d+)?\\.png$`);
  return readdirSync(outDir).filter((f) => re.test(f)).sort();
}

/**
 * 章のコンタクトシートを焼く。1枚 32本(4列×8行)を超える章は複数枚へ分ける。
 * 詰め込むと1コマが 320px を切り、較正が「読めない」と実証した領域に入るため。
 * 返り値は書き出したファイル名。
 */
function bakeSheets(clips: SheetClip[], frameDir: string, outDir: string, chapterId: string): string[] {
  // 焼く前に前回のシートを消す。**枚数は本数で決まるので減ることがある** —
  // 33本以上(=2枚)の章を差し戻しで32本以下へ減らすと、書き直されるのは
  // <章>-sheet.png だけで <章>-sheet-1.png / -2.png が古い絵のまま残り、
  // 検品エージェントがそれを読む。破綻の検出が目視だけである以上、材料の鮮度は機能そのもの。
  for (const stale of staleSheets(outDir, chapterId)) rmSync(join(outDir, stale), { force: true });
  if (clips.length <= SHEET_MAX) {
    const name = `${chapterId}-sheet.png`;
    bakeOneSheet(clips, frameDir, join(outDir, name));
    return [name];
  }
  const out: string[] = [];
  for (let i = 0; i * SHEET_MAX < clips.length; i += 1) {
    const name = `${chapterId}-sheet-${i + 1}.png`;
    bakeOneSheet(clips.slice(i * SHEET_MAX, (i + 1) * SHEET_MAX), frameDir, join(outDir, name));
    out.push(name);
  }
  return out;
}

function usage(): never {
  console.error("使い方: npm run h3:inspect -- <epId> <章ID> [--strip cL01,cL02] [--max N] [--dir <クリップ置き場>]");
  process.exit(2);
}

/**
 * オプションの値を取る。**値が無ければ黙って既定へ戻さない。**
 * `--strip` を値なしで末尾に置くと以前は空文字へ潰れ、「絞ったつもりで章の全クリップが焼かれる」
 * 事故になっていた(20本焼ける)。指定したのに効かない、が一番危ない。
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`${name} に値がありません`);
    process.exit(2);
  }
  return v;
}

function main(): void {
  const [epId, chapterId] = process.argv.slice(2);
  if (!epId || !chapterId || epId.startsWith("--") || chapterId.startsWith("--")) usage();

  // 引数の検査は測定(1本3秒・章によっては2分)より先に済ませる
  const defaultClips = clipsDir(epId);
  const dirArg = arg("--dir");
  const CLIPS = dirArg === undefined ? defaultClips : resolve(dirArg);
  const stripArg = arg("--strip");
  const requested = (stripArg ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (stripArg !== undefined && requested.length === 0) {
    console.error("--strip にカットIDがありません(例: --strip cL01,cL02)");
    process.exit(2);
  }
  const maxArg = arg("--max");
  const max = maxArg === undefined ? DEFAULT_MAX_STRIPS : Number(maxArg);
  if (!Number.isInteger(max) || max <= 0) {
    console.error(`--max は正の整数で指定する(受け取った値: ${maxArg})`);
    process.exit(2);
  }

  const epDir = join(ROOT, "h3/episodes", epId);
  const cuts = JSON.parse(readFileSync(join(epDir, "cuts.json"), "utf8")) as CutsFile;
  const chapter = cuts.chapters.find((c) => c.id === chapterId);
  if (!chapter) {
    console.error(`章 ${chapterId} が cuts.json に無い(ある章: ${cuts.chapters.map((c) => c.id).join(" ")})`);
    process.exit(2);
  }

  // 既定以外の置き場から焼いたものは別の場所へ出す。同じ場所へ上書きすると
  // clips-broken/ の strip-cL148.png が採用版の同名ファイルを潰し、読む側が由来を判別できない
  const outDir = CLIPS === defaultClips ? join(ROOT, "review", epId) : join(ROOT, "review", epId, basename(CLIPS));
  const frameDir = join(outDir, ".frames");
  mkdirSync(frameDir, { recursive: true });

  const ids = chapter.cuts.filter((id) => existsSync(join(CLIPS, `${id}.mp4`)));
  const missing = chapter.cuts.filter((id) => !ids.includes(id));
  if (ids.length === 0) {
    console.error(`クリップが1本もありません: ${CLIPS}`);
    process.exit(2);
  }

  // measureClip は ffmpeg を2回回すので1本につき1度だけ呼ぶ
  const metrics = new Map<string, ClipMetrics>();
  const measureFailed = new Map<string, string>();
  for (const id of ids) {
    try {
      metrics.set(id, measureClip(join(CLIPS, `${id}.mp4`)));
    } catch (e) {
      // 落ちたクリップで章全体を止めない。契約違反として立て、ストリップは焼く
      measureFailed.set(id, (e as Error).message);
    }
  }

  const rows = ["id\tframes\tdecoded\twidth\tdur\tdiffMean\tdiffMax\tlumaMax\t契約違反"];
  const broken: string[] = [];
  for (const id of ids) {
    const m = metrics.get(id);
    const cut = cuts.cuts[id];
    const expected = { frames: framesForSeconds(cut.seconds), width: cut.hi ? 1344 : 1152 };
    if (!m) {
      broken.push(id);
      rows.push([id, "-", "-", "-", "-", "-", "-", "-", `計測できていない(${measureFailed.get(id)})`].join("\t"));
      continue;
    }
    const issues = contractIssues(m, expected);
    if (issues.length > 0) broken.push(id);
    rows.push([
      id, m.frames, m.decodedFrames, m.width, m.durationSec.toFixed(2),
      m.frameDiffMean.toFixed(2), m.frameDiffMax.toFixed(2),
      m.lumaStd.length > 0 ? Math.max(...m.lumaStd).toFixed(1) : "-", issues.join(" / "),
    ].join("\t"));
  }
  writeFileSync(join(outDir, `${chapterId}-metrics.tsv`), `${rows.join("\n")}\n`);

  // --- 章コンタクトシート -----------------------------------------------------
  const sheets = bakeSheets(
    ids.map((id) => ({
      id,
      mp4: join(CLIPS, `${id}.mp4`),
      durationSec: metrics.get(id)?.durationSec ?? cuts.cuts[id].seconds,
    })),
    frameDir,
    outDir,
    chapterId,
  );

  // --- ストリップを焼く対象を決める -------------------------------------------
  // 既定は章の全クリップ。機械指標が全滅した以上、絞る根拠が無い(Task 9 の較正)
  const unknown = requested.filter((id) => !ids.includes(id));
  const targets = requested.length > 0 ? requested.filter((id) => ids.includes(id)) : ids;
  const capped = targets.slice(0, max);

  const baked: string[] = [];
  for (const id of capped) {
    // コンテナ申告(frames)ではなく実デコード数で割り付ける。切り詰めファイルに
    // 申告値で select をかけると存在しない番号を指し、コマの抜けたストリップになる
    const frames = metrics.get(id)?.decodedFrames ?? probeFrameCount(join(CLIPS, `${id}.mp4`));
    if (frames <= 0) {
      console.error(`${id}: フレーム数が取れずストリップを焼けない`);
      continue;
    }
    bakeStrip(join(CLIPS, `${id}.mp4`), join(outDir, `strip-${id}.png`), frames, metrics.get(id)?.durationSec ?? cuts.cuts[id]?.seconds ?? 0);
    baked.push(id);
  }

  // リポジトリの外を指しているときは絶対パスのまま出す(../ の連鎖は読めない)
  const rel = (p: string): string => (relative(ROOT, p).startsWith("..") ? p : relative(ROOT, p));
  console.log(`${chapterId}: ${ids.length}本を測定。契約違反 ${broken.length}本` +
    (broken.length ? `(${broken.join(" ")})` : ""));
  if (missing.length > 0) console.log(`未生成 ${missing.length}本: ${missing.join(" ")}`);
  if (unknown.length > 0) console.log(`--strip に無いカット: ${unknown.join(" ")}`);
  console.log("※ 契約違反は「申告どおりの尺・実デコード数・解像度で出ているか」だけ。破綻の有無とは無関係");
  console.log(`ストリップ ${baked.length}本: ${baked.join(" ") || "なし"}` +
    (targets.length > capped.length ? `(上限 ${max} を超えた ${targets.length - capped.length}本は未生成)` : ""));
  // 検品の報告が「どの焼き出しを見たか」を機械的に示せるように、焼いた材料の台帳を残す。
  // ep026 で検品エージェントの報告が何度も食い違い、古いストリップを再生成後の絵として
  // 読んでいた事故があった(2026-09-04)。報告はこの bakedAt と枚数を引用する義務を負う。
  const manifest = {
    chapterId,
    bakedAt: new Date().toISOString(),
    clipCount: ids.length,
    sheets,
    strips: ids
      .map((id) => join(outDir, `strip-${id}.png`))
      .filter((f) => existsSync(f))
      .map((f) => ({ file: f, mtimeMs: Math.round(statSync(f).mtimeMs) })),
  };
  writeFileSync(join(outDir, `${chapterId}-manifest.json`), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`シート ${sheets.length}枚: ${sheets.join(" ")}`);
  console.log(`台帳: ${chapterId}-manifest.json(bakedAt ${manifest.bakedAt} / ストリップ ${manifest.strips.length}枚)`);
  console.log("※ 機械指標では破綻を検出できない(較正で実証)。シートとストリップを目で見て判定すること");
  console.log(`出力先: ${rel(outDir)}/ (クリップ置き場: ${rel(CLIPS)})`);
}

if (process.argv[1] && basename(process.argv[1]) === "inspect-clips.ts") main();
