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
      .mask-only{position:absolute;inset:0;background-color:#000;-webkit-mask-image:url(assets/places/reef.png);mask-image:url(assets/places/reef.png)}
      .border-only{position:absolute;inset:0;border-style:solid;border-width:10px;border-image-source:url(assets/places/reef.png);border-image-slice:1}
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
      <div class="clip scene" id="c7" data-start="6" data-duration="6" data-track-index="1">
        <div class="mask-only"></div>
      </div>
      <div class="clip scene" id="c8" data-start="6" data-duration="6" data-track-index="1">
        <div class="border-only"></div>
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
  assert.equal(dom.clips.length, 9);

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
  assert.match(c1.signature, /^[0-9a-f]{12}:$/);
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

// 回帰テスト(Important-1): Chrome は getComputedStyle().maskImage と
// .webkitMaskImage に同一の値を返すため、両方を収集すると同じ素材が2回計上される。
// 規則2(maxUsesPerImage)の実使用回数が実際の2倍に水増しされ、上限3回設定で
// 実使用2回でもBLOCKする不正確なゲートを生んでいた欠陥の再発防止。
test("mask-image を1つ持つclipから素材がちょうど1件収集される(重複計上の回帰)", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const c7 = dom.clips.find((c) => c.id === "c7")!;
  assert.equal(
    c7.images.length,
    1,
    `mask-image由来の素材が重複計上されている(maskImage/webkitMaskImageの二重収集): ${JSON.stringify(c7.images)}`
  );
  assert.equal(c7.images[0].src, "assets/places/reef.png");
});

test("border-image-source を1つ持つclipから素材がちょうど1件収集される", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const c8 = dom.clips.find((c) => c.id === "c8")!;
  assert.equal(c8.images.length, 1);
  assert.equal(c8.images[0].src, "assets/places/reef.png");
});

test("clip配下のクラスを descendantClasses に集める", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const c3 = dom.clips.find((c) => c.id === "c3")!;
  assert.deepEqual(c3.classes.sort(), ["clip", "scene"]);
  assert.deepEqual(c3.descendantClasses, ["css-bg"]);

  const c2 = dom.clips.find((c) => c.id === "c2")!;
  assert.deepEqual(c2.descendantClasses, []);
});

/** 同一DOM・異なるモーションの2clipを持つプロジェクト(GSAPはCDN依存なのでフェイクを置く) */
function makeMotionProject(): { root: string; comp: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hf motion "));
  const comp = path.join(root, "composition.html");
  writeFileSync(
    comp,
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
    <div id="root" data-composition-id="t" data-start="0" data-duration="12" data-width="1920" data-height="1080">
      <div class="clip scene" id="c1" data-start="0" data-duration="4" data-track-index="1"><div class="char">A</div></div>
      <div class="clip scene" id="c2" data-start="4" data-duration="4" data-track-index="1"><div class="char">B</div></div>
      <div class="clip scene" id="c3" data-start="8" data-duration="4" data-track-index="1"><div class="char">C</div></div>
    </div>
    <script>
      function tween(vars, dur, sel) {
        return { vars: vars, duration: function () { return dur; },
                 targets: function () { return [document.querySelector(sel)]; } };
      }
      window.__timelines = { t: { getChildren: function () { return [
        tween({ opacity: 1, ease: "power2.out", duration: 1 }, 1, "#c1 .char"),
        tween({ x: 100, ease: "sine.inOut", duration: 2 }, 2, "#c2 .char"),
        tween({ opacity: 1, ease: "power2.out", duration: 1 }, 1, "#c3 .char")
      ]; } } };
    </script>
    </body></html>`
  );
  return { root, comp };
}

test("同一DOM構造でもモーションが違えば別シグネチャになる", async () => {
  const { root, comp } = makeMotionProject();
  const dom = await collectCompositionDom(comp, root);
  const c1 = dom.clips.find((c) => c.id === "c1")!;
  const c2 = dom.clips.find((c) => c.id === "c2")!;
  const c3 = dom.clips.find((c) => c.id === "c3")!;

  assert.notEqual(c1.signature, c2.signature, "動きが違うのに同一シグネチャ");
  assert.equal(c1.signature, c3.signature, "動きも構造も同じなら同一シグネチャであるべき");
  assert.match(c1.signature, /^[0-9a-f]{12}:[0-9a-f]{12}$/);
});

test("__timelines が無いcompositionではモーション部が空になる(後方互換)", async () => {
  const { root, comp } = makeProject();
  const dom = await collectCompositionDom(comp, root);
  const c1 = dom.clips.find((c) => c.id === "c1")!;
  assert.match(c1.signature, /^[0-9a-f]{12}:$/);
});
