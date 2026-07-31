import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureFrames, parseTimesArg, readCompositionMeta } from "./probe-frames";

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
        };
      </script>
    </body></html>`
  );
  return { root, comp };
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

test("時刻の指定を解釈する(数値・昇順・重複除去)", () => {
  assert.deepEqual(parseTimesArg("9,1,1,4.5", 10), [1, 4.5, 9]);
});

test("尺を超える時刻・数値でない時刻は拒否する", () => {
  assert.throws(() => parseTimesArg("1,12", 10), /12/);
  assert.throws(() => parseTimesArg("1,abc", 10), /abc/);
  assert.throws(() => parseTimesArg("", 10), /時刻/);
});
