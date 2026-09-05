// src/pipeline/h3/check.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_MOTIONS,
  CUT_VERBS,
  checkAdvisories,
  checkJobSet,
  checkLedger,
  checkPromptText,
  checkSelfContained,
  checkSpeedup,
  stripClosingSentences,
} from "./check";
import { FOLD_ID_LIMIT, foldFindings, renderFolded } from "./check-h3-prompt";
import type { Cut, Finding, ShotDecl, Vocab } from "./types";

const OK =
  "integrated_multimodal_description: [Shot 1] 2D-animated doodle style. A wide shot of a flat blue field. " +
  "The camera pushes in with small amplitude at slow speed toward the fish. " +
  "Nothing else appears in the frame at any point.\n\n" +
  "overall_soundscape: A low underwater hum.\n\n" +
  "non_diegetic_music: N/A";

const CTX = { seconds: 5.167, hasFirstFrame: false };
const rules = (f: ReturnType<typeof checkPromptText>) => f.map((x) => x.rule).sort();
const blocks = (f: ReturnType<typeof checkPromptText>) => f.filter((x) => x.level === "BLOCK");
/** 本文(integrated_multimodal_description の中)へ追記する。閉じの一文の直前に入れる */
const inBody = (extra: string) =>
  OK.replace("Nothing else appears in the frame at any point.", extra + " Nothing else appears in the frame at any point.");

test("正しいプロンプトは BLOCK ゼロ", () => {
  assert.deepEqual(blocks(checkPromptText("cL01", OK, CTX)), []);
});

test("B1: フィールドの欠落・順序違い・重複を弾く", () => {
  const noSound = OK.replace(/overall_soundscape: .*\n\n/, "");
  assert.ok(rules(blocks(checkPromptText("x", noSound, CTX))).includes("B1"));
  const swapped = "overall_soundscape: a\n\nintegrated_multimodal_description: [Shot 1] b\n\nnon_diegetic_music: N/A";
  assert.ok(rules(blocks(checkPromptText("x", swapped, CTX))).includes("B1"));
  assert.ok(rules(blocks(checkPromptText("x", OK + "\n\noverall_soundscape: again", CTX))).includes("B1"));
});

test("B2: first_frame ありなのに指示行が無い / 無いのに付いている", () => {
  assert.ok(rules(blocks(checkPromptText("x", OK, { ...CTX, hasFirstFrame: true }))).includes("B2"));
  const extra =
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n" + OK;
  assert.ok(rules(blocks(checkPromptText("x", extra, CTX))).includes("B2"));
});

test("B2: 指示行が一字でも違えば弾く", () => {
  const typo =
    "For the target video, at 0.0 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n" + OK;
  assert.ok(rules(blocks(checkPromptText("x", typo, { ...CTX, hasFirstFrame: true }))).includes("B2"));
});

test("B3: [Shot 1] に時刻を書いてはいけない", () => {
  assert.ok(rules(blocks(checkPromptText("x", OK.replace("[Shot 1]", "[Shot 1] At 00:00.000,"), CTX))).includes("B3"));
});

test("B3: [Shot 1] の時刻検出は大文字小文字を問わない", () => {
  assert.ok(rules(blocks(checkPromptText("x", OK.replace("[Shot 1]", "[Shot 1] at 00:00.000,"), CTX))).includes("B3"));
});

test("B3: [Shot 2] 以降は時刻が単調増加で尺の中に収まる", () => {
  const back = inBody(
    "[Shot 2] At 00:03.000, the camera cuts to a wide shot of the shore. " +
    "[Shot 3] At 00:02.000, the camera cuts to a wide shot of the sky.",
  );
  assert.ok(rules(blocks(checkPromptText("x", back, CTX))).includes("B3"));
  const over = inBody("[Shot 2] At 00:09.000, the camera cuts to a wide shot of the shore.");
  assert.ok(rules(blocks(checkPromptText("x", over, CTX))).includes("B3"));
});

test("B3: [Shot 2] 以降にカット時刻が無ければ弾く", () => {
  assert.ok(rules(blocks(checkPromptText("x", inBody("[Shot 2] the camera cuts to a wide shot."), CTX))).includes("B3"));
});

test("B4: 公式12種にない言い回しのカメラ表現を弾く", () => {
  const dolly = OK.replace("pushes in with small amplitude at slow speed", "dollies forward");
  assert.ok(rules(blocks(checkPromptText("x", dolly, CTX))).includes("B4"));
  const orbit = OK.replace("pushes in with small amplitude at slow speed", "orbits around the fish");
  assert.ok(rules(blocks(checkPromptText("x", orbit, CTX))).includes("B4"));
});

