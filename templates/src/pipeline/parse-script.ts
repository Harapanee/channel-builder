#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPRESSIONS, isExpression, type Expression } from "../schemas/types";

/**
 * §5.4 script.md パーサ。
 *
 * パース規則(仕様書 §5.4 準拠):
 * - `## [Lxx] <beat>` — 行ID(一意)とビートタグ。ビートタグは教義上のラベルで
 *   あり、コードは値そのものを検証しない(自由文字列として扱う)。
 * - 引用ブロック(`>`) — TTSへ渡す文字列はこれのみ。1行につき1引用ブロック。
 *   連続する `>` 行は1つのブロックとして連結する。
 * - 箇条書き(`- key: value`) — 演出注釈。`pause_after_sec` / `speed_scale` は
 *   TTSパラメータとして数値解釈する。`speaker` は話者指定の正式フィールドとして
 *   保持する(値の妥当性はここでは検証しない。tts側で voice.json と突合する)。
 *   `expression` は立ち絵の表情指定の正式フィールドとして保持し、値が
 *   schemas/types.ts の EXPRESSIONS に含まれることをここで検証する(機械可読の契約)。
 *   それ以外(`delivery` 等)はLLM向けヒントとして `hints` に保持するのみで、
 *   コードは意味を解釈しない(`delivery` は自由文の演者向け散文であり、
 *   表情へ機械的に写像しない。表情は `expression` で明示すること)。
 * - HTMLコメント — 1行で完結するコメント(`^\s*<!--.*-->\s*$` にマッチする行)
 *   はどこにあっても無視する(引用ブロックの区切りとしても扱わない)。
 *   複数行にまたがるHTMLコメントは対象外で、従来どおりフォーマットエラーになる。
 * - 水平線(`---` / `***` / `___`)— 節の区切りとして無視する(引用ブロックは区切る)。
 * - メタ節見出し(`## 新規主張リスト` 等、`[Lxx]` 形式でない見出し)— その見出し
 *   以降は本文外として無視する。`##` の直後が `[` で始まるのに行ID形式にならない
 *   見出しは、書き損じとしてエラーにする(黙って本文を落とさない)。
 *
 * 不正形式はエラーにする:
 * - 行ID(`Lxx`)の重複
 * - 引用ブロックの欠落(0個)
 * - 引用ブロックの複数出現(2個以上)
 * - 認識できない行フォーマット
 * - pause_after_sec / speed_scale が数値として解釈できない
 * - expression が EXPRESSIONS(normal|smile|surprise|trouble)以外
 */

export type ParsedScriptLine = {
  lineId: string;
  beat: string;
  text: string;
  /** 話者キー(`- speaker:` 注釈由来。例 "zundamon")。tts側で voice.json と突合する */
  speaker?: string;
  /**
   * 立ち絵の表情(`- expression:` 注釈由来)。この行を話す話者の表情を指す。
   * 省略時は undefined = 描画側の既定表情(DEFAULT_EXPRESSION = "normal")。
   */
  expression?: Expression;
  pauseAfterSec?: number;
  speedScale?: number;
  /** delivery 等、コードが解釈しない演出注釈。LLM向けヒントとして保持する */
  hints?: Record<string, string>;
};

export type ParsedScript = {
  title?: string;
  lines: ParsedScriptLine[];
};

export class ScriptParseError extends Error {
  constructor(message: string, public readonly lineNumber?: number) {
    super(
      lineNumber !== undefined ? `${message} (line ${lineNumber})` : message
    );
    this.name = "ScriptParseError";
  }
}

const HEADING_RE = /^##\s*\[([A-Za-z0-9]+)\]\s*(.+?)\s*$/;
const TITLE_RE = /^#\s+(.+?)\s*$/; // 単一の # のみ。## は上のHEADING_REに委ねる
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const BULLET_RE = /^-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
/** 1行完結のHTMLコメント。マッチする行はパース対象から除外する */
const HTML_COMMENT_RE = /^\s*<!--.*-->\s*$/;
/**
 * スクリプト行(`## [Lxx]`)ではない ATX 見出し。台本本文の末尾に置く
 * メタ節(`## 新規主張リスト` 等、script-director 定義が要求する fact-checker 向け節)の
 * 開始マーカーとして扱う。この見出し以降はTTS本文ではないためパース対象から除外する
 * (「最初の見出し以前の行は無視する」規則と対称。§5.4)。
 */
const METADATA_HEADING_RE = /^#{1,6}\s+/;
/** `##` 以下の見出し全般(行ID見出しの書き損じ検出に使う) */
const ANY_HEADING_RE = /^#{2,}\s*(.*)$/;
/** 水平線。節の区切りとして無視する(引用ブロックを終端させる) */
const THEMATIC_BREAK_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const NUMERIC_KEYS = new Set(["pause_after_sec", "speed_scale"]);
/** 話者指定の注釈キー。正式フィールド(speaker)として保持する(hints行きにしない) */
const SPEAKER_KEY = "speaker";
/** 表情指定の注釈キー。正式フィールド(expression)として保持する(hints行きにしない) */
const EXPRESSION_KEY = "expression";

type RawSection = {
  lineId: string;
  beat: string;
  headingLineNumber: number;
  bodyLines: { text: string; lineNumber: number }[];
};

