#!/usr/bin/env bash
# 英語版の TTS(Kokoro-82M・Apache-2.0)を ~/.cache/en-dub/ に用意する。冪等。
set -euo pipefail
D="$HOME/.cache/en-dub"
mkdir -p "$D/model"
command -v espeak-ng >/dev/null || brew install espeak-ng
[ -x "$D/.venv/bin/python" ] || uv venv -q -p 3.12 "$D/.venv"
uv pip install -q -p "$D/.venv/bin/python" "kokoro-onnx==0.6.1" "soundfile==0.13.1"
BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -s "$D/model/kokoro-v1.0.onnx" ] || curl -sSL -o "$D/model/kokoro-v1.0.onnx" "$BASE/kokoro-v1.0.onnx"
[ -s "$D/model/voices-v1.0.bin" ] || curl -sSL -o "$D/model/voices-v1.0.bin" "$BASE/voices-v1.0.bin"
# MLX 版(Apple GPU・約20倍速。既定のエンジン)。arm64 の Python と arm64 Homebrew の espeak-ng を使う
/opt/homebrew/bin/brew list espeak-ng >/dev/null 2>&1 || /opt/homebrew/bin/brew install espeak-ng
[ -x "$D/mlx-venv/bin/python" ] || uv venv -q -p cpython-3.12-macos-aarch64-none "$D/mlx-venv"
uv pip install -q -p "$D/mlx-venv/bin/python" "mlx-audio==0.5.8" "misaki[en]==0.9.4" "soundfile==0.13.1" \
  "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
echo "OK: $D"