test("B4: 振幅・速度は固定4句のみ", () => {
  assert.ok(rules(blocks(checkPromptText("x", OK.replace("with small amplitude", "with medium amplitude"), CTX))).includes("B4"));
  assert.ok(rules(blocks(checkPromptText("x", OK.replace("at slow speed", "at moderate speed"), CTX))).includes("B4"));
});

test("B4: POV は公式語彙なので弾かない", () => {
  assert.equal(CAMERA_MOTIONS.length, 13); // 公式12種を検出する語(Push In / Pull Out は同じ行だが語は別)
  assert.ok(CAMERA_MOTIONS.includes("pov"));
  const pov = OK.replace("The camera pushes in with small amplitude at slow speed toward the fish.", "The shot is a POV from the fish.");
  assert.deepEqual(blocks(checkPromptText("x", pov, CTX)), []);
});

test("B4: カメラ文が無くても BLOCK にしない(公式に無い要件のため ADVISE)", () => {
  const none = OK.replace("The camera pushes in with small amplitude at slow speed toward the fish. ", "");
  assert.deepEqual(blocks(checkPromptText("x", none, CTX)), []);
});

test("B4: カメラ以外の文の速度・振幅・動作語で誤BLOCKしない(実材再現)", () => {
  const cases = [
    "The bear charges at top speed toward the shallows.",
    "The salmon pushes upstream at full speed.",
    "A seabird swoops down toward the water.",
    "The gull swoops in over the salmon.",
    "A worker lifts a handheld net out of the tray.",
    "The crane stands craning its neck toward the water.",
    "The school of fish orbits around the rock.",
  ];
  for (const extra of cases) {
    assert.deepEqual(blocks(checkPromptText("x", inBody(extra), CTX)), [], extra);
  }
});

test("B4: camera / POV を含む文での違反は引き続き弾く", () => {
  const camCases = [
    "The camera swoops down over the river.",
    "The camera pushes in with medium amplitude.",
    "The camera trucks left at moderate speed.",
  ];
  for (const extra of camCases) {
    assert.ok(rules(blocks(checkPromptText("x", inBody(extra), CTX))).includes("B4"), extra);
  }
});

test("B4: 振幅・速度は冠詞・修飾語が入っても値を照合する", () => {
  const withArticleBad = OK.replace("with small amplitude", "with a medium amplitude");
  assert.ok(rules(blocks(checkPromptText("x", withArticleBad, CTX))).includes("B4"));
  const speedArticleBad = OK.replace("at slow speed", "at a moderate speed");
  assert.ok(rules(blocks(checkPromptText("x", speedArticleBad, CTX))).includes("B4"));
  const withArticleOk = OK.replace("with small amplitude", "with a small amplitude");
  assert.deepEqual(blocks(checkPromptText("x", withArticleOk, CTX)), []);
});

test("A12: [Shot 2] 以降がカット動詞も転換語も使っていなければ ADVISE(BLOCK にはしない)", () => {
  assert.equal(CUT_VERBS.length, 5);
  const none = inBody("[Shot 2] At 00:03.000, a wide shot of the shore.");
  assert.deepEqual(blocks(checkPromptText("x", none, CTX)), []);
  assert.ok(rules(checkPromptText("x", none, CTX)).includes("A12"));
  const good = inBody("[Shot 2] At 00:03.000, the shot switches to a wide shot of the shore.");
  assert.ok(!rules(checkPromptText("x", good, CTX)).includes("A12"));
});

test("A12: <scenetrans> は転換語ではない(音の跨ぎの印なので境界としては認めない)", () => {
  const st = inBody("[Shot 2] At 00:03.000, <scenetrans> a wide shot of the shore.");
  assert.ok(rules(checkPromptText("x", st, CTX)).includes("A12"));
});

test("A12: 公式が明示的に許可した転換語(cross-dissolve/fade/wipe)は指摘しない", () => {
  for (const v of ["cross-dissolves to", "fades to", "wipes to"]) {
    const p = inBody("[Shot 2] At 00:03.000, the shot " + v + " a wide shot of the shore.");
    assert.ok(!rules(checkPromptText("x", p, CTX)).includes("A12"), v);
  }
});

test("A12: ショット境界が無ければ何も言わない(単一ショットのカット)", () => {
  const colour = inBody("The pillar fades to a paler grey.");
  assert.deepEqual(blocks(checkPromptText("x", colour, CTX)), []);
  assert.ok(!rules(checkPromptText("x", colour, CTX)).includes("A12"));
});

