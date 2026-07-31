/**
 * scaffold-composition.ts — HyperFrames composition の骨格を timing.json から機械生成する。
 *
 * 目的: 工程8で毎回1体のエージェントが80分かけて作っていた「決定論的な部分」
 *       (clipセクション・字幕・音声配線・素材テーブル・タイムライン足場)を
 *       スクリプトに落とし、章グループの実装を最初から並列で始められるようにする。
 *
 * 生成するもの:
 *   - <head>(GSAP・チャンネル様式CSS・hf-helpers.js・@font-face・#root)
 *   - #root(data-composition-id / data-duration)
 *   - timing.json の全行ぶんの空 clip セクション(data-start / data-duration)
 *   - timing.json の全行ぶんの字幕
 *   - プリミックス音声1本(narration/master.mp3。無ければ narration.wav)
 *   - 素材テーブル A(storyboard.md の使用素材列 → library.json →
 *     PNGのアルファから不透明bboxを実測。pic() が「見える大きさ」で置けるようになる)
 *   - SCENES = {} と章グループごとの SPLICE マーカー、未実装clipのフォールバック、
 *     hfBuild / hfSubtitles / window.__timelines 登録
 *
 * 生成しないもの: 場面演出(SCENES.cLxx の中身)。これは scene-implementer の仕事。
 *
 * 使い方:
 *   npx tsx src/pipeline/scaffold-composition.ts episodes/<epId> [options]
 *     --groups 3                        章グループ数(既定3。SPLICEマーカーの数)
 *     --groups cL01-cL50,cL51-cL108,... 明示的な範囲指定(storyboard の章割に合わせる)
 *     --title "..."                     <title>(既定: チャンネル名 + epId)
 *     --out <path>                      出力先(既定: <epDir>/composition.html)
 *     --force                           既存ファイルを上書きする
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

type TimingLine = { lineId: string; text: string; startSec: number; endSec: number };
type Timing = { lines: TimingLine[]; totalDurationSec?: number; durationSec?: number };
type LibraryAsset = { assetId: string; kind: string; subject: string; variant: string; file: string };

const ROOT = process.cwd();

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** subject + variant → JS識別子(rainforest-canopy / base → rainforestCanopyBase) */
function camelKey(subject: string, variant: string): string {
  const parts = `${subject}-${variant}`.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()))
    .join("");
}

