import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEnScript,
  fitDecision,
  lineSlots,
  type EnScript,
} from "./en-plan";

const TIMING = {
  totalDurationSec: 20,
  lines: [
    { lineId: "L01", text: "おめでとうございます。", startSec: 0, endSec: 3.7 },
    { lineId: "L02", text: "うず巻きの殻。", startSec: 4.1, endSec: 7.2 },
    { lineId: "L03", text: "長いです。", startSec: 7.5, endSec: 19 },
  ],
};

test("行の枠は次の行の開始まで、最終行は総尺から末尾の余白を引く", () => {
  const s = lineSlots(TIMING);
  assert.deepEqual(
    s.map((x) => x.lineId),
    ["L01", "L02", "L03"],
  );
  assert.equal(s[0].slotSec, 4.1);
  assert.equal(s[1].slotSec, 3.4);
  assert.equal(s[2].slotSec, 12.2); // 20 - 7.5 - 0.3
  assert.equal(s[0].jaDurSec, 3.7);
});

test("語数の幅: 上限は枠いっぱい、下限は日本語の発話尺から許容の不足を引いた長さ", () => {
  const s = lineSlots(TIMING)[0];
  assert.equal(s.maxWords, 12); // floor((4.1 - 0.15) * 3.2)
  assert.equal(s.minWords, 9); // floor((3.7 - 0.7) * 3.2)
});

const EN: EnScript = {
  episodeId: "ep-x",
  lines: {
    L01: "Congratulations.",
    L02: "A spiral shell.",
    L03: "It is long.",
  },
  title: "I Was Reborn as a Nautilus",
  description:
    "Text.\n\nJapanese narration: VOICEVOX:承認済み話者\nEnglish narration: Kokoro TTS (synthetic voice)",
  thumbText: "90 ARMS",
};

test("揃った英訳は合格(クレジット行の日本語は除外)", () => {
  assert.deepEqual(checkEnScript(EN, TIMING), []);
});

test("行の抜け・余分・空・日本語の混入・山括弧・長すぎるタイトルを拾う", () => {
  const bad: EnScript = {
    ...EN,
    lines: { L01: "おめでとう", L02: "  ", L99: "extra" },
    title: "<b>" + "x".repeat(100),
  };
  const p = checkEnScript(bad, TIMING).join("\n");
  assert.match(p, /L03.*ありません/);
  assert.match(p, /L99.*timing にない/);
  assert.match(p, /L02.*空/);
  assert.match(p, /L01.*日本語/);
  assert.match(p, /title.*<>/);
  assert.match(p, /title.*100/);
});

test("行だけの検査(linesOnly)はタイトル・説明・サムネ文字の空を問わない", () => {
  const linesOnly = { episodeId: "ep-x", lines: EN.lines } as EnScript;
  assert.deepEqual(checkEnScript(linesOnly, TIMING, { linesOnly: true }), []);
  assert.match(checkEnScript(linesOnly, TIMING).join("\n"), /title.*空/);
  assert.match(
    checkEnScript({ ...linesOnly, lines: { L01: "x" } }, TIMING, {
      linesOnly: true,
    }).join("\n"),
    /L02.*ありません/,
  );
});

const SP = { maxSpeed: 1.15, minSpeed: 0.92 };

test("収まり判定: 日本語とほぼ同じ長さなら ok", () => {
  assert.deepEqual(fitDecision({ slotSec: 4.1, jaDurSec: 3.7 }, 3.4, 1.0, SP), {
    kind: "ok",
  });
});

test("収まり判定: 短い章カードも日本語の発話尺と比べるので ok", () => {
  assert.deepEqual(fitDecision({ slotSec: 2.3, jaDurSec: 2.0 }, 1.9, 1.0, SP), {
    kind: "ok",
  });
});

test("収まり判定: はみ出しは話速の上限内なら必要な話速を返す(少し余裕を持たせる)", () => {
  const f = fitDecision({ slotSec: 4.1, jaDurSec: 3.7 }, 4.3, 1.0, SP); // 4.3 / 3.95 = 1.089 → ×1.02 = 1.1104 → 切り上げ 1.12
  assert.deepEqual(f, { kind: "speed", speed: 1.12 });
});

test("収まり判定: 既に話速を上げた音の尺から、元の話速に換算して判定する", () => {
  // speed 1.1 で 4.0 秒 → 等速なら 4.4 秒相当。4.4 / 3.95 = 1.114 → ×1.02 → 1.14
  assert.deepEqual(fitDecision({ slotSec: 4.1, jaDurSec: 3.7 }, 4.0, 1.1, SP), {
    kind: "speed",
    speed: 1.14,
  });
});

test("収まり判定: 上限を超えるはみ出しは縮める訳し直し", () => {
  const f = fitDecision({ slotSec: 5.3, jaDurSec: 5.0 }, 6.4, 1.0, SP);
  assert.equal(f.kind, "shrink");
  assert.ok(f.kind === "shrink" && Math.abs(f.overSec - 1.25) < 1e-9); // 6.4 - (5.3 - 0.15)
});

test("収まり判定: 少しだけ短いなら話速を下げて日本語の尺に寄せる", () => {
  // 不足 0.75秒 > 許容 0.7。9.25 / 10 = 0.925 → 切り上げ 0.93(下限 0.92 以上)
  assert.deepEqual(
    fitDecision({ slotSec: 10.5, jaDurSec: 10 }, 9.25, 1.0, SP),
    { kind: "speed", speed: 0.93 },
  );
});

test("収まり判定: 話速を下げた後の尺は等速に換算せず実尺で不足を見る", () => {
  assert.deepEqual(
    fitDecision({ slotSec: 10.5, jaDurSec: 10 }, 9.9, 0.93, SP),
    { kind: "ok" },
  );
});

test("収まり判定: 下げても届かないほど短いなら足す訳し直し", () => {
  const f = fitDecision({ slotSec: 4.1, jaDurSec: 3.7 }, 2.5, 1.0, SP);
  assert.equal(f.kind, "expand");
  assert.ok(f.kind === "expand" && Math.abs(f.shortSec - 1.2) < 1e-9);
});

test("fit exit status: expand alone warns without blocking; overlap remains blocking", async () => {
  const { fitExitCode } = await import("./en-plan");
  assert.equal(fitExitCode([]), 0);
  assert.equal(fitExitCode([{ kind: "expand" }]), 0);
  assert.equal(fitExitCode([{ kind: "expand" }, { kind: "shrink" }]), 1);
  assert.equal(fitExitCode([{ kind: "speed" }]), 1);
  assert.throws(() =>
    fitDecision({ slotSec: 2, jaDurSec: 1 }, NaN, 1, {
      minSpeed: 0.8,
      maxSpeed: 1.2,
    }),
  );
});
