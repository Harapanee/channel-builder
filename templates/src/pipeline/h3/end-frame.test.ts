import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { END_FRAME_TEMPLATE, FFMPEG_FIT_FILTER, endFramePrompt, genEndFrame } from "./end-frame";

test("テンプレは endState だけを差し込む", () => {
  const p = endFramePrompt("the jaws are fully protruded");
  assert.ok(p.includes("Change ONLY the following: the jaws are fully protruded."));
  assert.ok(p.startsWith("Use the exact same character, art style, colors, and background as the reference image"));
  assert.ok(!p.includes("<endState>"));
  assert.ok(END_FRAME_TEMPLATE.includes("<endState>"));
});

test("genEndFrame は gen を1回呼び、出力を指定サイズに整える", () => {
  const dir = mkdtempSync(join(tmpdir(), "ef-"));
  const calls: { prompt: string; ref: string; out: string }[] = [];
  // gen は out に 16:9 でない PNG を書く(リサイズされることを確かめる)
  const gen = (a: { prompt: string; ref: string; out: string }) => {
    calls.push(a);
    // 1x1 の PNG(実体があればよい)
    writeFileSync(a.out, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  };
  const out = genEndFrame({ epId: "epX", cutId: "cL67", refPng: "/tmp/ref.png", endState: "jaws out", size: { width: 1344, height: 768 }, gen, outDir: dir });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, "/tmp/ref.png");
  assert.ok(calls[0].prompt.includes("jaws out"));
  assert.ok(existsSync(out));
  // 既存なら呼ばない / force なら呼ぶ
  genEndFrame({ epId: "epX", cutId: "cL67", refPng: "/tmp/ref.png", endState: "jaws out", size: { width: 1344, height: 768 }, gen, outDir: dir });
  assert.equal(calls.length, 1);
  genEndFrame({ epId: "epX", cutId: "cL67", refPng: "/tmp/ref.png", endState: "jaws out", size: { width: 1344, height: 768 }, gen, outDir: dir, force: true });
  assert.equal(calls.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("genEndFrame は ref が out より新しければ作り直す(鎖の起点が作り直された後)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ef-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const ref = join(dir, "cL66-last.png");
  writeFileSync(ref, png);
  let calls = 0;
  const gen = (a: { prompt: string; ref: string; out: string }) => { calls++; writeFileSync(a.out, png); };
  const size = { width: 1344, height: 768 };
  const out = genEndFrame({ epId: "epX", cutId: "cL67", refPng: ref, endState: "jaws out", size, gen, outDir: dir });
  assert.equal(calls, 1);
  // ref が古い → 再利用
  const t0 = new Date(Date.now() - 60_000);
  utimesSync(ref, t0, t0);
  genEndFrame({ epId: "epX", cutId: "cL67", refPng: ref, endState: "jaws out", size, gen, outDir: dir });
  assert.equal(calls, 1);
  // ref が out より新しい → 作り直す
  const t1 = new Date(statSync(out).mtimeMs + 60_000);
  utimesSync(ref, t1, t1);
  genEndFrame({ epId: "epX", cutId: "cL67", refPng: ref, endState: "jaws out", size, gen, outDir: dir });
  assert.equal(calls, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("genEndFrame は gen の例外を Pod 停止の案内つきで包み直す(cause に元の例外)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ef-"));
  const boom = new Error("codex failed");
  const gen = () => { throw boom; };
  assert.throws(
    () => genEndFrame({ epId: "epX", cutId: "cL67", refPng: "/tmp/ref.png", endState: "jaws out", size: { width: 1344, height: 768 }, gen, outDir: dir }),
    (e: unknown) => e instanceof Error && /cL67: 終点画像の生成に失敗\(gen-image: codex\/evolink\)/.test(e.message) && /h3:pod -- down/.test(e.message) && (e as Error & { cause?: unknown }).cause === boom,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("genEndFrame は非16:9 の出力を引き伸ばさず、拡大してから切り出す", () => {
  const dir = mkdtempSync(join(tmpdir(), "ef-"));
  // 100x100 の正方形 PNG を gen が書く → 1344x768 に整える(引き伸ばしでなく scale+crop)
  const gen = (a: { prompt: string; ref: string; out: string }) => {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=100x100", "-frames:v", "1", "-y", a.out]);
  };
  const out = genEndFrame({ epId: "epX", cutId: "cL67", refPng: "/tmp/ref.png", endState: "jaws out", size: { width: 1344, height: 768 }, gen, outDir: dir });
  const dim = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim();
  assert.equal(dim, "1344,768");
  assert.match(FFMPEG_FIT_FILTER(1344, 768), /force_original_aspect_ratio=increase,crop=1344:768/);
  rmSync(dir, { recursive: true, force: true });
});

test("B6: sourceClip を渡すと鮮度は起点クリップの mtime で見る(ff 画像の抽出し直しでは再生成しない)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ef-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const ref = join(dir, "cL66-last.png");
  const clip = join(dir, "cL66.mp4");
  writeFileSync(ref, png);
  writeFileSync(clip, "clip");
  let calls = 0;
  const gen = (a: { prompt: string; ref: string; out: string }) => { calls++; writeFileSync(a.out, png); };
  const size = { width: 1344, height: 768 };
  const old = new Date(Date.now() - 600_000);
  utimesSync(clip, old, old);
  const out = genEndFrame({ epId: "epX", cutId: "cL67", refPng: ref, sourceClip: clip, endState: "jaws out", size, gen, outDir: dir });
  assert.equal(calls, 1);
  // ff 画像だけが新しくなった(抽出し直し)→ 起点クリップは古いままなので再利用
  const later = new Date(statSync(out).mtimeMs + 60_000);
  utimesSync(ref, later, later);
  genEndFrame({ epId: "epX", cutId: "cL67", refPng: ref, sourceClip: clip, endState: "jaws out", size, gen, outDir: dir });
  assert.equal(calls, 1);
  // 起点クリップが作り直された → 終点も作り直す
  utimesSync(clip, later, later);
  genEndFrame({ epId: "epX", cutId: "cL67", refPng: ref, sourceClip: clip, endState: "jaws out", size, gen, outDir: dir });
  assert.equal(calls, 2);
  rmSync(dir, { recursive: true, force: true });
});
