#!/usr/bin/env node
/**
 * サムネ画像の計測(docs/thumbnail-principles.md の機械検査部分)。
 *
 * 実証済みの合否基準は「1280x720であること」のみ(YouTube Test & Compare は
 * 1枚でも720p未満だと全案を480pへ強制ダウンスケールする)。コントラスト等は
 * 閾値合否にせず、計測値の記録と3案内の相対警告に留める(数値閾値を主張する
 * 国内ブログ由来のルールはリサーチの敵対検証で全て棄却されたため。閾値は
 * publish/thumb-test.json の勝敗蓄積から将来チャンネル別に導出する)。
 *
 * self-test: npx tsx src/pipeline/thumb-metrics.ts --self-test
 */
import sharp from "sharp";

export type MeasuredPng = {
  width: number;
  height: number;
  /** 輝度(0〜1)の標準偏差 = RMSコントラスト。視聴数の上位予測特徴(IEEE TKDE 2017) */
  rmsContrast: number;
  /** Hasler & Süsstrunk (2003) のカラフルネス指標(0〜255系。目安: <15無彩 / 33〜45中 / 59〜快彩) */
  colorfulness: number;
  /** 平均輝度(0〜1) */
  meanLuminance: number;
};

export type VariantNote = "lowestContrast" | "quadrantMismatch";

export async function measurePng(input: string | Buffer): Promise<MeasuredPng> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sumL = 0;
  let sumL2 = 0;
  let sumRg = 0;
  let sumRg2 = 0;
  let sumYb = 0;
  let sumYb2 = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sumL += l;
    sumL2 += l * l;
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    sumRg += rg;
    sumRg2 += rg * rg;
    sumYb += yb;
    sumYb2 += yb * yb;
  }
  const meanL = sumL / n;
  const varL = Math.max(0, sumL2 / n - meanL * meanL);
  const meanRg = sumRg / n;
  const varRg = Math.max(0, sumRg2 / n - meanRg * meanRg);
  const meanYb = sumYb / n;
  const varYb = Math.max(0, sumYb2 / n - meanYb * meanYb);
  // Hasler & Süsstrunk (2003): M = σ_rgyb + 0.3 μ_rgyb
  const colorfulness =
    Math.sqrt(varRg + varYb) + 0.3 * Math.hypot(meanRg, meanYb);
  return {
    width: info.width,
    height: info.height,
    rmsContrast: Math.sqrt(varL),
    colorfulness,
    meanLuminance: meanL,
  };
}

export function relativeNotes(variants: MeasuredPng[]): VariantNote[][] {
  const notes: VariantNote[][] = variants.map(() => []);
  // 3案内の相対警告のみ(絶対閾値の合否ではない)
  if (variants.length >= 2) {
    const max = Math.max(...variants.map((v) => v.rmsContrast));
    let minIdx = 0;
    variants.forEach((v, i) => {
      if (v.rmsContrast < variants[minIdx].rmsContrast) minIdx = i;
    });
    if (max > 0 && variants[minIdx].rmsContrast < max * 0.7) {
      notes[minIdx].push("lowestContrast");
    }
  }
  // カラフルネス×明度の象限不一致(Koh & Cui 2022: 高×高 / 低×低 の一致が有効)。
  // 境界はHasler-Süsstrunk原論文のカテゴリ(33 / 59)と輝度の保守的な帯(0.4 / 0.55)。
  // 中間帯はフラグしない。情報提供でありチャンネル様式の否定ではない。
  variants.forEach((v, i) => {
    const colorful = v.colorfulness >= 59;
    const muted = v.colorfulness < 33;
    const bright = v.meanLuminance >= 0.55;
    const dark = v.meanLuminance < 0.4;
    if ((colorful && dark) || (muted && bright)) {
      notes[i].push("quadrantMismatch");
    }
  });
  return notes;
}

export function resolutionErrors(
  variants: { file: string; width: number; height: number }[]
): string[] {
  return variants
    .filter((v) => v.width !== 1280 || v.height !== 720)
    .map(
      (v) =>
        `${v.file}: ${v.width}x${v.height}(1280x720必須 — Test & Compareは720p未満が1枚でもあると全案480pへ劣化)`
    );
}

export async function composeMobilePreview(
  files: string[],
  outPath: string
): Promise<void> {
  // スマホ小面積での見え方確認用(YouTubeの実表示pxは非公表。168x94は目安)
  const w = 168;
  const h = 94;
  const gap = 8;
  const resized = await Promise.all(
    files.map((f) => sharp(f).resize(w, h).png().toBuffer())
  );
  await sharp({
    create: {
      width: w * files.length + gap * (files.length + 1),
      height: h + gap * 2,
      channels: 3,
      background: { r: 34, g: 34, b: 34 },
    },
  })
    .composite(
      resized.map((buf, i) => ({
        input: buf,
        left: gap + i * (w + gap),
        top: gap,
      }))
    )
    .png()
    .toFile(outPath);
}

// ---- self-test ------------------------------------------------------------

async function makeSolid(
  r: number,
  g: number,
  b: number,
  w = 1280,
  h = 720
): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

/** 左半分黒・右半分白の1280x720(輝度0/1が半々 → 標準偏差0.5) */
async function makeHalfBlackWhite(): Promise<Buffer> {
  const white = await sharp({
    create: {
      width: 640,
      height: 720,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: white, left: 640, top: 0 }])
    .png()
    .toBuffer();
}

