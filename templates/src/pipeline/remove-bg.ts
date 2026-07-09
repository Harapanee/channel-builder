/**
 * 背景除去(クロマキー / flood-fill の自動判別)。
 *
 * 【標準: クロマキー方式】透過前提のAI素材は「純緑(#00FF00)のグリーンバック」で
 * 生成する(bible §10)。緑はチャンネルパレット(黒・藍・赤・黄・紙色)と衝突せず、
 * 除去は色距離だけで決まるため、輪郭の閉じ・背景の明度に依存しない:
 *  - 輪郭線に隙間があっても内部に漏れない(flood-fillの構造的弱点を解消)
 *  - 背景がやや暗く生成されてもしきい値調整が不要
 *  - エッジの緑かぶり(スピル)は除去時に自動補正する
 *
 * 【後方互換: flood-fill方式】旧素材(オフホワイト背景)向け。外周からのBFSで
 * 到達可能な明色ピクセルのみ透明化(内部の白は輪郭で囲まれ保持される)。
 *
 * モードは自動判別(外周の緑率>60%でクロマキー)。--mode で強制可。
 *
 * CLI: tsx src/pipeline/remove-bg.ts <in.png> <out.png>
 *        [--mode auto|chroma|flood] [--threshold 225]
 */
import sharp from "sharp";

const DEFAULT_LUMA_THRESHOLD = 225;

/**
 * 塗り検査の閾値。キャラが塗られず線画になると背景の緑がキャラ内部に透け、
 * 緑面積(=除去率)が跳ね上がる(実測: 正常76% / 塗り省略92〜95%)。
 * 超過は「未着色線画」として失敗させる。意図的な例外のみ --force / --skip-paint-check。
 */
export const PAINT_GATE_RATIO = 0.88;

// クロマキー判定: 強い緑(確実に背景)と弱い緑(エッジのぼかし帯)
const isStrongGreen = (r: number, g: number, b: number) =>
  g > 90 && g > r * 1.35 && g > b * 1.35;
const isSoftGreen = (r: number, g: number, b: number) =>
  g > 70 && g > r * 1.12 && g > b * 1.12;

/** クロマキー除去 + エッジのスピル(緑かぶり)補正。尺度は色比のみで明度非依存。 */
async function chromaKey(
  inPath: string,
  outPath: string
): Promise<{ width: number; height: number; removedRatio: number }> {
  const { data, info } = await sharp(inPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  let removed = 0;
  for (let idx = 0; idx < width * height; idx++) {
    const o = idx * channels;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (isStrongGreen(r, g, b)) {
      data[o + 3] = 0;
      removed++;
    } else if (isSoftGreen(r, g, b)) {
      // エッジ帯: 半透明化 + スピル補正(緑をr/bの最大値まで抑える)
      data[o + 3] = Math.floor(data[o + 3] * 0.45);
      data[o + 1] = Math.max(r, b);
    } else if (g > Math.max(r, b) * 1.05) {
      // 残存ピクセルの軽微な緑かぶりを補正(パレットに緑は存在しないため安全)
      data[o + 1] = Math.max(r, b);
    }
  }

  await sharp(data, { raw: { width, height, channels: channels as 4 } })
    .png()
    .toFile(outPath);
  return { width, height, removedRatio: removed / (width * height) };
}

/** 緑バック素材の塗り検査用: 外周と全体の強緑率を測る(gen-image.ts が生成直後に使う)。 */
export async function analyzeGreenCoverage(
  inPath: string
): Promise<{ borderGreenRatio: number; totalGreenRatio: number }> {
  const { data, info } = await sharp(inPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const isG = (x: number, y: number) => {
    const o = (y * width + x) * channels;
    return isStrongGreen(data[o], data[o + 1], data[o + 2]);
  };
  let borderGreen = 0;
  let borderTotal = 0;
  for (let x = 0; x < width; x += 8) {
    if (isG(x, 0)) borderGreen++;
    if (isG(x, height - 1)) borderGreen++;
    borderTotal += 2;
  }
  for (let y = 0; y < height; y += 8) {
    if (isG(0, y)) borderGreen++;
    if (isG(width - 1, y)) borderGreen++;
    borderTotal += 2;
  }
  let totalGreen = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isG(x, y)) totalGreen++;
    }
  }
  return {
    borderGreenRatio: borderGreen / borderTotal,
    totalGreenRatio: totalGreen / (width * height),
  };
}

