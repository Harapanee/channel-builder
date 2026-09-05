/**
 * 生成クリップの機械指標。
 * 既存の映像ゲート(freezedetect / blackdetect)は生成AI特有の破綻を1件も検出しない
 * (実測ゼロ)。ここで取る値は「疑わしいクリップに当たりを付ける」ためだけに使い、
 * 合否は h3-clip-inspector が目で見て決める。
 *
 * **signalstats は単体では何も出力しない。** フィルタはフレームのメタデータを立てる
 * だけで、`metadata=print` を連結して初めて標準エラーへ出る
 * (実測: cL01 で連結なし0行 → 連結あり123行)。ここを間違えると全クリップの指標が
 * ゼロになり、検品も較正も静かに壊れる(0という数字が出るので気づけない)。
 */
import { spawnSync } from "node:child_process";

export interface ClipMetrics {
  /** コンテナが申告するフレーム数(ffprobe の nb_frames)。**実際に読める数とは限らない** */
  frames: number;
  /**
   * 実際にデコードできたフレーム数。
   * ダウンロード切れの mp4 はコンテナのヘッダを完全なまま持つため `frames` は正しい値を返す
   * (実測: 12%へ切り詰めた cL01 が nb_frames=124 のまま、実デコードは7コマ)。
   * `-count_frames` で数え直すと全デコードが3回目になるので、`tblend` の出力コマ数
   * (= 実デコード数 - 1)から導く。ここは measureClip がすでに払ったコストの副産物である。
   */
  decodedFrames: number;
  durationSec: number;
  width: number;
  height: number;
  /** フレーム間差分の平均輝度。動きの量。0 に近いほど止まっている */
  frameDiffMean: number;
  /** フレーム間差分の最大。突然の切り替わり(モーフィング・別物化)の目印 */
  frameDiffMax: number;
  /** 差分を取れたフレーム数。0 なら計測失敗 */
  diffSamples: number;
  /** 0.5秒ごとの輝度std。低いほど平坦(紙だけの画面) */
  lumaStd: number[];
}

const SAMPLE_W = 128;
const SAMPLE_H = 72;

/** metadata=print の標準エラー出力から、フレーム間差分の平均・最大・標本数を取る */
export function parseSignalstats(stderr: string): { frameDiffMean: number; frameDiffMax: number; samples: number } {
  const vals = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  if (vals.length === 0) return { frameDiffMean: 0, frameDiffMax: 0, samples: 0 };
  return {
    frameDiffMean: vals.reduce((a, b) => a + b, 0) / vals.length,
    frameDiffMax: Math.max(...vals),
    samples: vals.length,
  };
}

/** グレースケール生バッファ(w*h バイト/フレームの連結)から、フレームごとの輝度stdを出す */
export function parseLumaSamples(raw: Buffer, w: number, h: number): number[] {
  const size = w * h;
  const out: number[] = [];
  for (let off = 0; off + size <= raw.length; off += size) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += raw[off + i];
    const mean = sum / size;
    let acc = 0;
    for (let i = 0; i < size; i += 1) acc += (raw[off + i] - mean) ** 2;
    out.push(Math.sqrt(acc / size));
  }
  return out;
}

/** クリップ尺から、先頭〜末尾まで等間隔の抜き出し時刻(既定5点)を返す */
export function stripTimes(durationSec: number, n = 5): number[] {
  const last = Math.max(0, durationSec - 0.1);
  if (n === 1) return [0];
  return Array.from({ length: n }, (_, i) => (last * i) / (n - 1));
}

/** ffmpeg / ffprobe の失敗を黙って通さない(通すと NaN が指標として流れる)。文字列出力版 */
function runText(cmd: string, args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} の起動に失敗: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} が失敗(${r.status}): ${r.stderr.slice(0, 400)}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

/** 同上・バイナリ出力版(輝度サンプリングの rawvideo 取得用) */
function runBuffer(cmd: string, args: string[]): { stdout: Buffer; stderr: Buffer } {
  const r = spawnSync(cmd, args, { maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} の起動に失敗: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} が失敗(${r.status}): ${r.stderr.toString("utf8").slice(0, 400)}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

function probe(mp4: string): { frames: number; durationSec: number; width: number; height: number } {
  const r = runText("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_frames", "-show_entries", "format=duration",
    "-of", "default=nw=1", mp4,
  ]);
  const get = (k: string) => Number(new RegExp(`^${k}=([\\d.]+)`, "m").exec(r.stdout)?.[1] ?? NaN);
  const out = { frames: get("nb_frames"), durationSec: get("duration"), width: get("width"), height: get("height") };
  if (!Number.isFinite(out.durationSec)) throw new Error(`${mp4}: ffprobe が尺を返さない`);
  return out;
}

