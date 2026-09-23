import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isH3Episode,
  finalStatusFor,
  commitPaths,
  countGeneratedImages,
  applyMetrics,
} from "./finalize-episode";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "finalize-"));

test("isH3Episode: h3Pipeline.episodes に載る回だけ true。キー無し・形の崩れは false", () => {
  const sys = { h3Pipeline: { enabled: true, episodes: ["ep045-giant-panda"] } };
  assert.equal(isH3Episode(sys, "ep045-giant-panda"), true);
  assert.equal(isH3Episode(sys, "ep008-old"), false);
  assert.equal(isH3Episode({}, "ep045-giant-panda"), false);
  assert.equal(isH3Episode({ h3Pipeline: { episodes: "ep045-giant-panda" } }, "ep045-giant-panda"), false);
  assert.equal(isH3Episode(null, "ep045-giant-panda"), false);
});

test("finalStatusFor: H3 回は final(assemble の完了が最終物)、それ以外は render_ready(夜間レンダー待ち)", () => {
  assert.equal(finalStatusFor(true), "final");
  assert.equal(finalStatusFor(false), "render_ready");
});

test("commitPaths: H3 回は h3/episodes/<ep>・h3/vocab/<ep>.ts を含め、upload-result.json は在れば含める", () => {
  const root = tmp();
  const epId = "ep045-giant-panda";
  const epDir = path.join("episodes", epId);
  fs.mkdirSync(path.join(root, epDir, "publish"), { recursive: true });
  fs.mkdirSync(path.join(root, "h3/episodes", epId), { recursive: true });
  fs.mkdirSync(path.join(root, "h3/vocab"), { recursive: true });
  fs.writeFileSync(path.join(root, "h3/vocab", `${epId}.ts`), "");
  fs.writeFileSync(path.join(root, epDir, "publish/upload-result.json"), "{}");
  const exists = (p: string) => fs.existsSync(path.join(root, p));

  const h3 = commitPaths({ epId, epDir, isH3: true, backlogChanged: false, exists });
  assert.ok(h3.includes(`h3/episodes/${epId}`));
  assert.ok(h3.includes(`h3/vocab/${epId}.ts`));
  assert.ok(h3.includes(`${epDir}/publish/upload-result.json`));
  assert.ok(h3.includes(epDir));
  assert.ok(h3.includes(".channel-system.json"));
  assert.ok(h3.includes(`${epDir}/episode.json`));

  // 非H3 回は h3/ を含めない。無いファイルは渡さない(git add が pathspec エラーで落ちる)
  const hf = commitPaths({ epId: "ep008-old", epDir: "episodes/ep008-old", isH3: false, backlogChanged: false, exists });
  assert.ok(!hf.some((p) => p.startsWith("h3/")));
  assert.ok(!hf.includes("episodes/ep008-old/publish/upload-result.json"));

  // H3 回でも実在しない h3 側のパスは渡さない
  const missing = commitPaths({ epId: "ep099-x", epDir: "episodes/ep099-x", isH3: true, backlogChanged: true, exists });
  assert.ok(!missing.some((p) => p.startsWith("h3/")));
  assert.ok(missing.includes("channel/backlog.md"));
});

test("countGeneratedImages: サムネ1枚絵+keyframe 終点画像+epId 紐付きの生成素材を実数で数える", () => {
  const root = tmp();
  const epDir = path.join(root, "episodes/ep045-giant-panda");
  fs.mkdirSync(path.join(epDir, "publish"), { recursive: true });
  for (const f of ["thumb-oneshot-1.png", "thumb-oneshot-2.png", "thumb-oneshot-3.png", "thumb-oneshot-contact.jpg", "thumb-1.png", "thumb-mobile-preview.png"]) {
    fs.writeFileSync(path.join(epDir, "publish", f), "");
  }
  const framesDir = path.join(root, "ff");
  fs.mkdirSync(framesDir);
  for (const f of ["cL10-end.png", "cL22-end.png", "cL10-last.png", "cL22-end-raw.png"]) {
    fs.writeFileSync(path.join(framesDir, f), "");
  }
  const library = [
    { file: "assets/characters/ep045-giant-panda/mother.png", approvedBy: "human" },
    { file: "assets/net/ep045-giant-panda/photo.jpg", approvedBy: "net-source" },
    { file: "assets/characters/other/x.png", approvedBy: "human" },
  ];
  // サムネ3 + 終点2(-last / -raw は数えない)+ 素材1(net-source は生成ではない)
  assert.equal(countGeneratedImages({ epDir, epId: "ep045-giant-panda", framesDir, library }), 6);
});

test("countGeneratedImages: 何も数えられなければ null(記録しない。固定値で埋めない)", () => {
  const root = tmp();
  assert.equal(
    countGeneratedImages({ epDir: path.join(root, "episodes/ep1"), epId: "ep1", framesDir: path.join(root, "nope"), library: [] }),
    null,
  );
});

test("applyMetrics: images が null なら imageGenCount を書かない(既存値は保持)", () => {
  const fresh: { metrics?: Array<Record<string, unknown>> } = {};
  applyMetrics(fresh, "ep1", { hours: 2, images: null, costUsd: 10, agentTurns: 5 });
  assert.equal("imageGenCount" in fresh.metrics![0]!, false);
  assert.equal(fresh.metrics![0]!.costUsd, 10);

  const existing = { metrics: [{ episodeId: "ep1", imageGenCount: 7, renderMinutes: 3 }] as Array<Record<string, unknown>> };
  applyMetrics(existing, "ep1", { hours: 1, images: null, costUsd: null, agentTurns: null });
  assert.equal(existing.metrics[0]!.imageGenCount, 7);
  assert.equal(existing.metrics[0]!.renderMinutes, 3);

  applyMetrics(existing, "ep1", { hours: 1, images: 12, costUsd: null, agentTurns: null });
  assert.equal(existing.metrics[0]!.imageGenCount, 12);
});

test("applyMetrics: 旧キー epId の行は episodeId へ寄せ、重複行を作らない", () => {
  const sys = { metrics: [{ epId: "ep1", wallClockHours: 1 }] as Array<Record<string, unknown>> };
  applyMetrics(sys, "ep1", { hours: 2, images: 3, costUsd: null, agentTurns: null });
  assert.equal(sys.metrics.length, 1);
  assert.equal(sys.metrics[0]!.episodeId, "ep1");
  assert.equal("epId" in sys.metrics[0]!, false);
  assert.equal(sys.metrics[0]!.wallClockHours, 2);
});