test("B6: 上限超え・学習下限未満の尺を弾く", () => {
  assert.ok(rules(blocks(checkPromptText("x", OK, { ...CTX, seconds: 16 }))).includes("B6"));
  assert.ok(rules(blocks(checkPromptText("x", OK, { ...CTX, seconds: 4 }))).includes("B6"));
});

test("B9: 英文に日本語が混ざっていたら弾く(引用符と <d> の中は除く)", () => {
  assert.ok(rules(blocks(checkPromptText("x", OK.replace("a flat blue field", "a flat 青い field"), CTX))).includes("B9"));
  const quoted = OK.replace("a flat blue field", 'a plate reading "沿岸", spelled with those two characters');
  assert.ok(!rules(blocks(checkPromptText("x", quoted, CTX))).includes("B9"));
});

test("B9: 約物・全角/半角形も検出する(旧レンジは見落としていた)", () => {
  const punct = OK.replace("a flat blue field", "a flat blue field、and a fish。");
  assert.ok(rules(blocks(checkPromptText("x", punct, CTX))).includes("B9"));
});

test("B10: 画面内文字の字数宣言が実際と合っていなければ弾く", () => {
  const bad = OK.replace("a flat blue field", 'a plate reading "沿岸", spelled with those three characters');
  assert.ok(rules(blocks(checkPromptText("x", bad, CTX))).includes("B10"));
});

test("B10: 11文字以上は数字表記でも照合できる", () => {
  const many = "あいうえおかきくけこさ"; // 11文字
  const ok = OK.replace("a flat blue field", 'a plate reading "' + many + '", spelled with those 11 characters');
  assert.ok(!rules(blocks(checkPromptText("x", ok, CTX))).includes("B10"));
  const ng = OK.replace("a flat blue field", 'a plate reading "' + many + '", spelled with those 12 characters');
  assert.ok(rules(blocks(checkPromptText("x", ng, CTX))).includes("B10"));
});

test("B10: eleven〜twenty も単語表記で照合できる", () => {
  const many = "あいうえおかきくけこさ"; // 11文字
  const ok = OK.replace("a flat blue field", 'a plate reading "' + many + '", spelled with those eleven characters');
  assert.ok(!rules(blocks(checkPromptText("x", ok, CTX))).includes("B10"));
  const ng = OK.replace(
    "a flat blue field",
    ('a plate reading "' + many + '", spelled with those eleven characters').replace(many, many + "あ"),
  );
  assert.ok(rules(blocks(checkPromptText("x", ng, CTX))).includes("B10"));
});

test("B10: カンマ無し(\"X\" spelled with ...)でも字数不一致を検出する", () => {
  const noComma = OK.replace("a flat blue field", 'a plate reading "沿岸" spelled with those three characters');
  assert.ok(rules(blocks(checkPromptText("x", noComma, CTX))).includes("B10"));
});

// --- checkAdvisories / checkJobSet / checkLedger（Task 6） -----------------

const advise = (f: ReturnType<typeof checkAdvisories>) => f.map((x) => x.rule).sort();

test("A1: 紙・罫線・帳面は指定していない文字を呼ぶので指摘する", () => {
  assert.ok(advise(checkAdvisories("x", "A close shot of a notebook with ruled lines on the desk.")).includes("A1"));
});

test("A2: 変形の表現は事故るので指摘する", () => {
  assert.ok(advise(checkAdvisories("x", "The egg transforms into a fish.")).includes("A2"));
  assert.ok(advise(checkAdvisories("x", "The shape morphs slowly.")).includes("A2"));
});

test("A3: 実証済みの多義語を指摘する", () => {
  assert.ok(advise(checkAdvisories("x", "A wide shot of a water tank.")).includes("A3"));
});

test("A5: 場所から書き始めていなければ指摘する(先頭アンカー)", () => {
  assert.ok(advise(checkAdvisories("x", "The salmon swims forward in a wide shot of the sea.")).includes("A5"));
  assert.ok(!advise(checkAdvisories("x", "A wide shot of the sea. The salmon swims forward.")).includes("A5"));
});

test("A6: 否定形の禁止は効かないので指摘する", () => {
  assert.ok(advise(checkAdvisories("x", "A wide shot of a wall with no windows.")).includes("A6"));
});

