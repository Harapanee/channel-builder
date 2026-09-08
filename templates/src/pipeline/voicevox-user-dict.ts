/**
 * VOICEVOX ユーザー辞書の同期。
 *
 * `channel/user-dict.json` に置いた語(表記→読み)を、tts.ts の起動時に VOICEVOX の
 * ユーザー辞書(/user_dict_word)へ登録・更新する。以後の全エピソードでその表記が
 * 正しく読まれ、「ひらがなに開いて `- display:` で字幕を維持する」手当てが要らなくなる。
 *
 * 【対象】名詞が確実(五大湖・大顎・幼生 など)。**動詞の活用形(吸い付く→スイツケ)は
 * ユーザー辞書では固定できない**ので、従来どおり台本表記で直す。
 *
 * 【注意】ユーザー辞書は VOICEVOX エンジン側(このマシン)に永続する。同じエンジンを
 * 複数チャンネルが使うなら全チャンネルに効く。削除は行わない(json から消しても
 * エンジン側には残る。消したいときは VOICEVOX の UI か DELETE /user_dict_word/{uuid})。
 *
 * 契約(channel/user-dict.json):
 *   { "words": [ { "surface": "五大湖", "pronunciation": "ゴダイコ", "accentType": 3,
 *                  "wordType"?: "PROPER_NOUN|COMMON_NOUN|VERB|ADJECTIVE|SUFFIX",
 *                  "priority"?: 0-10, "why"?: "観測した誤読と回" } ] }
 *   accentType はアクセント核のモーラ位置(0=平板)。迷ったら 0。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WordType = "PROPER_NOUN" | "COMMON_NOUN" | "VERB" | "ADJECTIVE" | "SUFFIX";

export type UserDictWord = {
  surface: string;
  pronunciation: string;
  accentType: number;
  wordType: WordType;
  priority: number;
  why?: string;
};

const WORD_TYPES: WordType[] = ["PROPER_NOUN", "COMMON_NOUN", "VERB", "ADJECTIVE", "SUFFIX"];

/** channel/user-dict.json を読んで検証する。無ければ空配列。 */
export function loadUserDict(projectRoot: string): UserDictWord[] {
  const p = join(projectRoot, "channel", "user-dict.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf-8")) as { words?: unknown };
  if (!Array.isArray(raw.words)) throw new Error(`${p}: "words" 配列がありません`);
  return raw.words.map((w, i) => {
    const o = w as Record<string, unknown>;
    const where = `${p} words[${i}]`;
    if (typeof o.surface !== "string" || o.surface === "")
      throw new Error(`${where}: surface が空`);
    if (typeof o.pronunciation !== "string" || !/^[ァ-ヴー]+$/.test(o.pronunciation))
      throw new Error(`${where}: pronunciation はカタカナのみ(${String(o.pronunciation)})`);
    if (typeof o.accentType !== "number" || o.accentType < 0)
      throw new Error(`${where}: accentType は 0 以上の整数`);
    const wordType = (o.wordType ?? "PROPER_NOUN") as WordType;
    if (!WORD_TYPES.includes(wordType)) throw new Error(`${where}: wordType が不正(${wordType})`);
    const priority = typeof o.priority === "number" ? o.priority : 5;
    return {
      surface: o.surface,
      pronunciation: o.pronunciation,
      accentType: o.accentType,
      wordType,
      priority,
      why: typeof o.why === "string" ? o.why : undefined,
    };
  });
}

/** 辞書内容のハッシュ(行キャッシュのキーに混ぜ、辞書が変わった行を再合成させる)。 */
export function userDictHash(words: UserDictWord[]): string {
  const canon = words.map((w) => [w.surface, w.pronunciation, w.accentType, w.wordType, w.priority]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type EngineWord = { surface: string; pronunciation: string; accent_type: number; priority?: number };

/** エンジンの辞書と突合し、未登録は POST・読み/アクセント違いは PUT する。 */
export async function syncUserDict(
  words: UserDictWord[],
  baseUrl: string,
  fetchLike: FetchLike = (u, i) => fetch(u, i)
): Promise<{ added: number; updated: number; unchanged: number }> {
  const result = { added: 0, updated: 0, unchanged: 0 };
  if (words.length === 0) return result;
  const res = await fetchLike(`${baseUrl}/user_dict`);
  if (!res.ok) throw new Error(`VOICEVOX /user_dict が失敗: HTTP ${res.status}`);
  const engine = (await res.json()) as Record<string, EngineWord>;
  const bySurface = new Map<string, { uuid: string; w: EngineWord }>();
  for (const [uuid, w] of Object.entries(engine)) bySurface.set(w.surface, { uuid, w });

  for (const w of words) {
    const qs = new URLSearchParams({
      surface: w.surface,
      pronunciation: w.pronunciation,
      accent_type: String(w.accentType),
      word_type: w.wordType,
      priority: String(w.priority),
    });
    const cur = bySurface.get(w.surface);
    if (!cur) {
      const r = await fetchLike(`${baseUrl}/user_dict_word?${qs}`, { method: "POST" });
      if (!r.ok) throw new Error(`VOICEVOX 辞書登録に失敗(${w.surface}): HTTP ${r.status} ${await r.text()}`);
      result.added += 1;
    } else if (
      cur.w.pronunciation !== w.pronunciation ||
      cur.w.accent_type !== w.accentType ||
      (cur.w.priority !== undefined && cur.w.priority !== w.priority)
    ) {
      const r = await fetchLike(`${baseUrl}/user_dict_word/${cur.uuid}?${qs}`, { method: "PUT" });
      if (!r.ok) throw new Error(`VOICEVOX 辞書更新に失敗(${w.surface}): HTTP ${r.status} ${await r.text()}`);
      result.updated += 1;
    } else result.unchanged += 1;
  }
  return result;
}