async function selfTest(): Promise<void> {
  const failures: string[] = [];
  const near = (got: number, want: number, tol: number, label: string) => {
    if (Math.abs(got - want) > tol) {
      failures.push(`${label}: got ${got.toFixed(4)}, want ${want}±${tol}`);
    }
  };

  // 1. 単色グレー: コントラスト0・無彩・輝度0.5
  const gray = await measurePng(await makeSolid(128, 128, 128));
  near(gray.rmsContrast, 0, 0.01, "gray.rmsContrast");
  near(gray.colorfulness, 0, 1, "gray.colorfulness");
  near(gray.meanLuminance, 0.5, 0.02, "gray.meanLuminance");
  if (gray.width !== 1280 || gray.height !== 720) {
    failures.push(`gray size: ${gray.width}x${gray.height}`);
  }

  // 2. 黒白半々: 高コントラスト(std=0.5)・輝度0.5
  const bw = await measurePng(await makeHalfBlackWhite());
  near(bw.rmsContrast, 0.5, 0.02, "bw.rmsContrast");
  near(bw.meanLuminance, 0.5, 0.02, "bw.meanLuminance");

  // 3. 純赤: 高カラフルネス(平均項のみで 0.3*hypot(255,127.5)≈85.6)・暗め
  const red = await measurePng(await makeSolid(255, 0, 0));
  near(red.colorfulness, 85.6, 3, "red.colorfulness");
  near(red.meanLuminance, 0.2126, 0.02, "red.meanLuminance");

  // 4. resolutionErrors: 1280x720はOK、854x480はNG
  const resOk = resolutionErrors([{ file: "a.png", width: 1280, height: 720 }]);
  if (resOk.length !== 0) failures.push(`resolutionErrors ok-case: ${resOk}`);
  const resNg = resolutionErrors([{ file: "b.png", width: 854, height: 480 }]);
  if (resNg.length !== 1) failures.push("resolutionErrors ng-case: 検出されず");

  // 5. relativeNotes: 著しい低コントラスト案のフラグ(最小 < 最大の0.7倍)
  const mk = (rms: number, cf = 40, lum = 0.5): MeasuredPng => ({
    width: 1280,
    height: 720,
    rmsContrast: rms,
    colorfulness: cf,
    meanLuminance: lum,
  });
  const n1 = relativeNotes([mk(0.5), mk(0.45), mk(0.1)]);
  if (!n1[2].includes("lowestContrast")) {
    failures.push("relativeNotes: lowestContrast が付かない");
  }
  if (n1[0].length !== 0 || n1[1].length !== 0) {
    failures.push("relativeNotes: 上位案に不要なフラグ");
  }
  //    僅差(0.7倍以上)ならフラグなし
  const n2 = relativeNotes([mk(0.5), mk(0.45), mk(0.4)]);
  if (n2.some((n) => n.includes("lowestContrast"))) {
    failures.push("relativeNotes: 僅差なのに lowestContrast");
  }
  //    象限不一致: 快彩(>=59)×暗い(<0.4) / 無彩寄り(<33)×明るい(>=0.55)
  const n3 = relativeNotes([mk(0.5, 80, 0.3), mk(0.5, 20, 0.8), mk(0.5, 45, 0.5)]);
  if (!n3[0].includes("quadrantMismatch")) failures.push("quadrant: 快彩×暗が未検出");
  if (!n3[1].includes("quadrantMismatch")) failures.push("quadrant: 無彩×明が未検出");
  if (n3[2].length !== 0) failures.push("quadrant: 中間に誤検出");

  // 6. composeMobilePreview: 3枚から1枚のプレビューPNGが合成される
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thumb-metrics-"));
  const files: string[] = [];
  for (let i = 0; i < 3; i++) {
    const f = path.join(dir, `t${i}.png`);
    await sharp(await makeSolid(80 * i, 40, 40)).toFile(f);
    files.push(f);
  }
  const out = path.join(dir, "preview.png");
  await composeMobilePreview(files, out);
  const meta = await sharp(out).metadata();
  //    寸法厳密一致: 3枚(168x94)+gap8px → 168*3+8*4 x 94+8*2
  const wantW = 168 * 3 + 8 * 4;
  const wantH = 94 + 8 * 2;
  if (meta.width !== wantW || meta.height !== wantH) {
    failures.push(
      `preview size: got ${meta.width}x${meta.height}, want ${wantW}x${wantH}`
    );
  }
  //    背景色: 左上角付近(gap帯内)は r34,g34,b34
  const bgPx = await sharp(out)
    .extract({ left: 2, top: 2, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (bgPx[0] !== 34 || bgPx[1] !== 34 || bgPx[2] !== 34) {
    failures.push(
      `preview bg: got rgb(${bgPx[0]},${bgPx[1]},${bgPx[2]}), want rgb(34,34,34)`
    );
  }
  //    サムネ領域: 1枚目のサムネ内部(gap+10)は背景色ではない
  const thumbPx = await sharp(out)
    .extract({ left: 18, top: 18, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (thumbPx[0] === 34 && thumbPx[1] === 34 && thumbPx[2] === 34) {
    failures.push("preview thumb: サムネ領域が背景色のまま(合成されていない)");
  }
  await fs.rm(dir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error("thumb-metrics self-test: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("thumb-metrics self-test: OK (6項目)");
}

const isMain = process.argv[1]?.endsWith("thumb-metrics.ts");
if (isMain && process.argv.includes("--self-test")) {
  selfTest().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
