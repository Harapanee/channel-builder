import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  analyzeFrames,
  buildContactSheet,
  captureFrames,
  injectRuntime,
  parseTimesArg,
  readCompositionMeta,
  resolveRuntimePath,
} from "./probe-frames";

/**
 * window.__timelines に paused timeline を登録する最小の composition を用意する。
 * 時刻で背景色が変わるので、撮れたPNGの差異で「シークが絵に反映されたか」を検証できる。
 */
function makeComposition(): { root: string; comp: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hf probe "));
  const comp = path.join(root, "composition.html");
  writeFileSync(
    comp,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0}
      #root{position:relative;width:1920px;height:1080px}
      #fill{position:absolute;inset:0;background:#000}
    </style></head><body>
      <div id="root" data-composition-id="probe-t" data-start="0" data-duration="10">
        <div id="fill"></div>
      </div>
      <script>
        window.__timelines = {};
        window.__timelines["probe-t"] = {
          pause: function () {},
          time: function (sec) {
            document.getElementById("fill").style.background = sec < 5 ? "#000000" : "#ffffff";
          },
          totalTime: function (sec) {
            if (sec != null) this.time(sec);
            return 0;
          },
          duration: function () { return 10; },
          totalDuration: function () { return 10; },
        };
      </script>
    </body></html>`
  );
  return { root, comp };
}

/**
 * 「時間窓の外のclipが画面に出ていないか」を検証するための composition。
 * clipは2枚とも全画面。DOM順で後ろにある青が、時間窓を無視すると常に赤を覆う。
 * HFのランタイム(__player)を注入していれば t=1 は赤・t=7 は青になる。
 */
function makeTwoClipComposition(): { root: string; comp: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hf-probe-clips-"));
  const comp = path.join(root, "composition.html");
  writeFileSync(
    comp,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0}
      #root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#888}
      .clip{position:absolute;inset:0}
    </style></head><body>
      <div id="root" data-composition-id="probe-clips" data-start="0" data-width="1920" data-height="1080" data-duration="10">
        <section class="clip" id="cA" data-start="0" data-duration="5" data-track-index="1"
                 style="background:#ff0000"></section>
        <section class="clip" id="cB" data-start="5" data-duration="5" data-track-index="1"
                 style="background:#0000ff"></section>
      </div>
      <script>
        window.__timelines = {};
        window.__timelines["probe-clips"] = {
          pause: function () {}, play: function () {},
          time: function () { return 0; },
          totalTime: function () { return 0; },
          duration: function () { return 10; },
          totalDuration: function () { return 10; },
          progress: function () { return 0; },
          kill: function () {},
        };
      </script>
    </body></html>`
  );
  return { root, comp };
}

/**
 * clip の中で `<img>` を組み立てる composition(実物の scaffold 生成物と同じ形)。
 *
 * 実測(sekaishi-longform ep001-plague-doctor・285clip): 撮影が画像の読み込み完了を
 * 待っていなかったため、t=300 では素材の位置が下地の色のまま写り、**同じclipの
 * t=301 では正しく写る**という絵が出ていた。実装エージェントはこの絵で
 * 「素材が抜けている」と誤判定する。
 * 大きめのPNGを複数枚読ませて、待ちが無ければ再現する条件を作る。
 */
