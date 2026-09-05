/**
 * MiniMax H3 のフレーム数グリッド。
 * モデルは 17k+5 のフレーム数を要求する。ここは tools/comfy-runpod/lib/workflow-minimax.mjs
 * の framesForSeconds と**必ず同じ値**でなければならない(ずれると検査を通ったジョブが
 * Pod 起動後に落ちる = 課金中に判明する)。同一性は frames.test.ts が全域で照合する。
 */
export const FPS = 24;
export const TRAINED_MIN_FRAMES = 124;
export const MAX_FRAMES = 362;

export function isBelowTrainedRange(frames: number): boolean {
  return frames < TRAINED_MIN_FRAMES;
}

export function framesForSeconds(seconds: number): number {
  const raw = Math.max(5, Math.round(seconds * FPS));
  // JS の % は負を返すため正の剰余へ寄せる
  const pad = (((5 - (raw % 17)) % 17) + 17) % 17;
  const frames = raw + pad;
  if (!(seconds > 0)) throw new Error("尺は正の秒数で指定してください(レンジ外)");
  if (frames > MAX_FRAMES) {
    throw new Error(
      `${seconds}秒(${frames}フレーム)は上限レンジ外です。約15秒(${MAX_FRAMES}フレーム)までで指定してください`,
    );
  }
  return frames;
}

export function secondsForFrames(frames: number): number {
  return frames / FPS;
}
