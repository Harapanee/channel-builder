#!/usr/bin/env node
/**
 * PreToolUse hook(Bash): GPU 課金ロックの迂回を止める。
 *
 * Pod の起動と生成は `npm run h3:pod -- up|wait-up` / `npm run h3:run` を通すと
 * `H3_ALLOW_GPU=1`(完全一致)の課金ロックがかかる。`tools/comfy-runpod` の
 * `pod.mjs up|wait-up` と `batch.mjs` を直接叩くとロックを素通りするので、それをブロックする。
 * 課金を増やさない操作(down / status / stock / heartbeat / batch.mjs --dry)は通す。
 *
 * 入力: stdin に Claude Code の PreToolUse JSON(tool_input.command)。
 * exit 2 = ブロック(stderr が Claude に渡る)。それ以外は許可。入力が壊れていたら許可(フックの故障で作業を止めない)。
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** pod.mjs の課金を増やすサブコマンド */
const BILLING_POD_SUBCOMMANDS = new Set(["up", "wait-up"]);

/** コマンド位置の前に来てよい語(環境変数の代入・前置コマンド) */
const PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=.*|nohup|exec|time|env|caffeinate|sudo)$/;

function tokenize(segment) {
  return segment
    .split(/\s+/)
    .map((t) => t.replace(/^["'(]+|["')]+$/g, ""))
    .filter(Boolean);
}

/** tokens[i] が「実行される」位置か: node(フラグを挟んでよい)の引数、またはコマンド位置 */
function isExecuted(tokens, i) {
  let j = i - 1;
  while (j >= 0 && tokens[j].startsWith("-")) j -= 1;
  if (j >= 0 && /(^|\/)node(js)?$/.test(tokens[j])) return true;
  // コマンド位置(前が代入や nohup などだけ、または bash -c の直後)
  for (let k = 0; k < i; k += 1) {
    if (PREFIX.test(tokens[k])) continue;
    if (/(^|\/)(ba|z)?sh$/.test(tokens[k]) && tokens[k + 1] === "-c" && k + 2 === i) return true;
    return false;
  }
  return true;
}

/**
 * heredoc の本文を落とす(python / cat へ渡す文字列は実行されない。文書の編集で誤ブロックしない)。
 * ただし heredoc を受けるのがシェル(bash / sh / zsh)なら本文は実行されるので残す。
 */
export function stripHeredocBodies(command) {
  const lines = command.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (!m) continue;
    const before = line.slice(0, m.index);
    const seg = before.split(/&&|\|\||[;|&]/).pop() ?? "";
    const cmd = tokenize(seg).find((t) => !PREFIX.test(t)) ?? "";
    if (/(^|\/)(ba|z)?sh$/.test(cmd)) continue;
    const tag = m[3];
    let j = i + 1;
    while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, "") : lines[j]) !== tag) j += 1;
    i = j; // 終端行も落とす(本文だけ落として以降を普通に見る)
  }
  return out.join("\n");
}

/**
 * ブロックすべきならその理由、通すなら null。
 * `&&` `||` `;` `|` `&` 改行で区切った各段を見る(前段の --dry で後段を素通りさせない)。
 */
export function blockReason(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  for (const segment of stripHeredocBodies(command).split(/&&|\|\||[;|&\n]/)) {
    const tokens = tokenize(segment);
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (/(^|\/)pod\.mjs$/.test(t) && isExecuted(tokens, i) && BILLING_POD_SUBCOMMANDS.has(tokens[i + 1] ?? "")) {
        return `pod.mjs ${tokens[i + 1]} の直叩きは GPU 課金ロック(H3_ALLOW_GPU=1)を通りません。` +
          `\`H3_ALLOW_GPU=1 npm run h3:pod -- ${tokens[i + 1]}\` を使ってください(Pod 起動は要確認)。`;
      }
      if (/(^|\/)batch\.mjs$/.test(t) && isExecuted(tokens, i) && !tokens.slice(i + 1).includes("--dry")) {
        return "batch.mjs の直叩きは GPU 課金ロック(H3_ALLOW_GPU=1)を通りません。" +
          "生成は `H3_ALLOW_GPU=1 npm run h3:run -- <epId> <章ID> --url <URL>` を使ってください(計画だけなら batch.mjs --dry は可)。";
      }
    }
  }
  return null;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let command = "";
  try {
    command = JSON.parse(input)?.tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }
  const reason = blockReason(command);
  if (reason) {
    console.error("ブロック: " + reason);
    process.exit(2);
  }
  process.exit(0);
}

// シンボリックリンク越しに呼ばれても main を走らせる(走らないと全コマンドを黙って通してしまう)
const self = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && self(fileURLToPath(import.meta.url)) === self(process.argv[1])) await main();
