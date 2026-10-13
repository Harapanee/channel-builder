"""行ごとの英語音声を Kokoro で合成する。判断(収まり・話速)は呼び出し側の en-tts.ts が持つ。

使い方: python kokoro_lines.py --in lines.json --out-dir DIR --voice am_adam --lang en-us [--jobs 4]
--jobs: 行を N 個のプロセスに分けて並列に合成する(1本約1時間 → 約1/N。2026-10-12 ep063 で導入)
入力: [{"id": "L01", "text": "...", "speed": 1.0}, ...]
出力: DIR/<id>.wav(24kHz mono)と DIR/durations.json({"L01": 秒})。既存の durations.json には上書きマージする
"""
import argparse, json, os, sys
import soundfile as sf
from kokoro_onnx import Kokoro
from kokoro_onnx.config import EspeakConfig

D = os.path.expanduser("~/.cache/en-dub")
# 同梱の espeakng-loader はデータの場所が壊れているため Homebrew の espeak-ng を渡す(2026-10-12 実測)
PREFIX = "/opt/homebrew" if os.path.exists("/opt/homebrew/lib/libespeak-ng.dylib") else "/usr/local"

def load(threads: int) -> Kokoro:
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    sess = ort.InferenceSession(f"{D}/model/kokoro-v1.0.onnx", sess_options=opts)
    return Kokoro.from_session(sess, f"{D}/model/voices-v1.0.bin",
                               espeak_config=EspeakConfig(lib_path=f"{PREFIX}/lib/libespeak-ng.dylib",
                                                          data_path=f"{PREFIX}/share/espeak-ng-data"))

def work(args) -> dict:
    lines, out_dir, voice, lang, threads, tag = args
    k = load(threads)
    out = {}
    for i, l in enumerate(lines):
        audio, sr = k.create(l["text"], voice=voice, speed=float(l.get("speed", 1.0)), lang=lang)
        sf.write(os.path.join(out_dir, f"{l['id']}.wav"), audio, sr)
        out[l["id"]] = round(len(audio) / sr, 3)
        print(f"[{tag}{i + 1}/{len(lines)}] {l['id']} {out[l['id']]}s", file=sys.stderr, flush=True)
    return out

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--jobs", type=int, default=1)
    a = ap.parse_args()
    lines = json.load(open(a.inp))
    os.makedirs(a.out_dir, exist_ok=True)
    dpath = os.path.join(a.out_dir, "durations.json")
    durations = json.load(open(dpath)) if os.path.exists(dpath) else {}
    jobs = max(1, min(a.jobs, len(lines)))
    cpu = os.cpu_count() or 4
    if jobs == 1:
        durations.update(work((lines, a.out_dir, a.voice, a.lang, cpu, "")))
    else:
        import multiprocessing as mp
        chunks = [lines[i::jobs] for i in range(jobs)]
        with mp.get_context("spawn").Pool(jobs) as pool:
            for d in pool.map(work, [(c, a.out_dir, a.voice, a.lang, max(1, cpu // jobs), f"{j}:") for j, c in enumerate(chunks)]):
                durations.update(d)
    json.dump(durations, open(dpath, "w"), indent=1)
    return 0

if __name__ == "__main__":
    sys.exit(main())