export function measureClip(mp4: string): ClipMetrics {
  const base = probe(mp4);
  const diff = runText("ffmpeg", [
    "-v", "info", "-nostats", "-i", mp4,
    "-vf", "format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ]);
  const stats = parseSignalstats(diff.stderr);
  if (stats.samples === 0) {
    throw new Error(`${mp4}: フレーム間差分が1件も取れない(metadata=print の連結を確認する)`);
  }
  const luma = runBuffer("ffmpeg", [
    "-v", "error", "-i", mp4,
    "-vf", `fps=2,scale=${SAMPLE_W}:${SAMPLE_H},format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ]);
  return {
    ...base,
    // tblend は1コマ目に相手がいないので出力は「実デコード数 - 1」になる
    // (実測: 124コマの cL01 で123件、7コマへ切り詰めたコピーで6件)。全デコードは
    // すでに済んでいるので、実デコード数はここでタダで取れる。-count_frames は足さない
    decodedFrames: stats.samples + 1,
    frameDiffMean: stats.frameDiffMean,
    frameDiffMax: stats.frameDiffMax,
    diffSamples: stats.samples,
    lumaStd: parseLumaSamples(luma.stdout, SAMPLE_W, SAMPLE_H),
  };
}

/**
 * ストリップの体裁。
 * Task 9 の較正で、5コマ横並び(1コマ313px)では文字の湧きも部品の増殖も判読できないと実証された。
 * 画像の長辺上限(1568px)に収まる範囲で1コマを大きく取るために 3x2 にする(全体 1536x568)。
 */
export const STRIP = { frames: 6, cols: 3, rows: 2, cell: 512 } as const;

/**
 * 尺で決めるストリップのコマ数と並び。**2026-09-05 に追加。**
 * ep027 の検品では判定不能が42件(差し戻し30件より多い)で、その大半が「後半3コマで別構図へ飛ぶ」
 * 「中盤の跳びが6コマでは見えない」型だった。7秒を超えるカットは 9コマ 3x3 で焼く(1コマ 512px は維持)。
 */
export function stripLayout(durationSec: number): { frames: number; cols: number; rows: number } {
  return durationSec > 7 ? { frames: 9, cols: 3, rows: 3 } : { frames: STRIP.frames, cols: STRIP.cols, rows: STRIP.rows };
}

/**
 * 契約検査。**破綻の検出ではない。**
 * Task 9 の較正で、生成AI特有の破綻(文字の湧き・被写体違い・画風の逸脱・要素の欠落)を
 * 分離できる機械指標は1つも見つからなかった。ここで見るのは「申告どおりの尺と解像度で
 * 出ているか」だけで、これは誤検知ゼロで機能する(338本で実証)。
 * 破綻の判定は目視が唯一の手段である。
 *
 * **フレーム数はコンテナ申告ではなく実デコード数で見る。** ダウンロード切れの mp4 は
 * ヘッダを完全なまま持つので `nb_frames` は正しい値を返し続ける(実測: 7コマしか読めない
 * 切り詰めコピーが nb_frames=124 を申告した)。申告値だけを突き合わせると「壊れているのに緑」に
 * なり、較正 §8 が謳う「フレーム数の不一致はダウンロード切れの徴候」が成立しない。
 * 申告値と実デコード数の食い違いそのものも異常として立てる。
 */
export function contractIssues(m: ClipMetrics, expected: { frames: number; width: number }): string[] {
  const out: string[] = [];
  if (m.diffSamples === 0) out.push("計測できていない(ffmpeg の出力を確認する)");
  if (m.decodedFrames !== expected.frames) {
    out.push(`実デコードのフレーム数が ${m.decodedFrames}(申告 ${expected.frames})`);
  }
  if (m.frames !== m.decodedFrames) {
    out.push(`コンテナ申告のフレーム数 ${m.frames} と実デコード ${m.decodedFrames} が食い違う(ダウンロード切れの徴候)`);
  }
  if (m.width !== expected.width) out.push(`解像度の幅が ${m.width}(申告 ${expected.width})`);
  return out;
}

/** ストリップに使うフレーム番号。先頭から末尾まで等分し、重複を出さない */
export function stripFrameIndices(totalFrames: number, n: number = STRIP.frames): number[] {
  const last = Math.max(0, totalFrames - 1);
  const raw = n === 1 ? [0] : Array.from({ length: n }, (_, i) => Math.round((last * i) / (n - 1)));
  return [...new Set(raw)];
}