function splitIntoSections(content: string): {
  title?: string;
  sections: RawSection[];
} {
  const lines = content.split(/\r\n|\r|\n/);
  let title: string | undefined;
  const sections: RawSection[] = [];
  let current: RawSection | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i];

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      current = {
        lineId: headingMatch[1],
        beat: headingMatch[2],
        headingLineNumber: lineNumber,
        bodyLines: [],
      };
      sections.push(current);
      continue;
    }

    // 行ID見出しの書き損じ(`##` の直後が `[` で始まるのに HEADING_RE に
    // マッチしない)は、メタ節扱いで黙って本文を落とさず即エラーにする。
    const anyHeading = ANY_HEADING_RE.exec(line);
    if (anyHeading && anyHeading[1].startsWith("[")) {
      throw new ScriptParseError(
        `行ID見出しの形式が不正です: "${line.trim()}"(正: "## [Lxx] <beat>")`,
        lineNumber
      );
    }

    // 台本本文の後に続くメタ節見出し(`## 新規主張リスト` 等、`## [Lxx]` 以外の
    // ATX見出し)に達したら、以降はTTS本文ではないのでパースを打ち切る。
    // 最初の見出しより前(current 未設定)の H1 タイトル等はここに来ない。
    if (current && METADATA_HEADING_RE.test(line)) {
      break;
    }

    if (!current) {
      const titleMatch = TITLE_RE.exec(line);
      if (titleMatch && title === undefined) {
        title = titleMatch[1];
      }
      // 最初の見出し以前の行(タイトル、空行等)は無視する
      continue;
    }

    current.bodyLines.push({ text: line, lineNumber });
  }

  return { title, sections };
}

function parseSection(section: RawSection): ParsedScriptLine {
  const blockquoteBlocks: string[][] = [];
  const hints: Record<string, string> = {};
  let speaker: string | undefined;
  let expression: Expression | undefined;
  let pauseAfterSec: number | undefined;
  let speedScale: number | undefined;

  let currentBlock: string[] | null = null;

  for (const { text, lineNumber } of section.bodyLines) {
    if (HTML_COMMENT_RE.test(text)) {
      continue; // 1行完結のHTMLコメントは無視(currentBlockにも影響させない)
    }
    if (text.trim() === "") {
      currentBlock = null; // 空行はブロックの区切り
      continue;
    }
    if (THEMATIC_BREAK_RE.test(text)) {
      currentBlock = null; // 水平線は節の区切り
      continue;
    }

    const bqMatch = BLOCKQUOTE_RE.exec(text);
    if (bqMatch) {
      if (!currentBlock) {
        currentBlock = [];
        blockquoteBlocks.push(currentBlock);
      }
      currentBlock.push(bqMatch[1]);
      continue;
    }
    currentBlock = null; // 引用ブロック以外の行が来たらブロック終了

    const bulletMatch = BULLET_RE.exec(text);
    if (bulletMatch) {
      const [, key, rawValue] = bulletMatch;
      const value = rawValue.trim();
      if (NUMERIC_KEYS.has(key)) {
        const num = Number.parseFloat(value);
        if (Number.isNaN(num)) {
          throw new ScriptParseError(
            `[${section.lineId}] "${key}" は数値である必要があります(値: "${value}")`,
            lineNumber
          );
        }
        if (key === "pause_after_sec") pauseAfterSec = num;
        if (key === "speed_scale") speedScale = num;
      } else if (key === SPEAKER_KEY) {
        speaker = value;
      } else if (key === EXPRESSION_KEY) {
        // 表情は機械可読の契約。タイポを黙って normal へ握り潰さず、ここで落とす
        if (!isExpression(value)) {
          throw new ScriptParseError(
            `[${section.lineId}] 未知の表情 "${value}" です(許可値: ${EXPRESSIONS.join(" | ")})`,
            lineNumber
          );
        }
        expression = value;
      } else {
        hints[key] = value;
      }
      continue;
    }

    throw new ScriptParseError(
      `[${section.lineId}] 認識できない行フォーマットです: "${text}"`,
      lineNumber
    );
  }

  if (blockquoteBlocks.length === 0) {
    throw new ScriptParseError(
      `[${section.lineId}] 引用ブロック(TTS本文)がありません`,
      section.headingLineNumber
    );
  }
  if (blockquoteBlocks.length > 1) {
    throw new ScriptParseError(
      `[${section.lineId}] 引用ブロックが複数あります(1行につき1引用ブロックのみ許可)`,
      section.headingLineNumber
    );
  }

  const text = blockquoteBlocks[0].join(" ").trim();
  if (text.length === 0) {
    throw new ScriptParseError(
      `[${section.lineId}] 引用ブロックの本文が空です`,
      section.headingLineNumber
    );
  }

  const result: ParsedScriptLine = {
    lineId: section.lineId,
    beat: section.beat,
    text,
  };
  if (speaker !== undefined) result.speaker = speaker;
  if (expression !== undefined) result.expression = expression;
  if (pauseAfterSec !== undefined) result.pauseAfterSec = pauseAfterSec;
  if (speedScale !== undefined) result.speedScale = speedScale;
  if (Object.keys(hints).length > 0) result.hints = hints;
  return result;
}

export function parseScript(content: string): ParsedScript {
  const { title, sections } = splitIntoSections(content);

  const seen = new Set<string>();
  const lines: ParsedScriptLine[] = [];
  for (const section of sections) {
    if (seen.has(section.lineId)) {
      throw new ScriptParseError(
        `行ID "${section.lineId}" が重複しています`,
        section.headingLineNumber
      );
    }
    seen.add(section.lineId);
    lines.push(parseSection(section));
  }

  return { title, lines };
}

export function parseScriptFile(filePath: string): ParsedScript {
  const content = readFileSync(filePath, "utf-8");
  return parseScript(content);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) ===
      path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

function main() {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("Usage: parse-script.ts <path-to-script.md>");
    process.exit(1);
  }
  try {
    const parsed = parseScriptFile(scriptPath);
    process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    if (err instanceof ScriptParseError) {
      console.error(`Error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error: unknown parse failure");
    }
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
