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
import { existsSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

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
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
