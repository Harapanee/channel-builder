"""行ごとの英語音声を Kokoro(MLX・Apple GPU)で合成する。kokoro_lines.py(onnx・CPU)と同じ入出力。

onnx 版は x86 Python(Rosetta)で実時間の約0.2倍しか出ず、1本約50分かかった。MLX 版は M1 の GPU で
実時間の約4〜5倍(約20倍速。2026-10-12 実測・ユーザーが聞き比べで同等と判断して切り替え)。

使い方: python kokoro_mlx_lines.py --in lines.json --out-dir DIR --voice am_adam --lang en-us [--jobs N(無視)]
出力: DIR/<id>.wav(24kHz mono)と DIR/durations.json(既存にマージ)
MLX の出力は前に約0.3秒・後ろに約0.65秒の無音が付く(onnx 版は数十ミリ秒)。行の尺の判定がずれるので削って揃える。
"""
import argparse, json, os, sys
import numpy as np

# 同梱の espeakng-loader はデータの場所が CI のパスに固定されていて動かない。arm64 Homebrew の espeak-ng を使う
import espeakng_loader
espeakng_loader.get_library_path = lambda: "/opt/homebrew/lib/libespeak-ng.dylib"
espeakng_loader.get_data_path = lambda: "/opt/homebrew/share/espeak-ng-data"
from phonemizer.backend.espeak.wrapper import EspeakWrapper
EspeakWrapper.set_library("/opt/homebrew/lib/libespeak-ng.dylib")
EspeakWrapper.set_data_path("/opt/homebrew/share/espeak-ng-data")

import soundfile as sf
from mlx_audio.tts.utils import load_model

SR = 24000
MODEL = "prince-canuma/Kokoro-82M"
LANG = {"en-us": "a", "en-gb": "b"}
TH = 0.01                 # これを超える振幅を音とみなす
KEEP_LEAD, KEEP_TAIL = 0.03, 0.06  # onnx 版と同程度の前後の余白(秒)

def trim(a: np.ndarray) -> np.ndarray:
    idx = np.nonzero(np.abs(a) > TH)[0]
    if len(idx) == 0:
        return a
    s = max(0, idx[0] - int(KEEP_LEAD * SR))
    e = min(len(a), idx[-1] + 1 + int(KEEP_TAIL * SR))
    return a[s:e]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--jobs", type=int, default=1)  # GPU 1本で回すので使わない(onnx 版と CLI を揃えるため受けるだけ)
    ap.add_argument("--model-dir", default=MODEL)
    a = ap.parse_args()
    lines = json.load(open(a.inp))
    os.makedirs(a.out_dir, exist_ok=True)
    dpath = os.path.join(a.out_dir, "durations.json")
    durations = json.load(open(dpath)) if os.path.exists(dpath) else {}
    model = load_model(a.model_dir, model_type="kokoro")
    for i, l in enumerate(lines):
        chunks = [np.array(r.audio) for r in model.generate(text=l["text"], voice=a.voice, speed=float(l.get("speed", 1.0)), lang_code=LANG[a.lang])]
        audio = trim(np.concatenate(chunks).astype(np.float32))
        sf.write(os.path.join(a.out_dir, f"{l['id']}.wav"), audio, SR)
        durations[l["id"]] = round(len(audio) / SR, 3)
        print(f"[{i + 1}/{len(lines)}] {l['id']} {durations[l['id']]}s", file=sys.stderr, flush=True)
    json.dump(durations, open(dpath, "w"), indent=1)
    return 0

if __name__ == "__main__":
    sys.exit(main())
