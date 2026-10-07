import fs from 'node:fs';
import path from 'node:path';

/**
 * 毎日投稿の公開枠(JST の毎日 hourJst 時)から、空いている最も早い枠を選ぶ。
 * - occupied: 公開済みの publishedAt と予約中の publishAt(ISO)。JST の日付が同じならその日は埋まっている
 * - 現在時刻 + minLeadHours より前の枠は選ばない(処理・Studio 仕上げの猶予)
 * 途中に空いた日があればそこを先に埋める(連続性を優先)。
 */
const JST_MS = 9 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** JST の日付キー(YYYY-MM-DD) */
function jstDay(t: number): string {
  return new Date(t + JST_MS).toISOString().slice(0, 10);
}

export function nextFreeSlot(
  occupied: string[],
  now: Date,
  opts: { hourJst: number; minLeadHours: number },
): Date {
  const taken = new Set(occupied.map((s) => jstDay(Date.parse(s))));
  const earliest = now.getTime() + opts.minLeadHours * 3_600_000;
  // 今日(JST)の枠から1日ずつ進める
  const todayStartJst = Date.parse(`${jstDay(now.getTime())}T00:00:00+09:00`);
  for (let i = 0; i < 366; i++) {
    const slot = todayStartJst + i * DAY_MS + opts.hourJst * 3_600_000;
    if (slot < earliest) continue;
    if (!taken.has(jstDay(slot))) return new Date(slot);
  }
  throw new Error('invalid: 1年先まで空き枠がありません');
}

/** JST の ISO 表記(例 2026-10-09T18:00:00+09:00) */
export function toJstIso(d: Date): string {
  return new Date(d.getTime() + JST_MS).toISOString().slice(0, 19) + '+09:00';
}

/**
 * metadata.json(生 JSON)へ公開枠を書く。privacyStatus は private にそろえる。
 * memberEarlyAccess.hours が「今から枠まで」に収まらない回は、メンバー先行と概要欄の案内行
 * (「メンバーシップに加入すると」で始まる行)を外す。先行時間が嘘になるため。
 */
export function applySlot(
  raw: Record<string, unknown>,
  slot: Date,
  now: Date,
): { meta: Record<string, unknown>; notes: string[] } {
  const meta: Record<string, unknown> = { ...raw, privacyStatus: 'private', publishAt: toJstIso(slot) };
  const notes: string[] = [];
  const mea = raw.memberEarlyAccess as { hours?: number } | undefined;
  const leadH = (slot.getTime() - now.getTime()) / 3_600_000;
  if (mea && typeof mea.hours === 'number' && leadH < mea.hours) {
    delete meta.memberEarlyAccess;
    if (typeof meta.description === 'string') {
      meta.description = meta.description.replace(/メンバーシップに加入すると[^\n]*\n(\n)?/, '');
    }
    notes.push(`メンバー先行(${mea.hours}時間)は公開まで${leadH.toFixed(1)}時間で成立しないため外した(概要欄の案内行も削除)`);
  }
  return { meta, notes };
}

/**
 * このチャンネルが自分で予約した枠(episodes/*\/publish に upload-result.json がある回の metadata.publishAt)。
 * API の返し方(メンバー先行中の publishAt の有無・直近50件の窓)に左右されない保険として occupied に足す。
 */
export function localPublishTimes(channelDir: string): string[] {
  const root = path.join(channelDir, 'episodes');
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    const pub = path.join(root, name, 'publish');
    if (!fs.existsSync(path.join(pub, 'upload-result.json'))) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(pub, 'metadata.json'), 'utf8')) as { publishAt?: unknown };
      if (typeof meta.publishAt === 'string' && !Number.isNaN(Date.parse(meta.publishAt))) out.push(meta.publishAt);
    } catch {
      /* metadata が無い・壊れている回は枠の判定に使わない */
    }
  }
  return out;
}
