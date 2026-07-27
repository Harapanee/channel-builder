/**
 * location.hash とナビ状態(activeDir/activeTab/activeItem)の相互変換を担う純関数群。
 * App.tsx から移設(window依存を除去し、hashを引数で受けるように変更)。
 */

/** hash → ナビ状態。不正・未知のhashはダッシュボード扱い */
export function parseHash(hash: string): { dir: string | null; tab: string | null; item: string | null } {
  if (hash === '#/root') return { dir: '', tab: null, item: null };
  const rj = /^#\/root\/jobs(?:\/([^/]+))?$/.exec(hash);
  if (rj) return { dir: '', tab: 'jobs', item: rj[1] ? decodeURIComponent(rj[1]) : null };
  const m = /^#\/ch\/([^/]+)(?:\/([a-z]+))?(?:\/([^/]+))?$/.exec(hash);
  if (m) {
    return {
      dir: decodeURIComponent(m[1]!),
      tab: m[2] ?? null,
      item: m[3] ? decodeURIComponent(m[3]) : null,
    };
  }
  return { dir: null, tab: null, item: null };
}

export function hashFor(dir: string | null, tab: string | null, item: string | null): string {
  if (dir === null) return '#/';
  if (dir === '') {
    if (tab === 'jobs') return `#/root/jobs${item ? `/${encodeURIComponent(item)}` : ''}`;
    return '#/root';
  }
  const tabPart = tab ? `/${tab}` : '';
  // item はタブが確定しているときだけ意味を持つ(タブなしのitemはパース不能)
  const itemPart = tab && item ? `/${encodeURIComponent(item)}` : '';
  return `#/ch/${encodeURIComponent(dir)}${tabPart}${itemPart}`;
}
