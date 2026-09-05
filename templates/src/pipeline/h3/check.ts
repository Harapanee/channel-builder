/**
 * 課金前の砦。合成済みプロンプト全文を、公式仕様
 * (~/.claude/skills/h3-prompt-writing/references/base-en.txt)と
 * ComfyUI 経路の制約に照らして検査する。
 *
 * BLOCK は生成に進ませない。GPU は RTX 5090 で約 $1.23/h、1クリップ 44〜72秒。
 * 尺レンジ外のような形式違反は、ここで止めないと Pod 起動後=課金中に判明する。
 *
 * ただし**公式が明示的に禁じていないものは BLOCK にしない**。不正確なゲートは
 * 表現の縛りを生む(2026-07-27 の教訓)。カメラ文の存在要件とディゾルブは ADVISE。
 */
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { MAX_FRAMES, TRAINED_MIN_FRAMES, framesForSeconds } from "./frames";
import { I2V_LINE } from "./compose";
import { SPEEDUP_ADVISE, type SpeedupRow } from "./plan";
import type { CutsFile, Cut, Finding, ShotDecl, Vocab } from "./types";

/** 公式のカメラ動作12種を検出する語(Push In / Pull Out は公式表では同じ行だが語は別) */
export const CAMERA_MOTIONS = [
  "zoom", "push", "pull", "pan", "truck", "tilt", "pedestal", "arc", "tracking", "static", "shake", "pov", "roll",
] as const;

/** 公式のカット動詞5句 */
export const CUT_VERBS = [
  "the camera cuts to", "the shot cuts to", "the shot transitions to", "the shot changes to", "the shot switches to",
] as const;

/**
 * 公式が明示的に許可した転換語(base-en.txt §4.2:
 * "When explicitly requested by the user, cross-dissolve, fade, or wipe may also be used")。
 * ショット境界でこれらを使うこと自体は BLOCK にしない。ディゾルブ多用の是非などは
 * Task 6 の ADVISE(A8)で扱う。
 */
const TRANSITION_WORDS = ["cross-dissolve", "cross-dissolves", "dissolves to", "fades to", "wipes to"] as const;

/**
 * 公式に無い、よく紛れ込むカメラの言い回し。
 * **カメラ文脈に限った言い回しだけを列挙する。** 単語だけで弾くと、動物名(crane=鶴、
 * mole=モグラ)が被写体として正当に出てくるこのチャンネルでは誤検知になる。
 */
const FORBIDDEN_CAMERA =
  /\b(dolly (in|out|forward|back)|dollies (in|out|forward|back)|crane shot|craning|orbits? around|handheld|steadicam|whip pans?|swoops? (in|down|over)|drone shot|camera flies (over|through))\b/i;

// 冠詞・修飾語(a/an/the 等)が amplitude/speed の前に入っても、その直前の語を拾う
const AMPLITUDE = /with (?:\w+\s+)*?(\w+) amplitude/g;
const SPEED = /at (?:\w+\s+)*?(\w+) speed/g;
/** 約物(U+3000-303F)・かな/カナ(U+3040-30FF)・漢字(U+4E00-9FFF)・全角形/半角カナ(U+FF01-FF9F) */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF\uFF01-\uFF9F]/;

const COUNT_WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/** 引用符の中と <d>…</d> の中を落とす(画面内文字・台詞は原文のまま書くのが正しいため) */
export function stripQuoted(text: string): string {
  return text.replace(/<d>[\s\S]*?<\/d>/g, "").replace(/"[^"]*"/g, "");
}

