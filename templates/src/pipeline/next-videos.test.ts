import assert from "node:assert/strict";
import test from "node:test";
import { isoDurationSec, rankNextVideos, rankRule, withNextVideos } from "./next-videos";
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

const traffic = (related: number, other: number) => [
  { insightTrafficSourceType: "RELATED_VIDEO", views: related },
  { insightTrafficSourceType: "SUBSCRIBER", views: other },
];
const subsSnap: Snapshot = {
  fetchedAt: "2026-09-19T00:00:00Z",
  videos: {
    self: { title: "自分", publishedAt: "2026-08-01T00:00:00Z", privacy: "public", duration: "PT10M", summary: { averageViewPercentage: 99, views: 1000, subscribersGained: 100 } },
    // 平均視聴率は高いが登録/1k は低い(常連の視聴)
    regular: { title: "常連回", publishedAt: "2026-08-01T00:00:00Z", privacy: "public", duration: "PT15M", summary: { averageViewPercentage: 60, views: 10000, subscribersGained: 10 } },
    wide: { title: "広がった回", publishedAt: "2026-08-02T00:00:00Z", privacy: "public", duration: "PT15M", summary: { averageViewPercentage: 38, views: 100000, subscribersGained: 400 }, traffic: traffic(10, 90) },
    tie: { title: "同点・関連多め", publishedAt: "2026-08-03T00:00:00Z", privacy: "public", duration: "PT15M", summary: { averageViewPercentage: 45, views: 10000, subscribersGained: 40 }, traffic: traffic(50, 50) },
    fresh: { title: "公開直後", publishedAt: "2026-09-17T00:00:00Z", privacy: "public", duration: "PT15M", summary: { averageViewPercentage: 0, views: 0, subscribersGained: 0 } },
  },
};

test("登録/1k再生の降順・同点は関連動画流入比の降順(平均視聴率では選ばない)", () => {
  const picks = rankNextVideos(subsSnap, "self", new Map());
  assert.deepEqual(picks.map((p) => p.videoId), ["tie", "wide"]);
  assert.equal(picks[1].subsPer1k, 4);
  assert.equal(picks[0].relatedRatio, 0.5);
  assert.equal(rankRule(subsSnap, "self"), "subsPer1k");
});

test("登録数のデータが無いスナップショットは従来の平均視聴率基準にフォールバック", () => {
  assert.equal(rankRule(snap, "self"), "averageViewPercentage");
});

test("登録数のある回を先に並べ、無い回は後ろ(平均視聴率順)", () => {
  const mixed: Snapshot = {
    fetchedAt: subsSnap.fetchedAt,
    videos: {
      noSubs: { title: "登録数なし", publishedAt: "2026-08-01T00:00:00Z", privacy: "public", duration: "PT15M", summary: { averageViewPercentage: 90, views: 10000 } },
      wide: subsSnap.videos.wide,
    },
  };
  assert.deepEqual(rankNextVideos(mixed, undefined, new Map()).map((p) => p.videoId), ["wide", "noSubs"]);
});

test("公開後60日を超える回は、60日以内に候補が足りていれば選ばない(小さかった頃の回は登録/1k が高く出る)", () => {
  const withOld: Snapshot = {
    fetchedAt: subsSnap.fetchedAt,
    videos: {
      ...subsSnap.videos,
      old: { title: "7月の回", publishedAt: "2026-07-01T00:00:00Z", privacy: "public", duration: "PT15M", summary: { averageViewPercentage: 40, views: 10000, subscribersGained: 90 } },
    },
  };
  assert.deepEqual(rankNextVideos(withOld, "self", new Map()).map((p) => p.videoId), ["tie", "wide"]);
  // 60日以内の候補が limit に満たなければ全期間から補う
  const onlyOld: Snapshot = { fetchedAt: subsSnap.fetchedAt, videos: { old: withOld.videos.old, wide: subsSnap.videos.wide } };
  assert.deepEqual(rankNextVideos(onlyOld, undefined, new Map()).map((p) => p.videoId), ["old", "wide"]);
});