function makeImageComposition(imageFiles: string[]): { root: string; comp: string } {
  const root = path.dirname(imageFiles[0]);
  const comp = path.join(root, "composition.html");
  const names = JSON.stringify(imageFiles.map((f) => path.basename(f)));
  writeFileSync(
    comp,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0}
      #root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#888888}
      .clip{position:absolute;inset:0}
      .clip img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    </style></head><body>
      <div id="root" data-composition-id="probe-img" data-start="0" data-width="1920" data-height="1080" data-duration="10">
        <section class="clip" id="cImg" data-start="0" data-duration="10" data-track-index="1"></section>
      </div>
      <script>
        /* 実物と同じく、clipのDOMはロード時にJSで組み立てられる */
        (function () {
          var host = document.getElementById("cImg");
          ${names}.forEach(function (n) {
            var im = document.createElement("img");
            im.src = n;
            host.appendChild(im);
          });
        })();
        window.__timelines = {};
        window.__timelines["probe-img"] = {
          pause: function () {}, play: function () {},
          time: function () { return 0; },
          totalTime: function () { return 0; },
          duration: function () { return 10; },
          totalDuration: function () { return 10; },
          progress: function () { return 0; },
          kill: function () {},
        };
      </script>
    </body></html>`
  );
  return { root, comp };
}

/** 中央1ピクセルのRGBを読む */
async function centerPixel(file: string): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const x = Math.floor(info.width / 2);
  const y = Math.floor(info.height / 2);
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

test("composition.html から composition-id と総尺を読む", () => {
  const html = `<!DOCTYPE html><html><body>
    <div id="root" data-composition-id="animal-ep012" data-start="0" data-duration="707.689"></div>
  </body></html>`;

  assert.deepEqual(readCompositionMeta(html), {
    compositionId: "animal-ep012",
    durationSec: 707.689,
  });
});

test("総尺は composition-id と同じ要素から読む(先に現れる別要素の data-duration に釣られない)", () => {
  // 実物の composition.html は #root より前に data-duration を持つ要素を置ける。
  // 「文書内で最初の data-duration」を拾う実装だとここで誤った尺を返す。
  const html = `<!DOCTYPE html><html><body>
    <audio id="pre" data-start="0" data-duration="1.5"></audio>
    <div id="root" data-composition-id="animal-ep012" data-start="0" data-duration="707.689"></div>
  </body></html>`;

  assert.equal(readCompositionMeta(html).durationSec, 707.689);
});

test("HFランタイムの<script>を<head>へ1つだけ注入する", () => {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body></body></html>`;
  const out = injectRuntime(html, "file:///rt/hyperframe-runtime.js");

  assert.match(out, /<head><script data-hyperframes-preview-runtime="1" src="file:\/\/\/rt\/hyperframe-runtime\.js"><\/script>/);
  assert.equal(out.match(/hyperframes-preview-runtime/g)?.length, 1);
});

test("すでにランタイムを持つcompositionへは注入しない", () => {
  const html = `<!DOCTYPE html><html><head><script src="x/hyperframe.runtime.iife.js"></script></head><body></body></html>`;
  assert.equal(injectRuntime(html, "file:///rt/hyperframe-runtime.js"), html);
});

test("ランタイムの実体が見つからなければ、対処を示して失敗する", () => {
  assert.throws(
    () => resolveRuntimePath("/nonexistent-project", () => []),
    /hyperframe-runtime\.js/
  );
});

test("指定した各時刻のフレームを撮り、シーク結果が絵に反映される", async () => {
  const { root, comp } = makeComposition();
  const outDir = path.join(root, "shots");

  const result = await captureFrames({
    compositionPath: comp,
    projectRoot: root,
    times: [1, 9],
    outDir,
  });

  assert.equal(result.compositionId, "probe-t");
  assert.equal(result.files.length, 2);

  const early = readFileSync(result.files[0]);
  const late = readFileSync(result.files[1]);
  // t=1 は黒、t=9 は白。同じ絵が返るなら time() が効いていない
  assert.ok(!early.equals(late), "時刻を変えても同じフレームが撮れている(シークが効いていない)");
});

test("時間窓の外のclipは画面に出ない(レンダーと同じ絵になる)", async () => {
  // ep012 の実測で判明した事故の回帰テスト。ランタイムを注入せず生のGSAPだけを
  // シークしていた頃は、DOM順で後ろの青clipが常に赤を覆い、実レンダーとの平均差が
  // 117(255階調)に達していた。ランタイム注入後は 2.25。
  const { root, comp } = makeTwoClipComposition();
  const outDir = path.join(root, "shots");

  const result = await captureFrames({
    compositionPath: comp,
    projectRoot: root,
    times: [1, 7],
    outDir,
  });

  const atOne = await centerPixel(result.files[0]);
  const atSeven = await centerPixel(result.files[1]);

  assert.ok(atOne.r > 200 && atOne.b < 60, `t=1 は赤clipのはずが ${JSON.stringify(atOne)}`);
  assert.ok(atSeven.b > 200 && atSeven.r < 60, `t=7 は青clipのはずが ${JSON.stringify(atSeven)}`);
});

