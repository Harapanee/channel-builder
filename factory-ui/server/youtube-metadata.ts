import type { YoutubeMetadata } from '../shared/types';

const PRIVACY = new Set(['private', 'unlisted', 'public']);
const TITLE_MAX = 100;      // YouTube仕様
const DESC_MAX = 5000;      // YouTube仕様

/**
 * publish/metadata.json の生JSONを検証して YoutubeMetadata を返す。
 * 不正は `invalid: <理由>` を throw(ルート層で400に写す)。
 * privacyStatus 省略時は事故防止のため private。
 */
export function validateMetadata(raw: unknown): YoutubeMetadata {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('invalid: metadata.json はオブジェクトである必要があります');
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.title !== 'string' || o.title.trim() === '' || o.title.length > TITLE_MAX) {
    throw new Error(`invalid: title は1〜${TITLE_MAX}文字の文字列が必要です`);
  }
  if (typeof o.description !== 'string' || o.description.length > DESC_MAX) {
    throw new Error(`invalid: description は${DESC_MAX}文字以内の文字列が必要です`);
  }
  if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== 'string')) {
    throw new Error('invalid: tags は文字列配列が必要です');
  }
  if (typeof o.categoryId !== 'string' || !/^\d+$/.test(o.categoryId)) {
    throw new Error('invalid: categoryId は数字文字列が必要です(例 "24")');
  }
  const privacy = o.privacyStatus ?? 'private';
  if (typeof privacy !== 'string' || !PRIVACY.has(privacy)) {
    throw new Error("invalid: privacyStatus は 'private' | 'unlisted' | 'public' のいずれかです");
  }
  let thumbnail: string | undefined;
  if (o.thumbnail !== undefined) {
    if (typeof o.thumbnail !== 'string' || !isSafeRel(o.thumbnail)) {
      throw new Error('invalid: thumbnail はエピソード内相対パスが必要です(例 "publish/thumbnail.png")');
    }
    thumbnail = o.thumbnail;
  }
  return {
    title: o.title,
    description: o.description,
    tags: o.tags as string[],
    categoryId: o.categoryId,
    privacyStatus: privacy as YoutubeMetadata['privacyStatus'],
    ...(thumbnail !== undefined ? { thumbnail } : {}),
  };
}

/** エピソードフォルダ内に収まる相対パスか(絶対・`..`・バックスラッシュ拒否) */
export function isSafeRel(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '..' && seg !== '.');
}
