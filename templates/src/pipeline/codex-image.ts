/**
 * codex CLI 画像生成プロバイダ。
 *
 * `codex exec --skip-git-repo-check --sandbox workspace-write` をサブプロセスで呼び、
 * codex内蔵の image_gen ツールに画像を生成・指定パスへ保存させる。
 * 参照画像は -i で添付する。モデル指定は不可(codex側が決める)。
 *
 * レートリミット系の失敗は CodexError.isRateLimit=true で通知し、呼び出し側
 * (gen-image.ts)が .cache/codex-cooldown.json に30分のクールダウンを記録する。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COOLDOWN_MS = 30 * 60 * 1000;
const CODEX_TIMEOUT_MS = 300_000;
const RATE_LIMIT_RE = /rate.?limit|usage.?limit|\b429\b|quota/i;
const DEFAULT_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";

export class CodexError extends Error {
  constructor(
    message: string,
    public readonly isRateLimit: boolean
  ) {
    super(message);
  }
}

function cooldownPath(): string {
  return path.join(process.cwd(), ".cache", "codex-cooldown.json");
}

export function codexOnCooldown(now = Date.now()): boolean {
  try {
    const { until } = JSON.parse(fs.readFileSync(cooldownPath(), "utf8"));
    return typeof until === "number" && until > now;
  } catch {
    return false;
  }
}

export function recordCodexRateLimit(now = Date.now()): void {
  fs.mkdirSync(path.dirname(cooldownPath()), { recursive: true });
  fs.writeFileSync(cooldownPath(), JSON.stringify({ until: now + COOLDOWN_MS }));
}

export function resolveCodexBin(): string | null {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  return fs.existsSync(DEFAULT_CODEX_BIN) ? DEFAULT_CODEX_BIN : null;
}

async function runCodexOnce(
  bin: string,
  prompt: string,
  outPath: string,
  refPaths: string[],
  size: string
): Promise<void> {
  const absOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const instruction = [
    "画像生成ツール(image_gen)で、---PROMPT--- 以下のプロンプトから画像を1枚生成し、",
    `${absOut} に保存してください。`,
    `アスペクト比は ${size}。プロンプトは逐語で使用し、要約・翻訳・改変しないこと。`,
    refPaths.length > 0
      ? "添付画像はキャラクター・画風の参照として必ず使用すること。"
      : "",
    "成功したら保存先の絶対パスのみを出力してください。",
    "---PROMPT---",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");

  const args = ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"];
  for (const r of refPaths) args.push("-i", path.resolve(r));
  args.push("--", instruction);

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.stderr.on("data", (d) => (buf += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CodexError(`codex タイムアウト(${CODEX_TIMEOUT_MS}ms)`, false));
    }, CODEX_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new CodexError(`codex 起動失敗: ${String(e)}`, false));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new CodexError(
            `codex 終了コード ${code}: ${buf.slice(-500)}`,
            RATE_LIMIT_RE.test(buf)
          )
        );
      } else {
        resolve(buf);
      }
    });
  });

  if (!fs.existsSync(absOut) || fs.statSync(absOut).size === 0) {
    throw new CodexError(
      `codex は成功終了したが出力ファイルが存在しません: ${absOut} — ${output.slice(-300)}`,
      RATE_LIMIT_RE.test(output)
    );
  }
}

export async function generateViaCodex(opts: {
  prompt: string;
  outPath: string;
  refPaths?: string[];
  size?: string;
  n?: number;
}): Promise<string[]> {
  const bin = resolveCodexBin();
  if (!bin) {
    throw new CodexError("codex CLI が見つかりません(CODEX_BIN で指定可)", false);
  }
  const n = opts.n ?? 1;
  const saved: string[] = [];
  for (let i = 0; i < n; i++) {
    const out =
      n === 1
        ? opts.outPath
        : opts.outPath.replace(/(\.[a-z]+)$/i, `-${i + 1}$1`);
    await runCodexOnce(bin, opts.prompt, out, opts.refPaths ?? [], opts.size ?? "1:1");
    saved.push(out);
    console.error(`saved: ${out} (provider: codex)`);
  }
  return saved;
}
