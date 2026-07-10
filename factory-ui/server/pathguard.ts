import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * root 配下の「実体」絶対パスを返すパストラバーサルガード。
 * 全ファイル系APIはこの関数を通してからディスクに触れること。
 *
 * 次のいずれかに該当する場合は null を返す:
 *  - `..` による root 外への脱出
 *  - シンボリックリンク経由での root 外への脱出(realpath で検証)
 *  - `.env*` ファイル
 *  - `.git` / `node_modules` 配下
 *  - 存在しないパス
 *
 * @param root ファクトリールート(絶対パス)
 * @param rel  root からの相対パス
 * @returns 検証済みの実体絶対パス、または null
 */
export async function safeResolve(root: string, rel: string): Promise<string | null> {
  // root 自体のシンボリックリンクを正規化しておく(以降の prefix 比較を安定させる)。
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return null;
  }

  // まず字句上(シンボリックリンク解決なし)で解決し、`..` 脱出と禁止セグメントを弾く。
  const lexicalTarget = path.resolve(realRoot, rel);
  const lexicalRel = path.relative(realRoot, lexicalTarget);

  // path.relative の結果が `..` から始まる/絶対パスになる = root 外への脱出。
  if (lexicalRel === '..' || lexicalRel.startsWith('..' + path.sep) || path.isAbsolute(lexicalRel)) {
    return null;
  }

  if (hasForbiddenSegment(lexicalRel)) {
    return null;
  }

  // realpath でシンボリックリンクを解決し、実体の存在と最終的な封じ込めを検証する。
  let realTarget: string;
  try {
    realTarget = await fs.realpath(lexicalTarget);
  } catch {
    // 存在しない(ENOENT 等)→ null
    return null;
  }

  // realpath 後にも封じ込めを再確認(シンボリックリンク経由の脱出をここで弾く)。
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return null;
  }

  // シンボリックリンク解決で禁止領域に着地したケースも弾く。
  const realRel = path.relative(realRoot, realTarget);
  if (hasForbiddenSegment(realRel)) {
    return null;
  }

  return realTarget;
}

/**
 * root からの相対パス各セグメントに禁止対象が含まれるか判定する。
 *  - `.git` / `node_modules` はディレクトリ配下すべてを禁止
 *  - `.env*` はファイル名(basename)で禁止
 * 比較は小文字化して行う(case-insensitive FS 上の case 変種対策。
 * realpath の case 正規化への単一依存を避ける)。
 */
function hasForbiddenSegment(rel: string): boolean {
  if (rel === '') return false;
  const segments = rel.split(path.sep);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === '.git' || lower === 'node_modules') return true;
  }
  const basename = segments[segments.length - 1].toLowerCase();
  if (basename.startsWith('.env')) return true;
  return false;
}
