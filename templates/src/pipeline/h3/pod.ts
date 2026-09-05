/**
 * Pod 操作の薄いラッパー。**課金ロックを通してから** `tools/comfy-runpod/pod.mjs` を呼ぶ。
 *
 *   npm run h3:pod -- status
 *   H3_ALLOW_GPU=1 npm run h3:pod -- up
 *   npm run h3:pod -- down
 *
 * 設計 §4 の二重ロックは「run-chapter と Pod 起動」の2口である。**課金が始まるのは
 * Pod 起動の瞬間**($1.23/h・自動停止なし・二重起動ガードのみ)であり、run-chapter だけを
 * ロックしても起動そのものは素通りしていた。ここがその2口目にあたる。
 *
 * ロックするのは**課金を増やすサブコマンドだけ**(`up` / `wait-up`)。`down` / `status` /
 * `stock` / `ssh` / `tunnel` はロックしない — とくに `down` は課金を止めるための道具なので、
 * ロックで止めると「止め忘れ」より悪い「止められない」事故になる。
 *
 * `tools/comfy-runpod/` は別リポジトリである。**1バイトも変えずに呼ぶだけ**にする。
 */
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { COMFY_CLI, assertGpuAllowed } from "./config";

/** 課金を増やすサブコマンド。どちらも最終的に Pod を起動する */
const BILLING_SUBCOMMANDS = new Set(["up", "wait-up"]);

/** そのサブコマンドが GPU 課金ロックを要するか。既定(引数なし)は pod.mjs 側の status */
export function needsGpuLock(sub: string | undefined): boolean {
  return BILLING_SUBCOMMANDS.has(sub ?? "");
}

function main(): void {
  const args = process.argv.slice(2);
  const sub = args[0];
  if (needsGpuLock(sub)) assertGpuAllowed("Pod の " + sub + "(GPU の起動 = 課金の開始)");
  // 終了コードをそのまま透過させる(pod.mjs の exit 1/2 を握り潰さない)
  const r = spawnSync("node", ["pod.mjs", ...args], { cwd: COMFY_CLI, stdio: "inherit" });
  if (r.error) {
    console.error("pod.mjs を起動できません: " + r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

if (process.argv[1] && basename(process.argv[1]) === "pod.ts") main();