test("A6: 語彙帳の閉じの一文は body に含まれないので雑音にならない", () => {
  // body だけを渡す前提。閉じの一文は合成器が足すので検査対象外
  assert.ok(!advise(checkAdvisories("x", "A wide shot of the sea. The camera holds a static shot.")).includes("A6"));
});

test("A7: カメラの記述が無ければ指摘する(止めない)", () => {
  const f = checkAdvisories("x", "A wide shot of the sea. The salmon swims forward.");
  assert.ok(advise(f).includes("A7"));
  assert.ok(f.every((x) => x.level === "ADVISE"));
});

test("A7: カメラ文はあるが CAMERA_MOTIONS の13語を1つも含まなければ指摘する(止めない)", () => {
  const f = checkAdvisories("x", "A wide shot of the sea. The camera moves a little.");
  assert.ok(advise(f).includes("A7"));
  assert.ok(f.every((x) => x.level === "ADVISE"));
});

test("A8: ショットの転換にディゾルブを使えば指摘する(止めない)", () => {
  assert.ok(advise(checkAdvisories("x", "The shot dissolves to a wide view.")).includes("A8"));
  assert.ok(!advise(checkAdvisories("x", "The pillar fades to a paler grey.")).includes("A8"));
});

test("B7: 参照画像の basename が重複したら BLOCK(Pod上で衝突する)", () => {
  const f = checkJobSet([
    { id: "a", prompt: "p", firstFrameFile: "/tmp/one/last.png" },
    { id: "b", prompt: "p", firstFrameFile: "/tmp/two/last.png" },
  ]);
  assert.ok(f.some((x) => x.rule === "B7" && x.message.includes("basename")));
});

test("B7: 実在検査は requireExists のときだけ走る", () => {
  const job = [{ id: "a", prompt: "p", firstFrameFile: "/does/not/exist.png" }];
  assert.ok(!checkJobSet(job).some((x) => x.rule === "B7"));
  assert.ok(checkJobSet(job, { requireExists: true }).some((x) => x.rule === "B7"));
});

test("B8: id の重複と空プロンプトを弾く", () => {
  assert.ok(checkJobSet([{ id: "a", prompt: "p" }, { id: "a", prompt: "p" }]).some((x) => x.rule === "B8"));
  assert.ok(checkJobSet([{ id: "a", prompt: "   " }]).some((x) => x.rule === "B8"));
});

test("B11: 台帳と宣言のフラグが食い違えば弾く", () => {
  const cut: Cut = { lineIds: ["L01"], seconds: 5.167, place: "SEA", subject: "ADULT", role: "導入" };
  const decl: ShotDecl = { body: "b", sound: "s", chain: true };
  const f = checkLedger("cL01", decl, { ...cut });
  assert.ok(f.some((x) => x.rule === "B11" && x.message.includes("chain")));
  assert.deepEqual(checkLedger("cL01", { body: "b", sound: "s" }, cut), []);
});

test("B11: 台帳に無いカットを弾く", () => {
  assert.ok(checkLedger("cL99", { body: "b" }, undefined).some((x) => x.rule === "B11"));
});

// --- Fix round 1(レビュー対応の再現テスト) ---------------------------------

test("A7 fix: 公式作例そのままの標準形(pushes)は A7 にならない", () => {
  const f = checkAdvisories(
    "x",
    "A wide shot of the sea. The camera pushes in with small amplitude at slow speed toward the fish.",
  );
  assert.ok(!advise(f).includes("A7"));
});

test("A7 fix: 公式語彙が無い文は引き続き A7(止めない)", () => {
  const f = checkAdvisories("x", "A wide shot of the sea. The camera moves a little.");
  assert.ok(advise(f).includes("A7"));
  assert.ok(f.every((x) => x.level === "ADVISE"));
});

test("A7 fix: 活用形(pushes/pans/trucks/tilts/zooms/rolls)を認識する", () => {
  const verbs = ["pushes", "pans", "trucks", "tilts", "zooms", "rolls"];
  for (const v of verbs) {
    const f = checkAdvisories("x", `A wide shot of the sea. The camera ${v} toward the fish.`);
    assert.ok(!advise(f).includes("A7"), v);
  }
});

test("B11 fix: chain の false と未指定は同じ扱い(両方向)", () => {
  const cut: Cut = { lineIds: ["L01"], seconds: 5.167, place: "SEA", subject: "ADULT", role: "導入" };
  assert.deepEqual(checkLedger("cL01", { body: "b", chain: false }, cut), []);
  assert.deepEqual(checkLedger("cL01", { body: "b" }, { ...cut, chain: false }), []);
});

