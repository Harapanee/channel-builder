import assert from "node:assert/strict";
import test from "node:test";
import { isoDurationSec, rankNextVideos, withNextVideos } from "./next-videos";
import type { Snapshot } from "./next-videos";

const snap: Snapshot = {
  fetchedAt: "2026-09-03T00:00:00Z",
  videos: {
    self: { title: "自分", publishedAt: "2026-08-01T00:00:00Z", privacy: "public", duration: "PT10M", summary: { averageViewPercentage: 99, views: 1 } },
    fresh: { title: "公開直後", publishedAt: "2026-09-01T00:00:00Z", privacy: "public", duration: "PT10M", summary: { averageViewPercentage: 90, views: 1 } },
    priv: { title: "非公開", publishedAt: "2026-08-01T00:00:00Z", privacy: "private", summary: { averageViewPercentage: 80, views: 1 } },
    cheetah: { title: "チーター", publishedAt: "2026-08-01T00:00:00Z", privacy: "public", duration: "PT15M2S", summary: { averageViewPercentage: 63.9, views: 6000 } },
    octopus: { title: "タコ", publishedAt: "2026-08-02T00:00:00Z", privacy: "public", duration: "PT12M", summary: { averageViewPercentage: 59.9, views: 13000 } },
    bear: { title: "ホッキョクグマ", publishedAt: "2026-08-03T00:00:00Z", privacy: "public", duration: "PT1H0M3S", summary: { averageViewPercentage: 40, views: 90000 } },
    short: { title: "ショート", publishedAt: "2026-08-01T00:00:00Z", privacy: "public", duration: "PT45S", summary: { averageViewPercentage: 120, views: 100 } },
  },
};

test("自分・公開直後・非公開を除き、平均視聴率の降順で2本", () => {
  const picks = rankNextVideos(snap, "self", new Map([["cheetah", "ep0xx-cheetah"]]));
  assert.deepEqual(picks.map((p) => p.videoId), ["cheetah", "octopus"]);
  assert.equal(picks[0].epId, "ep0xx-cheetah");
  assert.equal(picks[0].url, "https://youtu.be/cheetah");
});

test("概要欄の末尾に「▶ 次に見る」を足し、既にあれば置き換える", () => {
  const picks = rankNextVideos(snap, "self", new Map());
  const d1 = withNextVideos("本文。\n", picks);
  assert.ok(d1.includes("▶ 次に見る\nチーター\nhttps://youtu.be/cheetah\nタコ"));
  const d2 = withNextVideos(d1, picks.slice(0, 1));
  assert.equal((d2.match(/▶ 次に見る/g) ?? []).length, 1);
  assert.ok(!d2.includes("タコ"));
  assert.ok(d2.startsWith("本文。\n\n▶ 次に見る"));
});

test("ISO 8601 の尺を秒にする", () => {
  assert.equal(isoDurationSec("PT15M2S"), 902);
  assert.equal(isoDurationSec("PT1H0M3S"), 3603);
  assert.equal(isoDurationSec(undefined), 0);
});
