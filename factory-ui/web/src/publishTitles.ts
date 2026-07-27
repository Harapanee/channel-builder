/**
 * publish/PUBLISH.md の「## タイトル案」節からタイトル本文を抽出する(最大3件)。
 * 対象は箇条書き行の太字部分。「A(謎提示型): 」のような短い先頭ラベルは除去する。
 * 節が無い・形式が違う場合は空配列(呼び出し側は非表示にするだけでエラーにしない)。
 */
export function parsePublishTitles(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*タイトル案/.test(l.trim()));
  if (start < 0) return [];
  const titles: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,3}\s/.test(line)) break; // 次の見出し(採用案節など)で打ち切る
    const m = line.match(/^[-*]\s+\*\*(.+?)\*\*/);
    if (!m) continue;
    const title = m[1].replace(/^[^::]{1,12}[::]\s*/, '').trim();
    if (title) titles.push(title);
    if (titles.length >= 3) break;
  }
  return titles;
}