test("B11 fix: card があるカットは台帳に text が無くても弾かない", () => {
  const cut: Cut = {
    lineIds: ["L01"],
    seconds: 5.167,
    place: "SEA",
    subject: "ADULT",
    role: "導入",
    card: ["1", "序章"],
  };
  const decl: ShotDecl = { body: "b", sound: "s", text: true, card: ["1", "序章"] };
  assert.deepEqual(checkLedger("cL01", decl, cut), []);
});

test("A5 fix: shot from / shot taken from も場所の記述として認める", () => {
  assert.ok(
    !advise(checkAdvisories("x", "A wide shot taken from inside the mouth of a river, looking out to the sea.")).includes(
      "A5",
    ),
  );
  assert.ok(!advise(checkAdvisories("x", "A wide shot from inside the burrow, looking out.")).includes("A5"));
});

test("A2 fix: 色・方向を表す自然文は A2 にならない(転換語のみに絞る)", () => {
  assert.ok(!advise(checkAdvisories("x", "The water becomes a pale green.")).includes("A2"));
  assert.ok(!advise(checkAdvisories("x", "The salmon turns into the side channel.")).includes("A2"));
  // 実証済みの罠(識別されたアイデンティティ変形)は引き続き指摘する
  assert.ok(advise(checkAdvisories("x", "The egg transforms into a fish.")).includes("A2"));
});

// --- Fix round 2(303カット実走で判明した誤検知の修正) ----------------------

/** 検査用の最小語彙帳。閉じの一文3種だけが要る */
const VOCAB: Vocab = {
  STYLE: "2D-animated doodle style.",
  CLOSE:
    "Nothing else appears in the frame at any point, and no writing, numbers, symbols, diagrams or people of any kind appear.",
  CLOSE_H: "Nothing else appears in the frame at any point, and no writing, numbers, symbols or diagrams of any kind appear.",
  CLOSE_TEXT: "No other writing, number, label or mark appears anywhere in the frame at any point, and no people appear.",
  CLOSEUP_GUARD: "Even at this size the subject stays a simple flat doodle drawing.",
  places: {},
  subjects: {},
  props: {},
};

test("A5 fix2: 場所を明記した正当な書き出し(of/from 以外)を A5 にしない", () => {
  const ok = [
    "A wide shot filled edge to edge with a dense field of orange salmon roe pearls packed between rounded grey pebbles.",
    "A close overhead shot looking straight down at a flat grey concrete floor with shallow water running across it.",
    "A very close shot inside a river gravel bed, framed tight on one pearl.",
    "A wide shot that begins on the same map, with the same two trails already drawn on it.",
    "A wide shot of the sea.",
    "A cutaway side view of a river gravel bed filling the whole frame.",
  ];
  for (const body of ok) assert.ok(!advise(checkAdvisories("x", body)).includes("A5"), body.slice(0, 40));
});

test("A5 fix2: 被写体から始まる文は引き続き A5(途中に shot があるだけでは通さない)", () => {
  assert.ok(advise(checkAdvisories("x", "The salmon swims forward in a wide shot of the sea.")).includes("A5"));
});

test("A7 fix2: 静止を散文で書いたカメラ文は A7 にしない(公式 Static Shot と同義)", () => {
  assert.ok(!advise(checkAdvisories("x", "A wide shot of the sea. The camera stays fixed, not moving at all.")).includes("A7"));
  assert.ok(!advise(checkAdvisories("x", "A wide shot of exactly the same frame, the camera not moving at all.")).includes("A7"));
});

test("A7 fix2: 動きが読み取れないカメラ文は引き続き A7", () => {
  assert.ok(advise(checkAdvisories("x", "A wide shot of the sea. The camera moves a little.")).includes("A7"));
});

test("A6 fix2: 閉じの一文は A6 にしない(negative prompt が無いモデルで唯一使える禁止手段)", () => {
  const body = "A wide shot of the sea. The camera holds a static shot. " + VOCAB.CLOSE;
  assert.ok(!advise(checkAdvisories("x", body, VOCAB)).includes("A6"));
  assert.ok(advise(checkAdvisories("x", body, VOCAB)).includes("A9"));
});

