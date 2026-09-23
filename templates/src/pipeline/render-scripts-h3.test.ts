/**
 * H3 経路の回(.channel-system.json の h3Pipeline.episodes)を夜間レンダーから締め出す。
 * H3 回は assemble の out/final.mp4 が最終物で、render-episode.sh に入ると composition.html 由来の
 * 古い実装で上書きされる(2026-09-23 に ep017-cuckoo がキューに残っていた)。
 *
 * scripts/*.sh は `cd "$(dirname "$0")/.."` でリポジトリ直下に移るので、スクリプトを一時ディレクトリの
 * scripts/ へ複写し、そこを疑似チャンネルとして走らせる。npx / npm は即失敗する偽物で差し替え、
 * 非H3 の回が「H3 ガードを通過して次の検査で止まる」ことまでを確かめる(実レンダーは走らない)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");

function makeChannel(system: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h3-guard-"));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const f of ["render-episode.sh", "render-queue.sh"]) {
    fs.copyFileSync(path.join(REPO, "scripts", f), path.join(root, "scripts", f));
  }
  if (system !== undefined) {
    fs.writeFileSync(
      path.join(root, ".channel-system.json"),
      typeof system === "string" ? system : JSON.stringify(system),
    );
  }
  for (const ep of ["ep017-cuckoo", "ep008-old"]) {
    const d = path.join(root, "episodes", ep);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "timing.json"), "{}");
    fs.writeFileSync(path.join(d, "composition.html"), "<html></html>");
  }
  // 偽の npx / npm / caffeinate: 呼ばれたら即失敗(実レンダー・検査を走らせない)
  const bin = path.join(root, "fakebin");
  fs.mkdirSync(bin);
  for (const b of ["npx", "npm", "caffeinate"]) {
    fs.writeFileSync(path.join(bin, b), "#!/bin/sh\necho fake-$0 >&2\nexit 1\n", { mode: 0o755 });
  }
  return root;
}

function run(root: string, script: string, args: string[]) {
  return spawnSync("bash", [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "fakebin")}:${process.env.PATH}`,
      HYPERFRAMES_FFMPEG_PATH: "/nonexistent/ffmpeg", // ffmpeg 探索を飛ばす
    },
  });
}

const H3_SYSTEM = { channelId: "x", h3Pipeline: { enabled: true, episodes: ["ep017-cuckoo"] } };

test("render-episode.sh: H3 回は冒頭で exit 3、理由を表示し、ステータスマーカーに h3_pipeline_episode を書く", () => {
  const root = makeChannel(H3_SYSTEM);
  const r = run(root, "render-episode.sh", ["episodes/ep017-cuckoo", "final"]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /H3/);
  assert.match(r.stderr, /final\.mp4/);
  // 何も上書きしていない(composition.html を index.html へ複写する前に止まる)
  assert.equal(fs.existsSync(path.join(root, "index.html")), false);
  const st = JSON.parse(
    fs.readFileSync(path.join(root, "episodes/ep017-cuckoo/out/.render-status-final.json"), "utf8"),
  );
  assert.equal(st.ok, false);
  assert.equal(st.reason, "h3_pipeline_episode");
});

test("render-episode.sh: 非H3 の回はガードを通過する(偽 npx で音声検査に落ちる=exit 1)", () => {
  const root = makeChannel(H3_SYSTEM);
  const r = run(root, "render-episode.sh", ["episodes/ep008-old", "final"]);
  assert.equal(r.status, 1, r.stderr);
  const st = JSON.parse(
    fs.readFileSync(path.join(root, "episodes/ep008-old/out/.render-status-final.json"), "utf8"),
  );
  assert.equal(st.reason, "audio_check_failed");
});

test("render-episode.sh: h3Pipeline の無い/壊れた .channel-system.json は非H3 扱い(既存チャンネルを壊さない)", () => {
  for (const sys of [{ channelId: "plain" }, "{broken json", { h3Pipeline: { episodes: "ep017-cuckoo" } }]) {
    const root = makeChannel(sys);
    const r = run(root, "render-episode.sh", ["episodes/ep017-cuckoo", "final"]);
    assert.notEqual(r.status, 3, `system=${JSON.stringify(sys)} stderr=${r.stderr}`);
  }
});

test("render-queue.sh add: H3 回は拒否(exit 3)してジョブを積まない。非H3 は従来どおり積む", () => {
  const root = makeChannel(H3_SYSTEM);
  const r = run(root, "render-queue.sh", ["add", "episodes/ep017-cuckoo"]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /H3/);
  const jobs = () => fs.readdirSync(path.join(root, "render-queue")).filter((f) => f.startsWith("job-"));
  assert.deepEqual(jobs(), []);

  const ok = run(root, "render-queue.sh", ["add", "episodes/ep008-old"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(jobs().length, 1);
});

test("render-queue.sh add: h3Pipeline の無いチャンネルは同じ epId でも積める", () => {
  const root = makeChannel({ channelId: "plain" });
  const r = run(root, "render-queue.sh", ["add", "episodes/ep017-cuckoo"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