/** 外周ピクセルの緑率からモードを自動判別する。 */
async function detectMode(inPath: string): Promise<"chroma" | "flood"> {
  const { data, info } = await sharp(inPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let green = 0;
  let total = 0;
  const check = (x: number, y: number) => {
    const o = (y * width + x) * channels;
    if (isStrongGreen(data[o], data[o + 1], data[o + 2])) green++;
    total++;
  };
  for (let x = 0; x < width; x += 8) {
    check(x, 0);
    check(x, height - 1);
  }
  for (let y = 0; y < height; y += 8) {
    check(0, y);
    check(width - 1, y);
  }
  return green / total > 0.6 ? "chroma" : "flood";
}

export async function removeBackground(
  inPath: string,
  outPath: string,
  lumaThreshold: number = DEFAULT_LUMA_THRESHOLD
): Promise<{ width: number; height: number; removedRatio: number }> {
  const { data, info } = await sharp(inPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const isBg = (idx: number): boolean => {
    const r = data[idx * channels];
    const g = data[idx * channels + 1];
    const b = data[idx * channels + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return luma >= lumaThreshold;
  };

  // BFS: 外周から到達可能な背景ピクセル集合
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const idx = y * width + x;
    if (!visited[idx] && isBg(idx)) {
      visited[idx] = 1;
      queue.push(idx);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  // 透明化 + 1pxフェザリング
  let removed = 0;
  for (let idx = 0; idx < width * height; idx++) {
    if (visited[idx]) {
      data[idx * channels + 3] = 0;
      removed++;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx]) continue;
      const nearBg =
        (x > 0 && visited[idx - 1]) ||
        (x < width - 1 && visited[idx + 1]) ||
        (y > 0 && visited[idx - width]) ||
        (y < height - 1 && visited[idx + width]);
      if (nearBg) {
        data[idx * channels + 3] = Math.floor(data[idx * channels + 3] / 2);
      }
    }
  }

  await sharp(data, { raw: { width, height, channels: channels as 4 } })
    .png()
    .toFile(outPath);

  return { width, height, removedRatio: removed / (width * height) };
}

// ---- CLI ----
async function main() {
  const raw = process.argv.slice(2);
  const thrArg = raw.indexOf("--threshold");
  const threshold = thrArg >= 0 ? Number(raw[thrArg + 1]) : DEFAULT_LUMA_THRESHOLD;
  const modeArg = raw.indexOf("--mode");
  const modeOpt = modeArg >= 0 ? raw[modeArg + 1] : "auto";
  const force = raw.includes("--force");
  const consumed = new Set([thrArg + 1, modeArg + 1].filter((i) => i > 0));
  const args = raw.filter((a, i) => !a.startsWith("--") && !consumed.has(i));
  if (args.length !== 2 || !["auto", "chroma", "flood"].includes(modeOpt)) {
    console.error(
      "usage: remove-bg.ts <in.png> <out.png> [--mode auto|chroma|flood] [--threshold 225] [--force]"
    );
    process.exit(1);
  }
  const mode = modeOpt === "auto" ? await detectMode(args[0]) : modeOpt;
  const r =
    mode === "chroma"
      ? await chromaKey(args[0], args[1])
      : await removeBackground(args[0], args[1], threshold);
  if (mode === "chroma" && r.removedRatio > PAINT_GATE_RATIO && !force) {
    console.error(
      `NG: 背景除去率 ${(r.removedRatio * 100).toFixed(1)}% が ${PAINT_GATE_RATIO * 100}% を超過 — キャラの塗り省略(未着色線画)の疑い。`
    );
    console.error(
      "  この画像は不採用にし、プロンプトの FULLY PAINTED 句を強調し、髪・全衣類・小物に色nameを付けて再生成すること(意図的な例外のみ --force)。"
    );
    process.exit(2);
  }
  console.log(
    `OK: ${args[1]} (${r.width}x${r.height}, mode=${mode}, 背景除去率 ${(r.removedRatio * 100).toFixed(1)}%)`
  );
}

if (process.argv[1] && process.argv[1].endsWith("remove-bg.ts")) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
