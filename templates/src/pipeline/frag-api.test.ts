import assert from "node:assert/strict";
import test from "node:test";
import { docAbove, extractApi, renderApiMarkdown } from "./frag-api";

const SRC = `
const DEV = {};

/** 素材を「見える大きさ」で置く(bboxで実測済み) */
function pic(host, key, o) { return null; }

// 手描きの揺れた線を返す
DEV.wob = function (x1, y1, x2, y2, amp, seed) { return ""; };

/* 巣の断面の既定寸法 */
DEV.NEST = {
  rooms: 5,
};

function __internal(a) { return a; }

function dtext(c, text, o) { return null; }
DEV.dtext = dtext;
`;

test("extractApi: 関数・名前空間の装置・定数表を拾う", () => {
  const api = extractApi(SRC);
  const names = api.map((e) => e.name);
  assert.deepEqual(names, ["pic", "DEV.wob", "DEV.NEST", "dtext"]);
});

test("extractApi: 内部専用(先頭 __)と、本体で既に拾えた再輸出は配らない", () => {
  const names = extractApi(SRC).map((e) => e.name);
  assert.ok(!names.includes("__internal"), "内部専用は配らない");
  assert.equal(names.filter((n) => n.endsWith("dtext")).length, 1, "DEV.dtext = dtext の再輸出で二重にしない");
});

test("extractApi: 引数つきの見出しと一行説明を作る", () => {
  const api = extractApi(SRC);
  assert.deepEqual(api[0], {
    name: "pic",
    signature: "pic(host, key, o)",
    doc: "素材を「見える大きさ」で置く(bboxで実測済み)",
  });
  assert.equal(api[1].signature, "DEV.wob(x1, y1, x2, y2, amp, seed)");
  assert.equal(api[1].doc, "手描きの揺れた線を返す");
  assert.equal(api[2].signature, "DEV.NEST = {...}");
});

test("docAbove: 直前がコメントでなければ説明にしない", () => {
  const lines = ["var x = 1;", "function f(a) {}"];
  assert.equal(docAbove(lines, 1), "");
});

test("renderApiMarkdown: 本体を全文Readしない指示を含む", () => {
  const md = renderApiMarkdown("G1.js の部品一覧", extractApi(SRC));
  assert.match(md, /全文Read/);
  assert.match(md, /- `pic\(host, key, o\)` — 素材を/);
});

test("docAbove: JSDocは先頭の要約を採る(@example などのタグ本文を拾わない)", () => {
  const src = `
/**
 * 手描きの揺れた線のパスを返す。
 * @example S(sv, "path", { d: DEV.wob(240, 706, 700, 706, 4, 11) });
 */
DEV.wob = function (x1, y1, amp) { return ""; };
`;
  assert.equal(extractApi(src)[0].doc, "手描きの揺れた線のパスを返す。");
});

test("extractApi: 1行に複数並ぶ再輸出も配らない", () => {
  const src = `
function wipeIn(el, t) {}
function buryUp(el, t) {}
DEV.wipeIn = wipeIn; DEV.buryUp = buryUp;
`;
  assert.deepEqual(extractApi(src).map((e) => e.name), ["wipeIn", "buryUp"]);
});
