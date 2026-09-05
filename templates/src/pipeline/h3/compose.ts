/**
 * 宣言 → MiniMax H3 の公式プロンプト全文。
 * 形式は ~/.claude/skills/h3-prompt-writing/references/base-en.txt の
 * 「Final Prompt Structure」に厳密に従う。ここを唯一の合成経路にすることで、
 * 形式違反が構造的に起きないようにしている(negative prompt が無いモデルなので、
 * 禁止は本文の「閉じの一文」で表現するしかない)。
 */
import type { ShotDecl, Vocab } from "./types";

/** I2VA の指示行。可変部は無く、時刻は 0.00 固定(公式仕様) */
export const I2V_LINE =
  "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";

const COUNT_WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * 寄りのカットの判定。寄るほど画風から外れるため、ここで画風保持文を足す。
 *
 * **2026-08-27 に語を広げた。** それまでは `close shot` / `very close shot` の2語だけを見ており、
 * `close-up` / `tight shot` / `macro view` / `close overhead shot` では画風保持文が付かなかった。
 * これは実装都合の縛りであって演出上の理由が無く、書き手の教義にも「この2語で書け」という
 * 不自然な指示を強いていた。
 *
 * ただし `close` は名詞句の頭以外でも頻出する。**寄りの語が名詞句の頭にある形**(文頭・句点の直後・
 * 冠詞の直後。`very` だけは間に挟める)に限ることで誤爆を避ける。2026-08-27 の敵対レビューが
 * 見つけた誤検知は、すべて `close` が動詞・形容詞として使われていて名詞句の頭ではなかった:
 *   - "Her eyes close as the shot fades to grey."(動詞)
 *   - "She pulls the calf close before the shot ends."(形容詞)
 *   - "The gap begins to close in this view of the bank."(動詞)
 * `close-up` / `closeup` は単独で寄りを意味するので別の枝で受ける。
 */
const NEAR = new RegExp(
  "(?:^|[.;:]\\s+|\\b(?:a|an|the)\\s+)(?:very\\s+)?(?:close|tight|macro)\\b(?:\\s+[\\w-]+){0,2}\\s+(?:shot|view)\\b"
    + "|(?:^|\\b(?:a|an|the|in)\\s+)close-?ups?\\b",
  "i",
);

export function composePrompt(decl: ShotDecl, vocab: Vocab, opts: { firstFrame?: boolean } = {}): string {
  const closing = decl.text ? vocab.CLOSE_TEXT : decl.open ? vocab.CLOSE_H : vocab.CLOSE;
  const body = NEAR.test(decl.body ?? "") ? `${decl.body} ${vocab.CLOSEUP_GUARD}` : decl.body;
  const core = [
    `integrated_multimodal_description: [Shot 1] ${vocab.STYLE} ${body} ${closing}`,
    "",
    `overall_soundscape: ${decl.sound ?? ""}`,
    "",
    `non_diegetic_music: ${decl.music ?? "N/A"}`,
  ].join("\n");
  return opts.firstFrame ? `${I2V_LINE}\n\n${core}` : core;
}

/**
 * 章カード。番号と章名の2行だけを置く。
 * 文字精度は「横書きの明示 + 文字数の明示 + ダブルクォート」の3点で担保する(実測)。
 */
export function chapterCard(num: string, name: string): ShotDecl {
  const w = (t: string) => COUNT_WORD[[...t].length] ?? String([...t].length);
  return {
    text: true,
    body:
      "A wide shot of the cream paper standing as a chapter title card, filling the frame edge to edge. Exactly two lines of writing " +
      "sit on it, one above the other in the upper middle of the frame, both written horizontally from left to right in thick black " +
      `brush strokes: the smaller upper line reads "${num}", spelled with those ${w(num)} characters and nothing added, and ` +
      `the larger lower line below it reads "${name}", spelled with those ${w(name)} characters and nothing added. ` +
      "Every stroke of both lines is already finished in the very first frame and stays exactly the same for the whole shot, and no hand, arm, pen or brush appears at any moment. "
      + "The card holds completely still. The camera holds a static shot.",
    sound: "One crisp wooden clack, then a quiet room tone.",
  };
}