test("clip内の画像が読み込まれてから撮る(素材の抜けた別物の絵を出さない)", async () => {
  // ep001-plague-doctor t=300 の回帰テスト。画像の読み込みを待たずに撮ると、
  // 素材の位置が下地(#888)のまま写り、1秒後の t=301 では正しく写る絵が出ていた。
  const dir = mkdtempSync(path.join(tmpdir(), "hf-probe-img-"));
  const files: string[] = [];
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, `mat-${i}.png`);
    // デコードに時間のかかる大きめの画像。ノイズを入れて圧縮が効かないようにする
    const px = Buffer.alloc(2400 * 2400 * 3);
    for (let p = 0; p < px.length; p += 3) {
      px[p] = 220 + (p % 35);
      px[p + 1] = 20 + (p % 17);
      px[p + 2] = 20 + (p % 11);
    }
    await sharp(px, { raw: { width: 2400, height: 2400, channels: 3 } }).png().toFile(f);
    files.push(f);
  }

  const { root, comp } = makeImageComposition(files);
  const result = await captureFrames({
    compositionPath: comp,
    projectRoot: root,
    times: [1],
    outDir: path.join(dir, "shots"),
  });

  const px = await centerPixel(result.files[0]);
  assert.ok(
    px.r > 180 && px.g < 90,
    `画像が写っていない(下地のまま撮れている): ${JSON.stringify(px)}`
  );
});

test("撮ったフレームの輝度stdを機械判定して返す(空フレームを画像Readなしで検出)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hf-probe-analyze-"));
  const flat = path.join(dir, "at-1.png");
  const drawn = path.join(dir, "at-2.png");
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "#f2efe6" } })
    .png()
    .toFile(flat);
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "#f2efe6" } })
    .composite([{ input: { create: { width: 160, height: 90, channels: 3, background: "#101010" } }, top: 10, left: 10 }])
    .png()
    .toFile(drawn);

  const report = await analyzeFrames([flat, drawn]);

  assert.equal(report.length, 2);
  assert.ok(report[0].lumaStd < 1.5, `無地は空と判定されるべき: ${report[0].lumaStd}`);
  assert.equal(report[0].blank, true);
  assert.ok(report[1].lumaStd > 1.5, `絵のあるフレームは空でない: ${report[1].lumaStd}`);
  assert.equal(report[1].blank, false);
});

test("複数フレームを1枚のコンタクトシートに連結する(画像Readを1回に減らす)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hf-probe-sheet-"));
  const files: string[] = [];
  for (const [i, color] of ["#ff0000", "#00ff00", "#0000ff"].entries()) {
    const f = path.join(dir, `at-${i}.png`);
    await sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toFile(f);
    files.push(f);
  }

  const sheet = await buildContactSheet(files, path.join(dir, "contact.jpg"), { columns: 2, cellWidth: 320 });
  const meta = await sharp(sheet).metadata();

  // 3枚を2列に並べる → 2列 x 2行
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 360);
});

test("時刻の指定を解釈する(数値・昇順・重複除去)", () => {
  assert.deepEqual(parseTimesArg("9,1,1,4.5", 10), [1, 4.5, 9]);
});

test("尺を超える時刻・数値でない時刻は拒否する", () => {
  assert.throws(() => parseTimesArg("1,12", 10), /12/);
  assert.throws(() => parseTimesArg("1,abc", 10), /abc/);
  assert.throws(() => parseTimesArg("", 10), /時刻/);
});