/** 不透明部分の相対bbox [x0,y0,x1,y1]。アルファを持たない画像は全面。 */
async function opaqueBBox(file: string): Promise<[number, number, number, number]> {
  const img = sharp(file);
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return [0, 0, 1, 1];
  if (!meta.hasAlpha) return [0, 0, 1, 1];
  const { data, info } = await img
    .resize({ width: Math.min(w, 256), fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rw = info.width;
  const rh = info.height;
  const ch = info.channels;
  let x0 = rw, y0 = rh, x1 = -1, y1 = -1;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (data[(y * rw + x) * ch + (ch - 1)] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return [0, 0, 1, 1];
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return [r(x0 / rw), r(y0 / rh), r((x1 + 1) / rw), r((y1 + 1) / rh)];
}

/** storyboard.md の clip表「使用素材」列から assetId を拾う */
function assetIdsFromStoryboard(sbPath: string): string[] {
  if (!fs.existsSync(sbPath)) return [];
  const ids = new Set<string>();
  for (const line of fs.readFileSync(sbPath, "utf8").split("\n")) {
    if (!/^\|\s*cL\d+/.test(line)) continue;
    for (const m of line.matchAll(/\b(char|prop|place)_[a-z0-9_]+/g)) ids.add(m[0]);
  }
  return [...ids].sort();
}

function parseGroups(spec: string | undefined, clipIds: string[]): { label: string; from: string; to: string }[] {
  if (spec && /cL\d+\s*-\s*cL\d+/.test(spec)) {
    return spec.split(",").map((s, i) => {
      const [from, to] = s.trim().split(/\s*-\s*/);
      return { label: `G${i + 1}`, from, to };
    });
  }
  const n = Math.max(1, parseInt(spec ?? "3", 10) || 3);
  const size = Math.ceil(clipIds.length / n);
  const out: { label: string; from: string; to: string }[] = [];
  for (let i = 0; i < n; i++) {
    const slice = clipIds.slice(i * size, (i + 1) * size);
    if (slice.length) out.push({ label: `G${i + 1}`, from: slice[0], to: slice[slice.length - 1] });
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function main() {
  const epDir = process.argv[2];
  if (!epDir || epDir.startsWith("--")) fail("usage: scaffold-composition.ts episodes/<epId> [--groups 3] [--force]");
  const epId = path.basename(epDir);

  const timingPath = path.join(epDir, "timing.json");
  if (!fs.existsSync(timingPath)) fail(`${timingPath} が無い(工程4のTTSを先に通す)`);
  const timing: Timing = JSON.parse(fs.readFileSync(timingPath, "utf8"));
  const lines = timing.lines ?? [];
  if (!lines.length) fail("timing.json に lines が無い");
  const total = timing.totalDurationSec ?? timing.durationSec ?? lines[lines.length - 1].endSec;

  const outPath = arg("out") ?? path.join(epDir, "composition.html");
  if (fs.existsSync(outPath) && !hasFlag("force")) {
    fail(`${outPath} は既に存在する。上書きするなら --force(既存の実装は失われる)`);
  }

  // チャンネル情報
  const sys = JSON.parse(fs.readFileSync(path.join(ROOT, ".channel-system.json"), "utf8"));
  const channelPrefix = String(sys.channelId ?? "ch").split("-")[0];
  const compId = `${channelPrefix}-${epId.split("-")[0]}`;
  const title = arg("title") ?? `${sys.channelName ?? channelPrefix} ${epId}`;

  // チャンネル様式CSS(assets/hf/ 直下の唯一の *-style.css)
  const hfDir = path.join(ROOT, "assets", "hf");
  const styleCss = fs.readdirSync(hfDir).find((f) => f.endsWith("-style.css"));
  if (!styleCss) fail("assets/hf/ に <slug>-style.css が無い");
  const varPrefix = `--${styleCss.replace("-style.css", "")}-`;

  // 音声(プリミックス1本)
  const master = ["narration/master.mp3", "narration/narration.wav"]
    .find((p) => fs.existsSync(path.join(epDir, p)));
  if (!master) fail(`${epDir}/narration/ に master.mp3 も narration.wav も無い`);
  // ★無警告でフォールバックしない。ep012 はここで narration.wav が黙って配線され、
  //   BGM/SEを乗せる工程を飛ばしたまま check緑 → レンダー → 承認まで通った。
  if (master.endsWith("narration.wav")) {
    console.warn(
      `WARN: narration/master.mp3 が無いので narration.wav を配線しました。**この状態ではBGMもSEも鳴りません**。\n` +
        `      audio-cues.json を用意 → npm run audio-mix ${path.relative(ROOT, epDir)} → <audio src> を master.mp3 へ差し替えること。\n` +
        `      npm run check:audio ${path.relative(ROOT, epDir)} がレンダー前ゲートとしてこれを検査します。`
    );
  }

  // 素材テーブル
  const libPath = path.join(ROOT, "assets", "library.json");
  const lib: { assets: LibraryAsset[] } = JSON.parse(fs.readFileSync(libPath, "utf8"));
  const byId = new Map(lib.assets.map((a) => [a.assetId, a]));
  const wanted = assetIdsFromStoryboard(path.join(epDir, "storyboard.md"));
  const missing = wanted.filter((id) => !byId.has(id));
  const entries: string[] = [];
  for (const id of wanted) {
    const a = byId.get(id);
    if (!a) continue;
    const file = path.join(ROOT, "assets", a.file);
    if (!fs.existsSync(file)) {
      console.warn(`  ! 実ファイルが無い: ${a.file}(${id})`);
      continue;
    }
    const meta = await sharp(file).metadata();
    const ar = (meta.height ?? 1) / (meta.width ?? 1);
    const b = await opaqueBBox(file);
    entries.push(
      `  ${camelKey(a.subject, a.variant)}: { p: "assets/${a.file}", ar: ${ar.toFixed(4)}, b: [${b.join(", ")}] }, // ${id}`
    );
  }

  // clip / 字幕
  const clipRows: string[] = [];
  const subRows: string[] = [];
  const clipIds: string[] = [];
  // 先に開始秒を3桁へ丸め、尺は「丸めた開始秒の差」で出す。
  // 生の差を丸めると start+duration が次の start を 0.001 秒超え、
  // HFの overlapping_clips_same_track が全clipで error になる。
  const starts = lines.map((ln) => Number(ln.startSec.toFixed(3)));
  const endAll = Number(total.toFixed(3));
  lines.forEach((ln, i) => {
    const clipId = `c${ln.lineId}`;
    clipIds.push(clipId);
    const start = starts[i];
    const dur = (i + 1 < lines.length ? starts[i + 1] : endAll) - start;
    const s = start.toFixed(3);
    const d = dur.toFixed(3);
    // 最終行の字幕だけは尺の終端まで伸ばさない。終端フレームで字幕が残っていると
    // caption-zone(y0=.82)の最終サンプルに当たり error になる。
    const subDur = i + 1 < lines.length ? dur : Math.max(0.5, Number(ln.endSec.toFixed(3)) - start);
    clipRows.push(
      `      <section class="clip scene" id="${clipId}" data-start="${s}" data-duration="${d}" data-track-index="1"></section>`
    );
    subRows.push(
      `      <div class="subtitle clip" id="sub-${ln.lineId}" data-start="${s}" data-duration="${subDur.toFixed(3)}" data-track-index="40"><span class="sub-inner">${esc(ln.text)}</span></div>`
    );
  });

  const groups = parseGroups(arg("groups"), clipIds);
  const spliceLines = groups
    .map((g) => `/* ===== SPLICE:${g.label} (${g.from}-${g.to}) ===== */`)
    .join("\n");

  const gsapLocal = fs.existsSync(path.join(ROOT, "assets/vendor/gsap.min.js"));
  const gsapSrc = gsapLocal
    ? `    <script src="assets/vendor/gsap.min.js"></script>\n    <script src="assets/vendor/MotionPathPlugin.min.js"></script>`
    : `    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>\n    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/MotionPathPlugin.min.js"></script>`;

  // 共通ヘルパーは <script src> ではなく生成時に埋め込む。
  // HFのコンパイラは外部スクリプトを取り込まず、composition は単体で完結している必要がある。
  const helpersPath = path.join(hfDir, "hf-helpers.js");
  if (!fs.existsSync(helpersPath)) fail("assets/hf/hf-helpers.js が無い");
  // `</script` がコメント内にあるだけでインラインscriptが途中で閉じるため必ず退避する
  const helpers = fs.readFileSync(helpersPath, "utf8").replace(/<\/script/gi, "<\\/script");

  const html = `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=1920, height=1080">
    <title>${esc(title)}</title>
${gsapSrc}
    <link rel="stylesheet" href="assets/hf/${styleCss}">
    <style>
    /* 同梱TTFはプロジェクトルート基準の相対パスで宣言する(非バンドルフォントの必須規約) */
    @font-face{font-family:"Yusei Magic";src:local("Yusei Magic"),url("assets/fonts/YuseiMagic-Regular.ttf") format("truetype");font-weight:400;font-style:normal;font-display:block;}
    #root{position:relative;width:1920px;height:1080px;overflow:hidden;background:var(${varPrefix}paper);font-family:var(${varPrefix}font);color:var(${varPrefix}ink);}
    /* 構造クラス(.clip / .bg / .sp / .grain / .placard / .subtitle 等)は
       assets/hf/${styleCss} が持つ。ここにはこの回だけの追加様式を書く。 */
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${compId}" data-start="0" data-width="1920" data-height="1080" data-duration="${total.toFixed(3)}">

      <!-- ===== MEDIA: ナレーション+BGM+SEのプリミックス1本(audio-cues.json 由来) ===== -->
      <audio id="master" src="${epDir}/${master}" data-start="0" data-duration="${total.toFixed(3)}" data-track-index="10" data-volume="1"></audio>

      <!-- ===== SCENE CLIPS(track 1・timing.json の全${lines.length}行を1:1被覆) ===== -->
${clipRows.join("\n")}

      <!-- ===== SUBTITLES(track 40) ===== -->
${subRows.join("\n")}
    </div>

    <script>
/* ===========================================================================
 * ${epId} composition
 * 骨格は scaffold-composition.ts が生成。場面演出(SCENES.cLxx)を書き足す。
 * 単一 paused timeline を window.__timelines["${compId}"] に登録する。
 * 決定論のみ(Date.now / Math.random 不使用。ゆらぎは prng(seed))。
 * =========================================================================== */
/* --- assets/hf/hf-helpers.js を生成時に埋め込み(共通ヘルパー。直接編集しない) --- */
${helpers}
/* --- ここから ${epId} 固有 --- */

gsap.registerPlugin(MotionPathPlugin);
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });

/* 素材テーブル: p=パス / ar=高さ÷幅 / b=不透明部の相対bbox[x0,y0,x1,y1]
   b は実PNGのアルファから実測済み。pic() はこれを使って「見える大きさ・見える中心」で置く。 */
const A = {
${entries.join("\n")}
};

/* 回固有の追加色があればここに書く(基本5色はCSS変数から自動で入る) */
const EP_PAL = {};

hfBind({ tl: tl, A: A, pal: EP_PAL, varPrefix: "${varPrefix}" });
hfDefs();

/* ============================== SCENES ============================== */
const SCENES = {};

${spliceLines}

/* ------------------------------------------------------------------ *
 * 未実装clipのフォールバック。実装が入るまで検査を通すための暫定表示で、
 * 完成時点で missing が 0 になっていること(下のログで確認する)。
 * ------------------------------------------------------------------ */
function fallbackScene(el, id, g, D) {
  paper(el);
  const t = mk("div", "diagram-text", el);
  t.textContent = id;
  css(t, { position: "absolute", left: "0px", top: "48%", width: "1920px", textAlign: "center", fontSize: "48px", opacity: "0.25" });
  tl.fromTo(t, { y: -6 }, { y: 6, duration: Math.max(0.4, D), ease: "sine.inOut" }, g);
  grain(el);
}

const __built = hfBuild(SCENES, fallbackScene);
if (__built.missing.length) console.warn("[scaffold] 未実装clip " + __built.missing.length + "件: " + __built.missing.join(","));

hfSubtitles();

window.__timelines["${compId}"] = tl;
    </script>
  </body>
</html>
`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  console.log(`OK: ${outPath}`);
  console.log(`  composition-id : ${compId}`);
  console.log(`  尺             : ${total.toFixed(3)}秒`);
  console.log(`  clip / 字幕    : ${lines.length} / ${lines.length}(timing.json 全行を1:1被覆)`);
  console.log(`  音声           : ${master}`);
  console.log(`  素材テーブル   : ${entries.length}件(storyboard.md の使用素材列から。bboxはPNG実測)`);
  if (missing.length) console.log(`  ! library未登録: ${missing.join(", ")}`);
  console.log(`  章グループ     : ${groups.map((g) => `${g.label}=${g.from}-${g.to}`).join(" / ")}`);
  console.log(`  次: 各グループの scene-implementer が SPLICE マーカー行へ SCENES.cLxx を差し込む`);
}

main().catch((e) => fail(String(e?.stack ?? e)));
