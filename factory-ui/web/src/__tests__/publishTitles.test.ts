import { describe, expect, it } from 'vitest';
import { parsePublishTitles } from '../publishTitles';

const sample = `# 公開パッケージ — ep001

題材: 座敷童子

---

## タイトル案

bible §13 は3案方式。各28文字以内。

- **A(謎提示型): 座敷童子が去った家で、何が起きたのか**(18文字)
- **B(意外な正体型): 座敷童子を記録した男が疑った、その正体**(20文字)
- **C(署名型): 【禁書一冊目】座敷童子 — 遠野の旧家の記録**(23文字)

### 採用案と選定理由

**採用: A「座敷童子が去った家で、何が起きたのか」**

## 概要欄
`;

describe('parsePublishTitles', () => {
  it('タイトル案節の太字3件をラベル除去して抽出する', () => {
    expect(parsePublishTitles(sample)).toEqual([
      '座敷童子が去った家で、何が起きたのか',
      '座敷童子を記録した男が疑った、その正体',
      '【禁書一冊目】座敷童子 — 遠野の旧家の記録',
    ]);
  });

  it('次の見出し以降(採用案の太字)は拾わない', () => {
    const titles = parsePublishTitles(sample);
    expect(titles.some((t) => t.includes('採用'))).toBe(false);
  });

  it('タイトル案節が無ければ空配列', () => {
    expect(parsePublishTitles('# なにもない\n\n- **太字だけ**')).toEqual([]);
  });

  it('ラベル無しの太字はそのまま採用し、4件以上は3件で打ち切る', () => {
    const md = '## タイトル案\n- **一つ目**\n- **二つ目**\n- **三つ目**\n- **四つ目**\n';
    expect(parsePublishTitles(md)).toEqual(['一つ目', '二つ目', '三つ目']);
  });

  it('全角コロンのラベルも除去する', () => {
    const md = '## タイトル案\n- **A(謎): タイトル本文**\n';
    expect(parsePublishTitles(md)).toEqual(['タイトル本文']);
  });
});
