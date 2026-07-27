import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCompositionDom, injectBase } from "./composition-dom";

/** JSでimgを組み立てるcomposition(実物と同じ作り)を一時プロジェクトに用意する */
function makeProject(): { root: string; comp: string } {
  // 空白を含むディレクトリ名にする(base href のエスケープが効いていることの実証)
  const root = mkdtempSync(path.join(tmpdir(), "hf dom "));
  mkdirSync(path.join(root, "assets", "places"), { recursive: true });
  // 1x1 の透明PNG(naturalWidth/Height を確定させるため実ファイルを置く)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  writeFileSync(path.join(root, "assets", "places", "reef.png"), png);
  const comp = path.join(root, "composition.html");
  writeFileSync(
    comp,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      #root{position:relative;width:1920px;height:1080px}
      .clip{position:absolute;inset:0}
      .bg{width:100%;height:100%;object-fit:cover}
      .css-bg{position:absolute;inset:0;background-image:url(assets/places/reef.png)}
      .outside-bg{position:absolute;inset:0;background-image:url(file:///hf-test-outside-root/x.png)}
    </style></head><body>
    <div id="root" data-composition-id="t" data-start="0" data-duration="12" data-width="1920" data-height="1080">
      <div class="clip scene" id="c1" data-start="0" data-duration="6" data-track-index="1"></div>
      <div class="clip scene" id="c2" data-start="6" data-duration="6" data-track-index="1"></div>
      <div class="clip scene" id="c3" data-start="6" data-duration="6" data-track-index="1">
        <div class="css-bg"></div>
      </div>
      <div class="clip scene" id="c4" data-start="6" data-duration="6" data-track-index="1">
        <svg viewBox="0 0 100 100"><image href="assets/places/reef.png" width="100" height="100"/></svg>
      </div>
      <div class="clip scene" id="c5" data-start="6" data-duration="6" data-track-index="1">
        <img src="./assets/places/reef.png" class="bg">
      </div>
      <div class="clip scene" id="c6" data-start="6" data-duration="6" data-track-index="1">
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
        <div class="outside-bg"></div>
      </div>
      <div class="subtitle clip" id="s1" data-start="0" data-duration="6" data-track-index="40">字幕</div>
    </div>
    <script>
      // 実物と同じく img は JS で挿入する
      const i = document.createElement("img");
      i.src = "assets/places/reef.png";
      i.className = "bg";
      document.getElementById("c1").appendChild(i);
    </script>
    </body></html>`
  );
  return { root, comp };
}

test("JSで挿入されたimgを評価済みDOMから収集できる", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);

  assert.equal(dom.durationSec, 12);
  assert.equal(dom.clips.length, 7);

  const c1 = dom.clips.find((c) => c.id === "c1");
  assert.ok(c1);
  assert.deepEqual(c1.classes.sort(), ["clip", "scene"]);
  assert.equal(c1.trackIndex, 1);
  assert.equal(c1.startSec, 0);
  assert.equal(c1.durationSec, 6);
  assert.equal(c1.images.length, 1);
  assert.equal(c1.images[0].src, "assets/places/reef.png");
  assert.equal(c1.images[0].naturalW, 1);
  assert.equal(c1.images[0].objectFit, "cover");

  const c2 = dom.clips.find((c) => c.id === "c2");
  assert.equal(c2?.images.length, 0);
});

test("同じ構造のclipは同じsignature・違う構造は違うsignature", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const c1 = dom.clips.find((c) => c.id === "c1")!;
  const c2 = dom.clips.find((c) => c.id === "c2")!;
  const s1 = dom.clips.find((c) => c.id === "s1")!;
  assert.notEqual(c1.signature, c2.signature); // c1はimgを持つ
  assert.notEqual(c1.signature, s1.signature);
  assert.match(c1.signature, /^[0-9a-f]{12}$/);
});

test("injectBase: <head> があればその直後に入れる", () => {
  const out = injectBase(`<!DOCTYPE html><html><head><title>x</title></head><body></body></html>`, "file:///a/");
  assert.match(out, /<head><base href="file:\/\/\/a\/"><title>/);
});

test("injectBase: <head> が無ければ <html> の直後に head ごと入れる", () => {
  const out = injectBase(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, "file:///a/");
  assert.match(out, /<html><head><base href="file:\/\/\/a\/"><\/head><body>/);
});

test("injectBase: <html> も無ければ文書先頭に入れる", () => {
  const out = injectBase(`<div id="root"></div>`, "file:///a/");
  assert.equal(out, `<head><base href="file:///a/"></head><div id="root"></div>`);
});

test("CSS background-image / SVG image / ./相対パス をすべて素材として収集する", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const srcsOf = (id: string) => dom.clips.find((c) => c.id === id)!.images.map((i) => i.src);

  assert.deepEqual(srcsOf("c3"), ["assets/places/reef.png"], "background-image が拾えていない");
  assert.deepEqual(srcsOf("c4"), ["assets/places/reef.png"], "SVG <image> が拾えていない");
  assert.deepEqual(srcsOf("c5"), ["assets/places/reef.png"], "./ 付き相対パスが正規化されていない");
});

test("img 以外の出所は naturalW=0 / objectFit空 になり規則9の対象外になる", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const bg = dom.clips.find((c) => c.id === "c3")!.images[0];
  assert.equal(bg.naturalW, 0);
  assert.equal(bg.objectFit, "");

  const img = dom.clips.find((c) => c.id === "c5")!.images[0];
  assert.equal(img.naturalW, 1);
  assert.equal(img.objectFit, "cover");
});

test("data: URI とプロジェクト外の絶対URLは素材として数えない", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);

  // c6 は data: URI の img と、ルート外を指す background-image を持つ
  const c6 = dom.clips.find((c) => c.id === "c6")!;
  assert.deepEqual(c6.images, [], `除外されるべき src が残っている: ${JSON.stringify(c6.images)}`);

  const all = dom.clips.flatMap((c) => c.images.map((i) => i.src));
  assert.ok(all.every((s) => s.startsWith("assets/")), `ルート相対でない src がある: ${all.join(", ")}`);
});
