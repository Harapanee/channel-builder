/**
 * サムネイル3案の一括レンダリング(Node API方式)。
 *
 * `remotion still` CLIをvariantごとに起動すると、バンドル・ヘッドレスブラウザを
 * 毎回立ち上げ直すため、メモリ逼迫時に「Could not find composition」の
 * 一過性失敗が起きやすい。本ツールは @remotion/bundler + @remotion/renderer の
 * Node APIで**1回だけバンドルし、同一セッションで3枚**を描く(+失敗時は再試行)。
 *
 * CLI: tsx src/pipeline/render-thumbs.ts episodes/<epId>
 */
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Ajv from "ajv";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import {
  composeMobilePreview,
  measurePng,
  relativeNotes,
  resolutionErrors,
} from "./thumb-metrics";

async function main() {
  const epDir = process.argv[2];
  if (!epDir) {
    console.error("usage: render-thumbs.ts episodes/<epId>");
    process.exit(1);
  }
  const specPath = path.join(epDir, "publish", "thumbnails.json");
  if (!existsSync(specPath)) {
    console.error(`${specPath} がありません(先にpublisherエージェントで生成)`);
    process.exit(1);
  }

  console.log("bundling...");
  const serveUrl = await bundle({
    // サムネ専用の軽量Root(Episodeを含まない)。ThumbRoot.tsxのコメント参照
    entryPoint: path.resolve("src/remotion/ThumbRoot.tsx"),
    publicDir: path.resolve("public"),
  });

  let failed = false;
  for (const variant of [1, 2, 3]) {
    const output = path.join(epDir, "publish", `thumb-${variant}.png`);
    const inputProps = { episodeDir: epDir, variant };
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const composition = await selectComposition({
          serveUrl,
          id: "Thumbnail",
          inputProps,
        });
        await renderStill({
          composition,
          serveUrl,
          output,
          inputProps,
          frame: 0,
        });
        ok = true;
        console.log(`thumb-${variant}: OK`);
      } catch (e) {
        console.log(
          `thumb-${variant}: attempt ${attempt} failed (${String(e).slice(0, 120)})`
        );
      }
    }
    if (!ok) failed = true;
  }

  // ---- 計測・検査・モバイルプレビュー(docs/thumbnail-principles.md)----
  // 計測の失敗はレンダー成功を巻き込まない(warnして続行)。
  // ただし解像度違反(Test & Compareの480p強制劣化)だけはハード検査。
  if (!failed) {
    let resErrors: string[] = [];
    try {
      const files = [1, 2, 3].map((v) =>
        path.join(epDir, "publish", `thumb-${v}.png`)
      );
      const measured = await Promise.all(files.map((f) => measurePng(f)));
      const notes = relativeNotes(measured);
      resErrors = resolutionErrors(
        measured.map((m, i) => ({ file: `thumb-${i + 1}.png`, ...m }))
      );

      const round = (x: number, digits: number) =>
        Number(x.toFixed(digits));
      const metrics = {
        episodeId: path.basename(epDir),
        generatedAt: new Date().toISOString().slice(0, 10),
        variants: measured.map((m, i) => ({
          id: String(i + 1),
          file: `thumb-${i + 1}.png`,
          width: m.width,
          height: m.height,
          rmsContrast: round(m.rmsContrast, 3),
          colorfulness: round(m.colorfulness, 1),
          meanLuminance: round(m.meanLuminance, 3),
          notes: notes[i],
        })),
      };

      // 書き出し前の自己検証(validate-metadata と同じAjv流儀)
      const schema = JSON.parse(
        readFileSync(
          path.resolve("src/schemas/thumb-metrics.schema.json"),
          "utf-8"
        )
      ) as object;
      const ajv = new Ajv({ allErrors: true });
      const ok = ajv.validate(schema, metrics);
      if (!ok) {
        throw new Error(`thumb-metrics自己検証NG: ${ajv.errorsText()}`);
      }
      writeFileSync(
        path.join(epDir, "publish", "thumb-metrics.json"),
        JSON.stringify(metrics, null, 2) + "\n"
      );

      await composeMobilePreview(
        files,
        path.join(epDir, "publish", "thumb-mobile-preview.png")
      );

      console.log("--- thumb-metrics ---");
      for (const v of metrics.variants) {
        const flag = v.notes.length > 0 ? `  ⚠ ${v.notes.join(", ")}` : "";
        console.log(
          `thumb-${v.id}: contrast=${v.rmsContrast} colorfulness=${v.colorfulness} luminance=${v.meanLuminance}${flag}`
        );
      }
      console.log(
        "モバイルプレビュー: publish/thumb-mobile-preview.png(小面積での可読性を目視確認)"
      );
    } catch (e) {
      console.warn(`計測をスキップ(レンダー自体は成功): ${String(e)}`);
    }
    if (resErrors.length > 0) {
      for (const err of resErrors) console.error(`NG: ${err}`);
      process.exit(1);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
