import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadUserDict,
  syncUserDict,
  userDictHash,
  type FetchLike,
} from "./voicevox-user-dict";

function tmpRoot(json: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "ud-"));
  mkdirSync(join(root, "channel"));
  if (json !== null) writeFileSync(join(root, "channel", "user-dict.json"), json);
  return root;
}

test("loadUserDict: 無ければ空、あれば検証して返す", () => {
  assert.deepEqual(loadUserDict(tmpRoot(null)), []);
  const root = tmpRoot(
    JSON.stringify({
      words: [
        { surface: "五大湖", pronunciation: "ゴダイコ", accentType: 3, why: "ep031" },
      ],
    })
  );
  const w = loadUserDict(root);
  assert.equal(w.length, 1);
  assert.equal(w[0].wordType, "PROPER_NOUN");
  assert.equal(w[0].priority, 5);
});

test("loadUserDict: 読みがカタカナ以外なら弾く", () => {
  const root = tmpRoot(
    JSON.stringify({ words: [{ surface: "x", pronunciation: "ごだいこ", accentType: 0 }] })
  );
  assert.throws(() => loadUserDict(root), /カタカナ/);
});

test("userDictHash: 内容で決まり、空は固定値", () => {
  assert.equal(userDictHash([]), userDictHash([]));
  const a = userDictHash([{ surface: "a", pronunciation: "ア", accentType: 0, wordType: "COMMON_NOUN", priority: 5 }]);
  const b = userDictHash([{ surface: "a", pronunciation: "アア", accentType: 0, wordType: "COMMON_NOUN", priority: 5 }]);
  assert.notEqual(a, b);
});

test("syncUserDict: 未登録は POST、読み違いは PUT、一致はスキップ", async () => {
  const calls: { method: string; url: string }[] = [];
  const engine: Record<string, { surface: string; pronunciation: string; accent_type: number }> = {
    u1: { surface: "五大湖", pronunciation: "ゴダイコ", accent_type: 3 },
    u2: { surface: "水槽", pronunciation: "ミズソウ", accent_type: 0 },
  };
  const fetchLike: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url) });
    if (method === "GET") return new Response(JSON.stringify(engine), { status: 200 });
    if (method === "POST") return new Response(JSON.stringify("u3"), { status: 200 });
    return new Response("null", { status: 200 });
  };
  const r = await syncUserDict(
    [
      { surface: "五大湖", pronunciation: "ゴダイコ", accentType: 3, wordType: "PROPER_NOUN", priority: 5 },
      { surface: "水槽", pronunciation: "スイソウ", accentType: 0, wordType: "COMMON_NOUN", priority: 5 },
      { surface: "大顎", pronunciation: "オオアゴ", accentType: 0, wordType: "COMMON_NOUN", priority: 5 },
    ],
    "http://vv",
    fetchLike
  );
  assert.deepEqual(r, { added: 1, updated: 1, unchanged: 1 });
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put && put.url.includes("/user_dict_word/u2") && put.url.includes("pronunciation=%E3%82%B9"));
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post && post.url.includes("surface=%E5%A4%A7%E9%A1%8E"));
});