test("A6 fix2: 語彙帳に無い手書きの変種も閉じの一文として落とす", () => {
  // cL133 の実物(語彙帳のどれとも一致しない6変種目)。vocab を渡さなくても落ちること
  const tail =
    "Nothing else appears in the frame at any point, no writing, numbers, symbols or people of any kind appear, " +
    "and no hands and no arms enter the frame.";
  const body = "A wide shot of the same gauge on cream paper. The camera holds a static shot. " + tail;
  assert.ok(!advise(checkAdvisories("x", body)).includes("A6"));
  assert.ok(advise(checkAdvisories("x", body)).includes("A9"));
});

test("A6 fix2: 本文の途中に散らばった否定は引き続き拾う(散在型こそが危ない)", () => {
  // 語彙 HATCHERY の実物。閉じの一文ではないので落とさない
  const body =
    "A close shot of a flat pale grey concrete floor with shallow clear water running across it, framed close so that " +
    "no wall, window, ceiling, doorway or horizon is visible at any point. The camera holds a static shot. " +
    VOCAB.CLOSE;
  const f = advise(checkAdvisories("x", body, VOCAB));
  assert.ok(f.includes("A6"));
  assert.ok(f.includes("A9"));
});

test("A6 fix2: 語彙 BLANK_PLATE の no text は閉じの一文ではないので残る", () => {
  const body =
    "A wide shot of the cream paper. A plain pale rectangle with a thin black outline and a completely blank inside, " +
    "with no text, no letters, no ruled lines and no marks of any kind on it, sits in the middle. The camera holds a static shot.";
  assert.ok(advise(checkAdvisories("x", body)).includes("A6"));
});

test("A9 fix2: 閉じの一文が手書きされていなければ A9 は出ない", () => {
  assert.ok(!advise(checkAdvisories("x", "A wide shot of the sea. The camera holds a static shot.", VOCAB)).includes("A9"));
});

test("stripClosingSentences: 語彙帳の3種と手書きの変種を落とし、本文は変えない", () => {
  const head = "A wide shot of the sea. The camera holds a static shot.";
  for (const closing of [VOCAB.CLOSE, VOCAB.CLOSE_H, VOCAB.CLOSE_TEXT]) {
    const r = stripClosingSentences(head + " " + closing, VOCAB);
    assert.equal(r.kept, head);
    assert.deepEqual(r.stripped, [closing]);
  }
  const none = stripClosingSentences(head, VOCAB);
  assert.equal(none.kept, head);
  assert.deepEqual(none.stripped, []);
});

// --- Fix round 2(ADVISE の表示畳み込み) -----------------------------------

const adv = (id: string, rule: string, message: string): Finding => ({ level: "ADVISE", id, rule, message });

test("fold: 規則IDとメッセージが完全に同一の指摘だけを畳む", () => {
  const g = foldFindings([
    adv("cL01", "A6", "同じ"),
    adv("cL02", "A7", "別の規則"),
    adv("cL03", "A6", "同じ"),
    adv("cL04", "A6", "メッセージが違う"),
  ]);
  assert.deepEqual(
    g.map((x) => [x.rule, x.message, x.ids]),
    [
      ["A6", "同じ", ["cL01", "cL03"]],
      ["A7", "別の規則", ["cL02"]],
      ["A6", "メッセージが違う", ["cL04"]],
    ],
  );
});

test("fold: A1 のように固有値が埋まったメッセージは別行のまま残る", () => {
  const g = foldFindings([
    adv("cL124", "A1", "「ruled lines」— 紙・帳面・罫線は…"),
    adv("cL143", "A1", "「sheet of paper」— 紙・帳面・罫線は…"),
  ]);
  assert.equal(g.length, 2);
});

test("fold: 1件だけの指摘は従来どおり「ID [規則] メッセージ」で出す", () => {
  assert.equal(renderFolded({ rule: "A1", message: "紙", ids: ["cL124"] }), "⚠️  cL124 [A1] 紙");
});

test("fold: 複数件は件数とID一覧を出し、上限を超えたぶんは「ほか N件」にする", () => {
  const few = renderFolded({ rule: "A6", message: "否定", ids: ["cL01", "cL02"] });
  assert.equal(few, "⚠️  [A6] ×2 否定: cL01, cL02");

  const ids = Array.from({ length: FOLD_ID_LIMIT + 5 }, (_, i) => "cL" + String(i + 1).padStart(2, "0"));
  const many = renderFolded({ rule: "A9", message: "二重", ids });
  assert.ok(many.startsWith("⚠️  [A9] ×" + ids.length + " 二重: "));
  assert.ok(many.includes(ids.slice(0, FOLD_ID_LIMIT).join(", ")));
  assert.ok(many.endsWith("、ほか 5件"));
  assert.ok(!many.includes(ids[FOLD_ID_LIMIT]));
});

