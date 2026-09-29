import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TtsError,
  buildElevenLabsRequest,
  loadElevenLabsApiKey,
  runReadingsOnly,
  runTts,
  synthesizeElevenLabs,
} from "./tts";

// 実 API は呼ばない。globalThis.fetch を差し替えて検査する。

const realFetch = globalThis.fetch;
const savedKey = process.env.ELEVENLABS_API_KEY;
let tmp: string;

type Call = { url: string; init: RequestInit };

function mockFetch(
  respond: (call: Call, n: number) => Response | Promise<Response>
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return calls;
}

/** ffmpeg で 44.1kHz/stereo の正弦波 mp3 を作る(ElevenLabs 既定 mp3_44100_128 相当) */
function makeMp3(sec: number): Buffer {
  const out = path.join(tmp, `tone-${sec}.mp3`);
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`, "-ar", "44100", "-ac", "2", out],
    { stdio: "ignore" }
  );
  return readFileSync(out);
}

function probe(file: string, entries: string): string {
  return execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", entries, "-of", "default=noprint_wrappers=1:nokey=1", file],
    { encoding: "utf-8" }
  ).trim();
}

const VOICE = {
  provider: "elevenlabs",
  voiceId: "b34JylakFZPlGS0BnwyY",
  speakerId: 0,
  speedScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  defaultPauseAfterLineSec: 0.35,
  creditNotice: "ElevenLabs",
};

function setupProject(voice: Record<string, unknown>, withKey = true): string {
  const root = path.join(tmp, "proj");
  mkdirSync(path.join(root, "channel"), { recursive: true });
  mkdirSync(path.join(root, "episodes", "ep900-el"), { recursive: true });
  writeFileSync(path.join(root, "channel", "voice.json"), JSON.stringify(voice));
  if (withKey) writeFileSync(path.join(root, ".env"), "OTHER=1\nELEVENLABS_API_KEY=sk-test-123\n");
  writeFileSync(
    path.join(root, "episodes", "ep900-el", "script.md"),
    [
      "# テスト",
      "",
      "## [L01] 1 誕生",
      "> これはね、さんさいです。",
      "- display: これはね、3歳です。",
      "- pause_after_sec: 0.5",
      "",
      "## [L02] 1 誕生",
      "> 逃げる方法はありません。",
      "",
    ].join("\n")
  );
  return root;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tts-el-test-"));
  delete process.env.ELEVENLABS_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = savedKey;
  rmSync(tmp, { recursive: true, force: true });
});

test("elevenlabs: リクエストは voice_id・xi-api-key・eleven_v4・language_code ja", () => {
  const req = buildElevenLabsRequest("こんにちは。", { ...VOICE }, "sk-x");
  assert.equal(
    req.url,
    "https://api.elevenlabs.io/v1/text-to-speech/b34JylakFZPlGS0BnwyY?output_format=mp3_44100_128"
  );
  assert.equal(req.init.method, "POST");
  const headers = req.init.headers as Record<string, string>;
  assert.equal(headers["xi-api-key"], "sk-x");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(String(req.init.body));
  assert.deepEqual(body, { text: "こんにちは。", model_id: "eleven_v4", language_code: "ja" });
});

test("elevenlabs: modelId と voice_settings(stability/similarityBoost/style)を渡す", () => {
  const req = buildElevenLabsRequest(
    "テスト",
    { ...VOICE, modelId: "eleven_multilingual_v2", stability: 0.4, similarityBoost: 0.8, style: 0 },
    "k"
  );
  const body = JSON.parse(String(req.init.body));
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.deepEqual(body.voice_settings, { stability: 0.4, similarity_boost: 0.8, style: 0 });
});

test("elevenlabs: voiceId が無ければ TtsError", () => {
  assert.throws(() => buildElevenLabsRequest("x", { modelId: "eleven_v4" }, "k"), (e: unknown) =>
    e instanceof TtsError && /voiceId/.test(e.message)
  );
});

test("elevenlabs: キーは環境変数→.env の順で読み、無ければ TtsError", () => {
  const root = path.join(tmp, "k");
  mkdirSync(root);
  assert.throws(() => loadElevenLabsApiKey(root), (e: unknown) =>
    e instanceof TtsError && /\.env に ELEVENLABS_API_KEY がありません/.test(e.message)
  );
  writeFileSync(path.join(root, ".env"), "ELEVENLABS_API_KEY= sk-env \n");
  assert.equal(loadElevenLabsApiKey(root), "sk-env");
  process.env.ELEVENLABS_API_KEY = "sk-proc";
  assert.equal(loadElevenLabsApiKey(root), "sk-proc");
});

test("elevenlabs: 429/5xx は再試行し、4xx は即時失敗", async () => {
  let calls = mockFetch((_c, n) =>
    n < 3 ? new Response("busy", { status: n === 1 ? 429 : 503 }) : new Response(new Uint8Array([1, 2, 3]))
  );
  const buf = await synthesizeElevenLabs("x", { ...VOICE }, "k", { retryBaseMs: 1 });
  assert.equal(calls.length, 3);
  assert.deepEqual([...buf], [1, 2, 3]);

  calls = mockFetch(() => new Response('{"detail":"invalid_api_key"}', { status: 401 }));
  await assert.rejects(
    synthesizeElevenLabs("x", { ...VOICE }, "k", { retryBaseMs: 1 }),
    (e: unknown) => e instanceof TtsError && /HTTP 401/.test(e.message)
  );
  assert.equal(calls.length, 1);
});

test("elevenlabs: runTts はキーが無いと合成前に TtsError", async () => {
  const root = setupProject(VOICE, false);
  const calls = mockFetch(() => new Response("", { status: 500 }));
  await assert.rejects(runTts("episodes/ep900-el", root), (e: unknown) =>
    e instanceof TtsError && /ELEVENLABS_API_KEY/.test(e.message)
  );
  assert.equal(calls.length, 0);
});

test("elevenlabs: runTts は本文を1行ずつ合成し 24kHz/mono/16bit・timing.json・readings.md を出す", async () => {
  const root = setupProject({ ...VOICE, speedScale: 1.25 });
  const mp3 = makeMp3(1.0);
  const calls = mockFetch(() => new Response(new Uint8Array(mp3), { headers: { "Content-Type": "audio/mpeg" } }));

  const timing = await runTts("episodes/ep900-el", root);

  // VOICEVOX(127.0.0.1:50021)には一切触れず、ElevenLabs だけを行数ぶん呼ぶ
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/b34JylakFZPlGS0BnwyY/);
    assert.equal((c.init.headers as Record<string, string>)["xi-api-key"], "sk-test-123");
  }
  // 本文(引用ブロック)を読ませる。display ではない。VOICEVOX 用の読み補正も掛けない
  const texts = calls.map((c) => JSON.parse(String(c.init.body)).text);
  assert.deepEqual(texts, ["これはね、さんさいです。", "逃げる方法はありません。"]);

  const ep = path.join(root, "episodes", "ep900-el");
  const l01 = path.join(ep, "narration", "L01.wav");
  assert.equal(probe(l01, "stream=sample_rate"), "24000");
  assert.equal(probe(l01, "stream=channels"), "1");
  assert.equal(probe(l01, "stream=sample_fmt"), "s16");
  // speedScale 1.25 を atempo で適用 → 1.0s / 1.25 ≈ 0.8s
  const l01Sec = Number(probe(l01, "format=duration"));
  assert.ok(Math.abs(l01Sec - 0.8) < 0.06, `L01 長さ ${l01Sec}`);

  assert.equal(timing.lines.length, 2);
  const [a, b] = timing.lines;
  assert.equal(a.text, "これはね、さんさいです。");
  assert.equal(a.displayText, "これはね、3歳です。");
  assert.ok(Math.abs(a.endSec - a.startSec - l01Sec) < 1e-6);
  // pause_after_sec 0.5 が行間に入る
  assert.ok(Math.abs(b.startSec - a.endSec - 0.5) < 1e-6);
  const onDisk = JSON.parse(readFileSync(path.join(ep, "timing.json"), "utf-8"));
  assert.equal(onDisk.lines.length, 2);

  const readings = readFileSync(path.join(ep, "narration", "readings.md"), "utf-8");
  assert.match(readings, /elevenlabs/);
  assert.match(readings, /実読みは取得できない/);
  assert.match(readings, /\*\*L02\*\* 逃げる方法はありません。/);

  // 2回目は行キャッシュで API を呼ばない
  const calls2 = mockFetch(() => new Response("", { status: 500 }));
  await runTts("episodes/ep900-el", root);
  assert.equal(calls2.length, 0);
});

test("elevenlabs: --readings-only は API を呼ばず表記ベースの readings.md を出す", async () => {
  const root = setupProject(VOICE, false);
  const calls = mockFetch(() => new Response("", { status: 500 }));
  await runReadingsOnly("episodes/ep900-el", root);
  assert.equal(calls.length, 0);
  const readings = readFileSync(
    path.join(root, "episodes", "ep900-el", "narration", "readings.md"),
    "utf-8"
  );
  assert.match(readings, /実読みは取得できない/);
  assert.match(readings, /\*\*L01\*\* これはね、さんさいです。/);
});
