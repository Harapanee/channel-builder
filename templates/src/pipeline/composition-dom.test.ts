import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCompositionDom } from "./composition-dom";

/** JSでimgを組み立てるcomposition(実物と同じ作り)を一時プロジェクトに用意する */
function makeProject(): { root: string; comp: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hf-dom-"));
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
    </style></head><body>
    <div id="root" data-composition-id="t" data-start="0" data-duration="12" data-width="1920" data-height="1080">
      <div class="clip scene" id="c1" data-start="0" data-duration="6" data-track-index="1"></div>
      <div class="clip scene" id="c2" data-start="6" data-duration="6" data-track-index="1"></div>
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
  assert.equal(dom.clips.length, 3);

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
