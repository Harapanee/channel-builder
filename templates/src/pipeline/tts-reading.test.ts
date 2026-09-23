import { test } from "node:test";
import assert from "node:assert/strict";
import { ttsReadingText } from "./tts";

test("「はね、」は「わね、」に開く(既存)", () => {
  assert.equal(ttsReadingText("これはね、最悪です。"), "これわね、最悪です。");
  assert.equal(ttsReadingText("これはねずみ"), "これはねずみ");
});

test("「ありません」は「有りません」に閉じる(アクセント句の融合を防ぐ)", () => {
  assert.equal(ttsReadingText("逃げる方法はありません。"), "逃げる方法は有りません。");
  assert.equal(ttsReadingText("選択肢はありませんでした。"), "選択肢は有りませんでした。");
  assert.equal(ttsReadingText("何もありません。"), "何も有りません。");
  // 既に漢字なら変えない
  assert.equal(ttsReadingText("何も有りません。"), "何も有りません。");
  // 「あります」「ありました」は対象外
  assert.equal(ttsReadingText("方法はあります。"), "方法はあります。");
});

test("ep036: 辞書で直らない名詞をかなに開く(字幕は原文のまま)", () => {
  assert.equal(ttsReadingText("木から落ちた木の実です。"), "木から落ちたきのみです。");
  assert.equal(ttsReadingText("うす緑色の卵"), "うすみどりいろの卵");
  assert.equal(ttsReadingText("消化管と血管"), "しょうかかんとけっかん");
});
