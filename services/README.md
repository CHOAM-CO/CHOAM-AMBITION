# Box services (outside the Node API)

These run on the Windows box next to the API and are not deployed by `deploy/pull.ps1`; they are kept here so the repo has the full stack.

- `asr/` - Qwen3-ASR-1.7B HTTP server on `127.0.0.1:8790` (`POST /transcribe?lang=auto|ko|en&context=...`). Auto mode resolves only to Korean or English (non-ko/en detections are re-run forced to Korean, Han characters stripped, short noise returns empty). Lives at `D:\ambition\asr`, scheduled task `ambition-asr` (`task.ps1`), GPU0. `setup.ps1` builds the venv, `dl.py` fetches the model.
- `tts/setup.ps1` - fetches the Korean Pocket-TTS 100M int8 ONNX model and the `sera` voice into `D:\ambition\tts`. The engine itself is `server/tts/` (onnxruntime-node, CPU worker pool).
