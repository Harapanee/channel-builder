/**
 * evolink.ai 画像生成クライアント(非同期タスクAPI)。
 *
 * フロー: POST /v1/images/generations → タスクID → GET /v1/tasks/{id} をポーリング
 *        → 結果URLを即ダウンロード(結果URLは24時間で失効するため保存必須)。
 *
 * 参照画像(--ref)はローカルファイルを data URI として image_urls に渡す。
 *
 * CLI:
 *   tsx src/pipeline/gen-image.ts --prompt "..." --out out.png \
 *     [--model gemini-3-pro-image-preview] [--ref ref1.png --ref ref2.png] \
 *     [--size 1:1] [--resolution 1K] [--n 1] [--skip-paint-check]
 *
 * 塗り検査: 緑バック素材(外周緑率>60%)は保存直後に緑面積を検査し、
 * PAINT_GATE_RATIO 超過(=キャラが塗られていない線画の疑い)なら exit 2。
 */
import fs from "node:fs";
import path from "node:path";
import { analyzeGreenCoverage, PAINT_GATE_RATIO } from "./remove-bg";

const API_BASE = "https://api.evolink.ai";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300_000;

function loadApiKey(): string {
  const envPath = path.join(process.cwd(), ".env");
  const line = fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith("EVOLINK_API_KEY="));
  if (!line) throw new Error(".env に EVOLINK_API_KEY がありません");
  return line.slice("EVOLINK_API_KEY=".length).trim();
}

function fileToDataUri(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  const b64 = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

export interface GenImageOptions {
  prompt: string;
  outPath: string;
  model?: string;
  refPaths?: string[];
  size?: string;
  resolution?: string;
  n?: number;
}

export async function generateImage(opts: GenImageOptions): Promise<string[]> {
  const key = loadApiKey();
  const body: Record<string, unknown> = {
    model: opts.model ?? "gemini-3-pro-image-preview",
    prompt: opts.prompt,
    size: opts.size ?? "1:1",
    resolution: opts.resolution ?? "1K",
    n: opts.n ?? 1,
  };
  if (opts.refPaths && opts.refPaths.length > 0) {
    body.image_urls = opts.refPaths.map(fileToDataUri);
  }

  const res = await fetch(`${API_BASE}/v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`生成リクエスト失敗 HTTP ${res.status}: ${await res.text()}`);
  }
  const task = (await res.json()) as { id?: string; status?: string; error?: unknown };
  if (!task.id) throw new Error(`タスクIDが返りませんでした: ${JSON.stringify(task)}`);
  console.error(`task ${task.id} 開始 (model=${body.model})`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let result: any;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`タイムアウト: task ${task.id}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await fetch(`${API_BASE}/v1/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!poll.ok) throw new Error(`ポーリング失敗 HTTP ${poll.status}: ${await poll.text()}`);
    result = await poll.json();
    if (result.status === "completed") break;
    if (result.status === "failed" || result.status === "error") {
      throw new Error(`生成失敗: ${JSON.stringify(result.error ?? result)}`);
    }
    process.stderr.write(".");
  }
  console.error("");

  // results の形は [{url}] / ["url"] / {images:[...]} 等の揺れに防御的に対応する
  const raw = result.results ?? result.result ?? result.images ?? result.data ?? [];
  const urls: string[] = (Array.isArray(raw) ? raw : [raw])
    .map((r: any) => (typeof r === "string" ? r : r?.url ?? r?.image_url ?? null))
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error(`結果URLが見つかりません: ${JSON.stringify(result).slice(0, 500)}`);
  }

  const saved: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const out =
      urls.length === 1
        ? opts.outPath
        : opts.outPath.replace(/(\.[a-z]+)$/i, `-${i + 1}$1`);
    const dl = await fetch(urls[i]);
    if (!dl.ok) throw new Error(`ダウンロード失敗 HTTP ${dl.status}: ${urls[i]}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
    saved.push(out);
    console.error(`saved: ${out}`);
  }
  if (result.usage) console.error(`usage: ${JSON.stringify(result.usage)}`);
  return saved;
}

// ---- CLI ----
async function main() {
  const args = process.argv.slice(2);
  const opts: GenImageOptions = { prompt: "", outPath: "", refPaths: [] };
  let skipPaintCheck = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--prompt") opts.prompt = args[++i];
    else if (a === "--out") opts.outPath = args[++i];
    else if (a === "--model") opts.model = args[++i];
    else if (a === "--ref") opts.refPaths!.push(args[++i]);
    else if (a === "--size") opts.size = args[++i];
    else if (a === "--resolution") opts.resolution = args[++i];
    else if (a === "--n") opts.n = Number(args[++i]);
    else if (a === "--skip-paint-check") skipPaintCheck = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (!opts.prompt || !opts.outPath) {
    console.error(
      "usage: gen-image.ts --prompt <text> --out <file> [--model m] [--ref f]... [--skip-paint-check]"
    );
    process.exit(1);
  }
  const saved = await generateImage(opts);
  if (skipPaintCheck) return;
  let bad = 0;
  for (const f of saved) {
    const g = await analyzeGreenCoverage(f);
    if (g.borderGreenRatio > 0.6 && g.totalGreenRatio > PAINT_GATE_RATIO) {
      console.error(
        `NG: ${f} は緑面積 ${(g.totalGreenRatio * 100).toFixed(1)}%(閾値 ${PAINT_GATE_RATIO * 100}%)— キャラの塗り省略(未着色線画)の疑い。`
      );
      bad++;
    }
  }
  if (bad > 0) {
    console.error(
      "  この画像は不採用にし、プロンプトの FULLY PAINTED 句を強調し、髪・全衣類・小物に色nameを付けて再生成すること(意図的な例外のみ --skip-paint-check)。"
    );
    process.exit(2);
  }
}

if (process.argv[1] && process.argv[1].endsWith("gen-image.ts")) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
