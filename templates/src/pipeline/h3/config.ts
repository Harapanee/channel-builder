/**
 * H3 のパスと設定。パス・生成の定数と、GPU 課金の二重ロックをここに集める。
 *
 * **クリップ置き場は epId ごとに分ける。** カットIDは cL01… で全エピソード共通なので、
 * 共通の置き場にすると新規エピソードで「もう生成済み」と判定され、ep015 のクリップを
 * 黙って流用したまま正常終了する。ep015-salmon だけは既存の 303本があるため
 * 従来のパスへ写像する(移すと全部再生成 = 約4.6 GPU時間の課金)。
 */
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../../..");

/** 既存クリップを持つエピソードの置き場。ここを増やす以外に既存パスを触らない */
const LEGACY_BASE: Record<string, string> = {
  "ep015-salmon": "scratchpad_gen/minimax-style/10-remake",
};

export function epBase(epId: string): string {
  return resolve(ROOT, LEGACY_BASE[epId] ?? join("scratchpad_gen/minimax-style", epId));
}

export const clipsDir = (epId: string): string => join(epBase(epId), "clips");
/** 不合格クリップの隔離先。消さずに移す(較正の材料になる) */
export const rejectedDir = (epId: string): string => join(epBase(epId), "clips-rejected");
/** 鎖の起点フレーム置き場 */
export const framesDir = (epId: string): string => join(epBase(epId), "ff");

/** 生成 CLI(ファクトリールート側) */
export const COMFY_CLI = resolve(ROOT, "../tools/comfy-runpod");

/**
 * Pod の Network Volume に保存された名前付きワークフロー。
 * **これを指定している間、下の LORA / STEPS / SAMPLER / SIGMA_SHIFT は使われない**
 * (LoRA・steps・sampler・sigma shift・音の後処理・アップスケーラーのバイパスは
 * ワークフローJSON側の値がそのまま効く)。差し込むのはプロンプト・尺・シード・サイズ・
 * 参照画像・出力名だけ。null にするとコードで結線を組む従来経路(buildT2V)へ戻る。
 *
 * 2026-08-27 ep019-pillbug から。Volume 上の実体は turbo 4step LoRA v1.1(強度1.2)/
 * steps 6 / euler / sigma shift 6·3 / SageAttention auto / 2Kアップスケーラーはバイパス済み。
 */
export const WORKFLOW: string | null = "h3_youtube_2k_fast_4step_sage";

/** 【WORKFLOW が null のときだけ効く】 */
export const LORA = {
  name: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
  strength: 1,
};
export const STEPS = 4;
/**
 * サンプラ。**turbo LoRA の推奨は euler**(lightx2v の推奨設定)。
 * ベースモデル(steps=20)の推奨は res_multistep なので、LoRA を外すときは戻すこと。
 */
export const SAMPLER = "res_multistep";
// 2026-08-25 のA/B(ep016の実送信文面10カット×4条件・43本)で、euler + sigma shift 6/3 + 1344x768 は
// このチャンネルの doodle 画風では優位に立たず、base(下の値)を維持する判断になった。
// 画風固有の結論の可能性が高いので、他チャンネルへ移植するときは測り直すこと。
// 実測と根拠: docs/superpowers/notes/2026-08-24-h3-settings-ab.md
/**
 * シグマシフト。null ならノードを生やさない(= モデル既定)。
 * **ep015〜ep017 の約700本はすべて null で焼かれている。**
 * turbo v1.1 の推奨は { video: 6, audio: 3 }。
 */
export const SIGMA_SHIFT: { video: number; audio: number } | null = null;
export const SIZE_DEFAULT = { width: 1152, height: 640 };
export const SIZE_HI = { width: 1344, height: 768 };
/** 完成品の fps。クリップが24fpsなので再サンプリングを避ける */
export const OUT_FPS = 24;

/**
 * GPU を使う操作の二重ロック。
 * factory-ui の semi / auto モードは人間ゲートを自動承認するため、
 * 「人間が止める」だけを課金の砦にできない。
 */
export function assertGpuAllowed(what: string): void {
  if (!process.env.H3_ALLOW_GPU) {
    console.error("❌ " + what + " は GPU 課金を伴います。");
    console.error("   実行するなら H3_ALLOW_GPU=1 を付けてください(manual モードでの人間の明示操作のみ)。");
    process.exit(3);
  }
}

export function podUrl(fromArg?: string): string {
  const url = fromArg ?? process.env.H3_POD_URL;
  if (!url) throw new Error("Pod の URL がありません(--url か H3_POD_URL で渡す)");
  return url;
}