test("fold: 指摘が無ければ0行", () => {
  assert.deepEqual(foldFindings([]), []);
});

test("A10: 早回し 1.4 倍超は ADVISE になる", () => {
  const out = checkSpeedup([
    { cutId: "cL01", spanSeconds: 2.0, generatedSeconds: 5.167, ratio: 2.58 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "ADVISE");
  assert.equal(out[0].rule, "A10");
  assert.equal(out[0].id, "cL01");
  assert.match(out[0].message, /2\.58/);
});

test("A10: 閾値ちょうどは出さない", () => {
  assert.equal(checkSpeedup([
    { cutId: "cL02", spanSeconds: 3.69, generatedSeconds: 5.167, ratio: 1.4 },
  ]).length, 0);
});

test("A10: holdSlow を立てたカットは束ねを検討済みなので黙る", () => {
  assert.equal(checkSpeedup([
    { cutId: "cL03", spanSeconds: 2.0, generatedSeconds: 5.167, ratio: 2.58 },
  ], new Set(["cL03"])).length, 0);
});

test("B12: non_diegetic_music が N/A 以外なら BLOCK", () => {
  const prompt = [
    "integrated_multimodal_description: [Shot 1] A wide shot of a river. The camera holds a static shot.",
    "",
    "overall_soundscape: Water runs over stones.",
    "",
    "non_diegetic_music: Sparse piano notes at a slow tempo.",
  ].join("\n");
  const out = checkPromptText("cL01", prompt, { seconds: 5.167, hasFirstFrame: false });
  const b12 = out.filter((f) => f.rule === "B12");
  assert.equal(b12.length, 1);
  assert.equal(b12[0].level, "BLOCK");
});

test("B12: N/A なら通る", () => {
  const prompt = [
    "integrated_multimodal_description: [Shot 1] A wide shot of a river. The camera holds a static shot.",
    "",
    "overall_soundscape: Water runs over stones.",
    "",
    "non_diegetic_music: N/A",
  ].join("\n");
  assert.equal(
    checkPromptText("cL01", prompt, { seconds: 5.167, hasFirstFrame: false })
      .filter((f) => f.rule === "B12").length,
    0,
  );
});

// --- checkSelfContained（A11: 前カット参照） -------------------------------

const a11 = (id: string, decl: ShotDecl, hasFirstFrame = false) =>
  checkSelfContained(id, decl, { hasFirstFrame }).map((x) => x.rule);

test("A11: 参照画像の無いカットの body の「than before」を指摘する", () => {
  const decl: ShotDecl = { body: "A wide shot of a river. Here the water is much shallower than before." };
  assert.deepEqual(a11("cL202", decl), ["A11"]);
});

test("A11: 参照画像のあるカット（chain）の body は指摘しない（first_frame が参照を解決する）", () => {
  const decl: ShotDecl = { body: "A close shot of a river. The head is held as before." };
  assert.deepEqual(a11("cL182", decl, true), []);
});

test("A11: sound は chain があっても指摘する（音に前の文脈は渡らない）", () => {
  const decl: ShotDecl = { body: "A wide shot of a river.", sound: "A hum, deeper and quieter than before." };
  assert.deepEqual(a11("cL85", decl, true), ["A11"]);
});

test("A11: 「than earlier」も拾う", () => {
  const decl: ShotDecl = { body: "A wide shot of a river, thinner than earlier." };
  assert.deepEqual(a11("cL114", decl), ["A11"]);
});

test("A11: 素の body / sound には出ない", () => {
  const decl: ShotDecl = { body: "A wide shot of a river. The camera holds a static shot.", sound: "A low hum." };
  assert.deepEqual(a11("cL01", decl), []);
});

test("A11: 指摘文に該当語と該当フィールドが入る", () => {
  const f = checkSelfContained("cL202", { body: "A wide shot, shallower than before." }, { hasFirstFrame: false });
  assert.match(f[0].message, /than before/);
  assert.match(f[0].message, /body/);
});

// --- A5: 場所から始まっているか(2026-08-27 緩和) ------------------------

const a5 = (body: string) => checkAdvisories("x", body).map((f) => f.rule).includes("A5");

test("A5: 分詞・前置詞で場所を言い切る書き出しも認める", () => {
  for (const body of [
    "Looking up from the bottom of a canyon of giant black slabs, the animal stands small at the base. The camera tilts up at slow speed.",
    "Seen from directly above a slow African river, the water curves across the middle. The camera holds a static shot.",
    "Inside a river gravel bed, one egg lies between the stones. The camera holds a static shot.",
    "Framed by the mouth of a burrow, the dry ground stretches away. The camera holds a static shot.",
  ]) assert.equal(a5(body), false, body);
});

test("A5: 被写体から始まる書き出しは今までどおり指摘する", () => {
  assert.equal(a5("The salmon swims forward in a wide shot of the sea. The camera holds a static shot."), true);
  assert.equal(a5("A large adult hippopotamus stands beside the water. The camera holds a static shot."), true);
});

test("A5: 従来の A/An/The + shot / view の書き出しは引き続き通る", () => {
  assert.equal(a5("A wide shot of a flat blue field. The camera holds a static shot."), false);
  assert.equal(a5("A close overhead shot looking straight down at the silt. The camera holds a static shot."), false);
});

// --- A13 / B13: noSub の検査(2026-08-27 敵対レビュー対応) ------------------

const LEDGER_CUT: Cut = { lineIds: ["L01"], seconds: 5.167, place: "P", subject: "S", role: "r" };
const decl0: ShotDecl = { body: "b", sound: "s" };

test("A13: text の無いカットに noSub を立てたら指摘する(字幕が黙って消える)", () => {
  const f = checkLedger("cL01", decl0, { ...LEDGER_CUT, noSub: true });
  assert.ok(f.map((x) => x.rule).includes("A13"));
  assert.ok(f.filter((x) => x.rule === "A13").every((x) => x.level === "ADVISE"));
});

test("A13: text: true のカットの noSub は正しい使い方なので指摘しない", () => {
  const f = checkLedger("cL01", { ...decl0, text: true }, { ...LEDGER_CUT, text: true, noSub: true });
  assert.ok(!f.map((x) => x.rule).includes("A13"));
});

test("A13: 章カードの noSub は指摘しない(画面の文言と字幕の文言が別物)", () => {
  const card: [string, string] = ["第一章", "誕生"];
  const f = checkLedger("cL01", { card, text: true }, { ...LEDGER_CUT, card, noSub: true });
  assert.ok(!f.map((x) => x.rule).includes("A13"));
});

test("B13: cuts.json の未知のキーを弾く(noSub の綴り間違いが黙って無効になるのを防ぐ)", () => {
  const typo = { ...LEDGER_CUT, nosub: true } as unknown as Cut;
  const f = checkLedger("cL01", decl0, typo);
  const b13 = f.filter((x) => x.rule === "B13");
  assert.equal(b13.length, 1);
  assert.equal(b13[0].level, "BLOCK");
  assert.match(b13[0].message, /nosub/);
});

test("B13: 既知のキーだけの台帳は素通りする", () => {
  const full: Cut = {
    ...LEDGER_CUT, chain: true, chainFrom: "cL00", hi: true, text: true,
    card: ["第一章", "誕生"], holdSlow: true, noSub: true,
  };
  assert.ok(!checkLedger("cL01", { ...decl0, chain: true, chainFrom: "cL00", hi: true, card: ["第一章", "誕生"] }, full)
    .map((x) => x.rule).includes("B13"));
});

test("A11: 語彙帳の否定形は項目ごとに1件。body の A6 で語彙由来のものは落とす", async () => {
  const { checkVocabNegations, dropVocabOriginA6 } = await import("./check");
  const vocab = {
    STYLE: "no shading and no gradients.", CLOSE: "Nothing else appears.", CLOSE_H: "x", CLOSE_TEXT: "x", CLOSEUP_GUARD: "x",
    places: { HATCHERY: "a bare grey floor with no wall, window or ceiling" },
    subjects: { HATCHLING: "one tiny axolotl with no legs and a paddle tail", ADULT: "one axolotl with four short legs" },
    props: {},
  };
  const f = checkVocabNegations(vocab);
  assert.deepEqual(f.map((x) => x.id), ["places.HATCHERY", "subjects.HATCHLING"]);
  assert.ok(f.every((x) => x.rule === "A11" && x.level === "ADVISE"));
  const a6 = [
    { level: "ADVISE" as const, id: "cL01", rule: "A6", message: "「no wall」— 否定形" },
    { level: "ADVISE" as const, id: "cL02", rule: "A6", message: "「no people」— 否定形" },
    { level: "ADVISE" as const, id: "cL03", rule: "A1", message: "「notebook」— 紙" },
  ];
  assert.deepEqual(dropVocabOriginA6(a6, vocab).map((x) => x.id), ["cL02", "cL03"]);
});