function parseMmSs(s: string): number {
  const m = s.match(/^(\d{2}):(\d{2})\.(\d{3})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
}

export function checkPromptText(
  id: string,
  prompt: string,
  ctx: { seconds: number; hasFirstFrame: boolean },
): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, message: string) => out.push({ level: "BLOCK", id, rule, message });

  // --- B2: モード別の指示行 -------------------------------------------------
  const hasLine = prompt.startsWith(I2V_LINE + "\n\n");
  const looksLikeLine = /^For the target video,/.test(prompt);
  if (ctx.hasFirstFrame && !hasLine) add("B2", "first_frame があるのに I2VA の指示行が逐語一致で先頭に無い");
  if (!ctx.hasFirstFrame && (hasLine || looksLikeLine)) add("B2", "first_frame が無いのに参照画像の指示行が付いている");

  const core = hasLine ? prompt.slice(I2V_LINE.length + 2) : prompt;

  // --- B1: 3フィールドの存在・順序・単一性 ----------------------------------
  const FIELDS = ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"];
  const positions = FIELDS.map((f) => {
    const all = [...core.matchAll(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
    return { field: f, count: all.length, at: all[0]?.index ?? -1 };
  });
  for (const p of positions) {
    if (p.count === 0) add("B1", p.field + " が無い");
    else if (p.count > 1) add("B1", p.field + " が " + p.count + " 回出ている");
  }
  const found = positions.filter((p) => p.at >= 0);
  for (let i = 1; i < found.length; i += 1) {
    if (found[i].at < found[i - 1].at) {
      add("B1", "フィールドの順序が違う(" + found[i].field + " が " + found[i - 1].field + " より前)");
      break;
    }
  }

  // --- B12: 生成音楽は使わない ---------------------------------------------
  // BGM は bgm-plan.json の包絡線設計が正であり、カットごとに生成音楽が入ると衝突する。
  // 環境音(overall_soundscape)は使うが、音楽だけは N/A 固定にする。
  const music = prompt.match(/^non_diegetic_music:\s*(.*)$/m);
  if (music && music[1].trim() !== "N/A") {
    add("B12", "non_diegetic_music が N/A ではない(BGM は bgm-plan.json が正。生成音楽は使わない)");
  }

  const bodyText = core.split(/\n\noverall_soundscape:/)[0] ?? core;
  const clean = stripQuoted(bodyText);

  // --- B3: ショットの時刻 ---------------------------------------------------
  if (/\[Shot 1\]\s*At\s/i.test(bodyText)) add("B3", "[Shot 1] に時刻を書いてはいけない");
  const shots = [...bodyText.matchAll(/\[Shot (\d+)\]\s*At (\d{2}:\d{2}\.\d{3}),/g)];
  let prev = 0;
  for (const m of shots) {
    const t = parseMmSs(m[2]);
    if (Number.isNaN(t)) { add("B3", "[Shot " + m[1] + "] の時刻表記が MM:SS.mmm でない"); continue; }
    if (t <= prev) add("B3", "[Shot " + m[1] + "] の時刻 " + m[2] + " が前のショット以下");
    if (t >= ctx.seconds) add("B3", "[Shot " + m[1] + "] の時刻 " + m[2] + " が尺 " + ctx.seconds + "秒 の外");
    prev = t;
  }
  for (const m of bodyText.matchAll(/\[Shot (\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 2 && !shots.some((s) => Number(s[1]) === n)) add("B3", "[Shot " + n + "] にカット時刻が無い");
  }

  // --- B4: カメラ(語彙のみ。存在要件は A7 で ADVISE) ----------------------
  // camera / POV を含む文だけを検査する。本文全体を素通しにすると、被写体の動き
  // (例: "The bear charges at top speed")や動物名(crane=鶴・mole=モグラ等)を誤って弾く。
  const camSentences = clean.split(/(?<=\.)\s+/).filter((s) => /\bcamera\b/i.test(s) || /\bpov\b/i.test(s));
  for (const sentence of camSentences) {
    const badCam = sentence.match(FORBIDDEN_CAMERA);
    if (badCam) add("B4", "公式12種に無いカメラ表現「" + badCam[0] + "」");
    for (const m of sentence.matchAll(AMPLITUDE)) {
      if (m[1] !== "small" && m[1] !== "large") add("B4", "振幅は small / large のみ(「" + m[1] + "」)");
    }
    for (const m of sentence.matchAll(SPEED)) {
      if (m[1] !== "slow" && m[1] !== "fast") add("B4", "速度は slow / fast のみ(「" + m[1] + "」)");
    }
  }

  // --- A12(旧 B5): [Shot 2] 以降の境界の書き方 -------------------------------
  // **2026-08-27 に BLOCK から ADVISE へ降格した。** 公式のカット動詞5句を必須にしていたが、
  // 公式 §4.2 は "For ordinary cuts, use ..." であって MUST とは書いておらず、BLOCK にすると
  // 繋ぎの表現がカット動詞5句だけに縛られる。このファイル冒頭の「不正確なゲートは表現の縛りを
  // 生む(2026-07-27 の教訓)」がそのまま当てはまる。時刻の妥当性は B3 が BLOCK で見続ける。
  //
  // **`<scenetrans>` は転換語として数えない。** 公式 §4.4 の `<scenetrans>` は「同じ台詞・歌が
  // カットを跨ぐとき、音が続いていることを示す印」であって、カットの転換そのものではない。
  // このチャンネルは生成音声(`<d>`)を使わない(ナレーションは VOICEVOX)ので、そもそも
  // `<scenetrans>` を書く場面が無い。
  for (const m of shots) {
    const start = m.index ?? 0;
    const rest = bodyText.slice(start + 1);
    const nextAt = rest.indexOf("[Shot ");
    const seg = (nextAt === -1 ? rest : rest.slice(0, nextAt)).toLowerCase();
    const hasCutVerb = CUT_VERBS.some((v) => seg.includes(v));
    const hasTransition = TRANSITION_WORDS.some((v) => seg.includes(v));
    if (!hasCutVerb && !hasTransition) {
      out.push({
        level: "ADVISE",
        id,
        rule: "A12",
        message: "[Shot " + m[1] + "] の境界に公式の転換語が無い(カット動詞5句・cross-dissolve/fade/wipe のいずれも)",
      });
    }
  }

  // --- B6: 尺 ---------------------------------------------------------------
  let frames = -1;
  try { frames = framesForSeconds(ctx.seconds); } catch (e) { add("B6", (e as Error).message); }
  if (frames >= 0) {
    if (frames > MAX_FRAMES) add("B6", frames + " フレームは上限 " + MAX_FRAMES + " を超える");
    if (frames < TRAINED_MIN_FRAMES) add("B6", frames + " フレームは学習レンジ下限 " + TRAINED_MIN_FRAMES + " 未満");
  }

  // --- B9: 英語 -------------------------------------------------------------
  const cjk = stripQuoted(core).match(new RegExp(CJK.source, "g"));
  if (cjk) add("B9", "英文に日本語 " + [...new Set(cjk)].join("") + " が混ざっている");

  // --- B10: 画面内文字の字数宣言 --------------------------------------------
  for (const m of core.matchAll(/"([^"]+)",?\s*spelled with (?:that|those)\s+(\w+)\s+characters?/g)) {
    const n = COUNT_WORD[m[2]] ?? (/^\d+$/.test(m[2]) ? Number(m[2]) : undefined);
    if (n === undefined) { add("B10", '"' + m[1] + '" の字数宣言「' + m[2] + '」が読めない'); continue; }
    if (n !== [...m[1]].length) {
      add("B10", '"' + m[1] + '" は ' + [...m[1]].length + "文字なのに " + m[2] + " と書いてある");
    }
  }

  return out;
}

/**
 * 実証済みの失敗パターン。止めないが必ず見せる。
 * 出典は h3/_archive/v2-remake/lib.mjs のコメントと 2026-08-19 の実測。
 * **書き手が書いた body に当てる**(合成後の全文に当てると語彙帳の閉じの一文が毎回引っかかる)。
 */
const ADVISORIES: { rule: string; re: RegExp; message: string }[] = [
  {
    rule: "A1",
    re: /\b(ruled lines?|notebook|ledger|sheet of paper|writing paper|note ?book)\b/i,
    message: "紙・帳面・罫線は指定していない文字を強く呼ぶ(2026-08-19に2度実証・鎖で4〜6カット引きずった)。無地の矩形として書く",
  },
  {
    // "turns? into" / "changes? into" / "becomes? an?" は自然文でも高頻度に当たる
    // (色・光の変化「becomes a pale green」、方向転換「turns into the side channel」等)。
    // A2 の目的は識別されたアイデンティティ変形の罠だけを指摘することなので、
    // 実証された "transforms into" / "morphs" に絞る(2026-08-19 レビュー対応)。
    rule: "A2",
    re: /\b(transforms? into|morphs?)\b/i,
    message: "「AがBに変形」は事故る。移動・出現・拡大で書く",
  },
  {
    rule: "A3",
    re: /\b(tanks?)\b/i,
    message: "多義語(tank は戦車になる・実証済み)。この一覧は実証された語だけを足していく",
  },
  {
    // 閉じの一文(語彙帳が制度化した書き方)は stripClosingSentences で先に落としてある。
    // ここが拾うのは**本文の途中に散らばった否定**だけ(語彙 HATCHERY の "no wall, window,
    // ceiling…" のような形)。2026-08-19 fix round 1: wall を足し、閉じの一文を除外した。
    rule: "A6",
    re: /\bno (windows?|walls?|people|text|letters|writing)\b/i,
    message: "否定形の禁止は効かない。描くものを限定する書き方に寄せる",
  },
  {
    rule: "A8",
    re: /\bthe (shot|camera) (cross-?dissolves|dissolves|fades|wipes) to\b/i,
    message: "公式はディゾルブ等を「ユーザーが明示的に求めたとき」に限っている。既定はカットにする",
  },
];

/**
 * 場所から書き始めているか。冒頭は「A/An/The <修飾語> shot / view / close-up …」になるはず。
 *
 * **見るのはショット宣言の頭だけで、そのあとに続く前置詞や分詞は問わない。**
 * 2026-08-19 fix round 1: 直後を `of|from|taken from` に限っていたため、場所を明記している
 * 正当な書き出しを12件すべて誤検知していた(実データで確認):
 *   - "A wide shot filled edge to edge with a dense field of…"(cL08 / cL34 / cL93)
 *   - "A close overhead shot looking straight down at a flat grey concrete floor…"(cL13 / cL19)
 *   - "A very close shot inside a river gravel bed…"(cL300)
 *   - "A wide shot that begins on the same map…"(鎖で場所を first_frame から継ぐ 5件)
 * 修飾語は4語まで。絞らないと「The salmon swims forward in a wide shot of the sea.」のように
 * 途中に shot があるだけの文(=被写体から始まっている)も通ってしまう。
 */
const OPENS_WITH_SHOT = /^(?:A|An|The)\s+(?:[\w-]+\s+){0,4}(?:shot|view|close-?up)\b/;

/**
 * 場所を分詞・前置詞で言い切る書き出し。**2026-08-27 に追加した。**
 * それまでは「A/An/The + 修飾語 + shot / view」の形しか認めていなかったが、これは
 * 公式にも根拠が無い形式の押し付けであり(公式 §4.1 は shot の語で始めろとは言っていない)、
 * `Looking up from the bottom of a canyon of …` のように場所を完全に言い切る書き出しまで
 * 指摘していた。A5 の目的は「場所を書かせること」であって「shot の語で始めさせること」ではない。
 *
 * **被写体から始まる文は拾い続ける**(`The salmon swims forward in a wide shot of the sea.`)。
 * そのために、ここで受けるのは「場所へ視線を置く語」に限る。
 */
const OPENS_WITH_PLACE_PHRASE =
  /^(?:Looking|Seen|Viewed|Framed|Inside|Within|Across|Along|Above|Below|Beneath|Underneath|Behind|Beyond|Overhead)\b/;

const OPENS_WITH_PLACE = new RegExp("(?:" + OPENS_WITH_SHOT.source + ")|(?:" + OPENS_WITH_PLACE_PHRASE.source + ")");

/**
 * 閉じの一文(「他には何も出ない」)の見出し。
 * negative prompt を持たないこのモデルでは、閉じの一文が**唯一使える禁止手段**であり、
 * 語彙帳が CLOSE / CLOSE_H / CLOSE_TEXT として制度化した正しい書き方である。
 * v2 の章ファイルはこれを body の末尾へ手書きしており、**手書きの変種が最低6種類ある**
 * (cL133 の "…, and no hands and no arms enter the frame." など語彙帳に無い形も含む)。
 * 完全一致リストでは取りこぼすので、**この見出しで始まる文**を閉じの一文とみなす。
 */
const CLOSING_HEAD = /^(?:Nothing else appears|No other)\b/;

/**
 * body から閉じの一文を落とす。A6(否定形の禁止は効かない)を当てる前に必ず通す。
 * 落とさないと A6 が「推奨された書き方」を叩き続け、**本当に危ない散在型の否定**
 * (語彙 HATCHERY の "no wall, window, ceiling…" など)が件数に埋もれる。
 * 2026-08-19 fix round 1: 実データで A6 125件が全件この誤検知だった。
 */
export function stripClosingSentences(body: string, vocab?: Vocab): { kept: string; stripped: string[] } {
  const exact = new Set<string>(
    [vocab?.CLOSE, vocab?.CLOSE_H, vocab?.CLOSE_TEXT].filter((x): x is string => Boolean(x)),
  );
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const sentence of body.split(/(?<=\.)\s+/)) {
    const t = sentence.trim();
    if (t && (exact.has(t) || CLOSING_HEAD.test(t))) stripped.push(t);
    else kept.push(sentence);
  }
  return { kept: kept.join(" "), stripped };
}

/**
 * 公式の Static Shot を散文で書いた言い回し。
 * 2026-08-19 fix round 1: cL243/cL244/cL245 の "the camera not moving at all" が
 * 語幹一覧に static しか無いために「動き語が無い」と判定されていた。静止の指定は
 * 立派な動きの指定なので A7 にしない。
 */
const STATIC_PROSE =
  /\b(?:not moving|without moving|does not move|doesn't move|never moves|holds? (?:still|steady|in place)|held still|remains? (?:still|fixed|in place)|stays? (?:still|fixed|put|in place)|motionless|locked off)\b/i;

/**
 * A7 判定用: CAMERA_MOTIONS の語幹に一般的な活用語尾(-s/-es/-ed/-ing)を許して一致させる。
 * 語尾を `\w*` にすると "arc" が "arctic" の頭に一致するなど無関係語を拾ってしまうため、
 * 固定の語尾候補だけを許可する(2026-08-19 レビュー対応: "pushes"/"pans"/"trucks" 等の
 * 活用形が語幹の完全一致にしか当たらず、標準的なカメラ文がすべて A7 になっていた)。
 * "tracking" は元々 -ing 形なのでそのまま。"shake" は語尾の e を落として -ing/-ed を作る。
 */
function withInflections(stem: string): string {
  if (stem.endsWith("ing")) return stem;
  if (stem.endsWith("e")) {
    const dropped = stem.slice(0, -1);
    return `${stem}s?|${dropped}(?:ed|ing)?`;
  }
  return `${stem}(?:s|es|ed|ing)?`;
}
const CAMERA_MOTION_RE = new RegExp("\\b(" + CAMERA_MOTIONS.map(withInflections).join("|") + ")\\b", "i");

/**
 * 語彙帳の否定形(A11)。**2026-09-05 に追加。**
 * ep027 の HATCHLING に "no legs" と書いた結果、第一章の5カット全部に四肢が描かれ、検品が
 * 「系統的逸脱・個別再生成では直らない」と申し送った。A6 は body の途中しか見ておらず、
 * 語彙帳の定義(places / subjects / props)は検査の外だった。語彙帳の否定は全カットへ複製されるので、
 * body 側の A6 より先に、**語彙の項目ごとに1件**で指摘する(カット数ぶん並べない)。
 * 閉じの一文(CLOSE 系)と STYLE の "no shading and no gradients" は制度化した書き方なので対象外。
 */
const VOCAB_NEGATION = /\b(?:no|without|never|not)\b[^.,;]{0,40}/i;

export function checkVocabNegations(vocab: Vocab): Finding[] {
  const out: Finding[] = [];
  for (const group of ["places", "subjects", "props"] as const) {
    for (const [key, text] of Object.entries(vocab[group] ?? {})) {
      const m = text.match(VOCAB_NEGATION);
      if (m) {
        out.push({
          level: "ADVISE", id: group + "." + key, rule: "A11",
          message: "語彙帳に否定形「" + m[0].trim().slice(0, 40) + "」。否定は効かず全カットへ複製される。描くものを限定する肯定形へ(例: no legs → a smooth belly line running unbroken from chin to tail)",
        });
      }
    }
  }
  return out;
}

/**
 * body の A6 のうち、語彙帳の定義から来たもの(語彙の値に同じ語句が含まれる)を落とす。
 * 語彙由来は A11 が項目ごとに1件で報告するので、カット数ぶん並べると本当に見るべき指摘が埋もれる
 * (ep027/ep028 で「no wall」×6 が定数由来だった)。
 */
export function dropVocabOriginA6(findings: Finding[], vocab: Vocab): Finding[] {
  const values = [...Object.values(vocab.places ?? {}), ...Object.values(vocab.subjects ?? {}), ...Object.values(vocab.props ?? {})];
  return findings.filter((f) => {
    if (f.rule !== "A6") return true;
    const m = f.message.match(/^「([^」]+)」/);
    if (!m) return true;
    const phrase = m[1].toLowerCase();
    return !values.some((v) => v.toLowerCase().includes(phrase));
  });
}

export function checkAdvisories(id: string, body: string, vocab?: Vocab): Finding[] {
  const out: Finding[] = [];
  // 閉じの一文は「唯一使える禁止手段」なので、規則を当てる前に body から外す。
  // 外した事実は A9 で1行だけ報告する(A6 で1件ずつ叩かない)。
  const { kept, stripped } = stripClosingSentences(stripQuoted(body), vocab);
  const clean = kept;
  for (const a of ADVISORIES) {
    const m = clean.match(a.re);
    if (m) out.push({ level: "ADVISE", id, rule: a.rule, message: "「" + m[0] + "」— " + a.message });
  }
  if (stripped.length > 0) {
    out.push({
      level: "ADVISE",
      id,
      rule: "A9",
      message:
        "body に閉じの一文が手書きされている(合成器も足すので二重になる)" +
        (stripped.length > 1 ? " ×" + stripped.length : "") +
        ": 「" + stripped[0].slice(0, 48) + "…」",
    });
  }
  if (!OPENS_WITH_PLACE.test(body.trim())) {
    out.push({ level: "ADVISE", id, rule: "A5", message: "場所の記述から始まっていない。場所を書かないとモデルが場所を発明する" });
  }
  // A7: camera / POV を含む文だけを見る(B4 と同じ切り出し方)。
  //   1) そもそもカメラ文が無い → 動きの指定が無い
  //   2) カメラ文はあるが CAMERA_MOTIONS 13語も静止の散文表現も含まない → 動きが読み取れない
  // どちらも ADVISE(止めない)。CAMERA_MOTIONS はここでのみ参照される(2026-08-19 裁定)。
  const camSentences = clean.split(/(?<=\.)\s+/).filter((s) => /\bcamera\b/i.test(s) || /\bpov\b/i.test(s));
  if (camSentences.length === 0) {
    out.push({ level: "ADVISE", id, rule: "A7", message: "カメラの記述が無い。動きの指定が無いカットは絵が停滞しやすい" });
  } else if (!camSentences.some((s) => CAMERA_MOTION_RE.test(s) || STATIC_PROSE.test(s))) {
    out.push({ level: "ADVISE", id, rule: "A7", message: "カメラの文はあるが公式12種の動き語が無い。動きの指定が無いカットは絵が停滞しやすい" });
  }
  return out;
}

/**
 * ジョブ集合に対する検査。
 * basename の一意性が要るのは、Pod へのアップロードが basename で行われ、
 * 別ディレクトリの同名ファイルが Pod 上で衝突するため(既知欠陥)。
 * 実在検査は投入直前にだけ走らせる(検査 CLI の時点では起点フレームがまだ無い)。
 */
export function checkJobSet(
  jobs: { id: string; prompt: string; firstFrameFile?: string }[],
  opts: { requireExists?: boolean } = {},
): Finding[] {
  const out: Finding[] = [];
  const ids = new Set<string>();
  const bases = new Map<string, string>();
  for (const j of jobs) {
    if (ids.has(j.id)) out.push({ level: "BLOCK", id: j.id, rule: "B8", message: "id が重複している" });
    ids.add(j.id);
    if (!j.prompt || !j.prompt.trim()) out.push({ level: "BLOCK", id: j.id, rule: "B8", message: "prompt が空" });
    if (!j.firstFrameFile) continue;
    if (opts.requireExists && !existsSync(j.firstFrameFile)) {
      out.push({ level: "BLOCK", id: j.id, rule: "B7", message: "参照画像が実在しない: " + j.firstFrameFile });
    }
    const b = basename(j.firstFrameFile);
    const owner = bases.get(b);
    if (owner && owner !== j.firstFrameFile) {
      out.push({ level: "BLOCK", id: j.id, rule: "B7", message: "参照画像の basename「" + b + "」が " + owner + " と衝突する(Pod上で同じ名前になる)" });
    }
    bases.set(b, j.firstFrameFile);
  }
  return out;
}

/**
 * 台帳(cuts.json)と宣言(shots/chXX.ts)の整合。
 * 食い違うと「検査した文面」と「実際に投げる文面」が別物になる
 * (I2V 指示行の有無が変わるため)。
 */
/**
 * `Cut` が持ちうるキーの全体。**ここに無いキーは黙って無視される**ため、
 * 綴り間違い(`nosub` / `noSubs` など)は「立てたのに効かない」形の事故になり、
 * レンダー後の目視まで発覚しない(2026-08-27 の敵対レビュー指摘)。B13 で止める。
 * `types.ts` の `Cut` に欄を足したら**ここにも足す**。
 */
const CUT_KEYS = new Set([
  "lineIds", "seconds", "place", "subject", "role",
  "chain", "chainFrom", "hi", "text", "card", "holdSlow", "noSub",
]);

export function checkLedger(id: string, decl: ShotDecl, cut: Cut | undefined): Finding[] {
  if (!cut) {
    return [{ level: "BLOCK", id, rule: "B11", message: "cuts.json に " + id + " が無い(章ファイルと台帳が食い違っている)" }];
  }
  const out: Finding[] = [];

  // B13: 未知のキー(綴り間違いは黙って無効になる)
  for (const k of Object.keys(cut)) {
    if (!CUT_KEYS.has(k)) {
      out.push({ level: "BLOCK", id, rule: "B13", message: "cuts.json に未知のキー「" + k + "」がある(綴り間違いは黙って無効になる)" });
    }
  }

  // A13: noSub は「画面に文字が出るカットの字幕を止める」欄。文字の出ないカットに立てると
  // 字幕が黙って消える。章カードは画面の文言と字幕の文言が別物なので対象外。
  if (cut.noSub && !(cut.text || decl.text) && !(cut.card || decl.card)) {
    out.push({
      level: "ADVISE",
      id,
      rule: "A13",
      message: "text の無いカットに noSub が立っている(画面に文字が無いのに字幕だけ消える)",
    });
  }
  const declCard = decl.card ? decl.card.join("|") : undefined;
  const cutCard = cut.card ? cut.card.join("|") : undefined;
  const isChapterCard = Boolean(decl.card || cut.card);

  // 真偽値の3キーは Boolean() で正規化してから比べる(false と未指定は同じ扱い。
  // `a ?? undefined` は false を潰さないため素通しだと過剰BLOCKになる。2026-08-19 レビュー対応)。
  // 章カードは chapterCard() が text: true を必ず注入するため、card があるカットは
  // text を比較対象から外す(cuts.json 側に text: true を重ねて書く契約は無い)。
  const boolKeys = (isChapterCard ? (["chain", "hi"] as const) : (["chain", "hi", "text"] as const));
  for (const k of boolKeys) {
    const a = Boolean(decl[k]);
    const b = Boolean(cut[k]);
    if (a !== b) {
      out.push({ level: "BLOCK", id, rule: "B11", message: k + " が食い違う(宣言=" + String(a) + " / 台帳=" + String(b) + ")" });
    }
  }
  if ((decl.chainFrom ?? undefined) !== (cut.chainFrom ?? undefined)) {
    out.push({
      level: "BLOCK",
      id,
      rule: "B11",
      message: "chainFrom が食い違う(宣言=" + String(decl.chainFrom) + " / 台帳=" + String(cut.chainFrom) + ")",
    });
  }
  if (declCard !== cutCard) {
    out.push({ level: "BLOCK", id, rule: "B11", message: "card が食い違う(宣言=" + String(declCard) + " / 台帳=" + String(cutCard) + ")" });
  }
  return out;
}

/**
 * A10: 早回しが強すぎるカット。**BLOCK にしない。**
 * 束ねの可否は意味判断であり(別々の実物を指す・章をまたぐ)、機械が止めてよい種類ではない。
 * `holdSlow` が立っているカットは planner が検討済みなので黙る。
 */
export function checkSpeedup(rows: SpeedupRow[], holdSlow: ReadonlySet<string> = new Set()): Finding[] {
  return rows
    .filter((r) => r.ratio > SPEEDUP_ADVISE && !holdSlow.has(r.cutId))
    .map((r) => ({
      level: "ADVISE" as const,
      id: r.cutId,
      rule: "A10",
      message:
        "早回し ×" + r.ratio.toFixed(2) + "(区間 " + r.spanSeconds.toFixed(2) +
        "秒 に 生成 " + r.generatedSeconds.toFixed(2) + "秒)— 隣接行との束ねを検討する。" +
        "束ねられないなら cuts.json に holdSlow: true を立てる(等速で頭から使う)",
    }));
}

/**
 * A11: 前カット参照。**モデルは前のカットを一切知らない。**
 *
 * 参照を解決できる唯一の経路は I2VA の first_frame(`chain` / `chainFrom`)であり、
 * それが無いカットの「than before」は解決不能な語として捨てられる。さらに悪いことに、
 * 2026-08-27 の走査では ep018 の cL202 / cL222 がこの書き方で `places` 定数を打ち消しており、
 * 1つのプロンプトの中に「水は下から三分の二」と「水は下から三分の一」が同居していた。
 * 打ち消しではなく `places` にバリアントを足すのが正しい直し方である。
 *
 * **`sound` は参照画像があっても指摘する。** first_frame が渡すのは絵だけで、
 * overall_soundscape に前のカットの音は一切渡らない。
 *
 * 語は ADVISORIES と同じ方針で**実証された言い回しだけ**に絞る(広げると
 * 「its back stands higher than before」のようにカット内で完結する正当な用法まで拾う)。
 */
const CROSS_CUT_REF = /\b(?:than|as) before\b|\bthan earlier\b/i;

export function checkSelfContained(
  id: string,
  decl: ShotDecl,
  opts: { hasFirstFrame: boolean },
): Finding[] {
  const out: Finding[] = [];
  const hit = (field: "body" | "sound", text: string, why: string) => {
    const m = text.match(CROSS_CUT_REF);
    if (m) {
      out.push({
        level: "ADVISE",
        id,
        rule: "A11",
        message: "「" + m[0] + "」が " + field + " にある — " + why,
      });
    }
  };
  if (!opts.hasFirstFrame && decl.body) {
    hit("body", decl.body, "このカットには参照画像が無く、モデルは前のカットを知らない。比較で書かず、見えるとおりの状態を書き切る(場所の量が変わるなら places にバリアントを足す)");
  }
  if (decl.sound) {
    hit("sound", decl.sound, "参照画像は絵しか渡さず、前のカットの音は渡らない。比較で書かず、聞こえるとおりの音を書き切る");
  }
  return out;
}

/** 「最初の最悪」を言う行はここまでに始まる(bible §4・2026-09-03) */
export const FIRST_WORST_DEADLINE_SEC = 45;

/**
 * B14: 冒頭45秒の規則。firstWorstLineId が無い・timing に無い・45秒より後に始まる・章カードのカットにある、を止める。
 * 検査は台帳(cuts.json)の欄に対して行う。判断(どの行が最初の最悪か)は h3-cut-planner が台本から決める。
 */
export function checkFirstWorst(
  cutsFile: Pick<CutsFile, "cuts" | "firstWorstLineId">,
  lines: { lineId: string; startSec: number }[],
): Finding[] {
  const id = cutsFile.firstWorstLineId;
  if (!id) {
    return [{ level: "BLOCK", id: "cuts.json", rule: "B14", message: "firstWorstLineId が無い(宣告から45秒以内に最初の最悪を言う行を台帳に書く。bible §4)" }];
  }
  const line = lines.find((l) => l.lineId === id);
  if (!line) return [{ level: "BLOCK", id: "cuts.json", rule: "B14", message: "firstWorstLineId の " + id + " が timing.json に無い" }];
  const out: Finding[] = [];
  if (line.startSec > FIRST_WORST_DEADLINE_SEC) {
    out.push({ level: "BLOCK", id: "cuts.json", rule: "B14", message: "最初の最悪(" + id + ")が " + line.startSec.toFixed(1) + "秒から。" + FIRST_WORST_DEADLINE_SEC + "秒以内に置く(台本の順序を直すか、行を選び直す)" });
  }
  const hit = Object.entries(cutsFile.cuts).find(([, c]) => c.lineIds.includes(id));
  if (!hit) out.push({ level: "BLOCK", id: "cuts.json", rule: "B14", message: "最初の最悪(" + id + ")を持つカットが無い" });
  else if (hit[1].card) out.push({ level: "BLOCK", id: hit[0], rule: "B14", message: "最初の最悪(" + id + ")が章カードのカットにある(画面で起こせない)" });
  return out;
}
