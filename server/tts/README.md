# server/tts

Korean TTS: Pocket-TTS Korean 100M int8 ONNX (onnxruntime-node, CPU) in a forked worker.
Ported from Scheherazade's onboarding/tts. Nothing here is a model weight.

Box layout (D:\ambition\tts, override with AMBITION_TTS_DIR):
- pocket-tts-ko-100m-int8.onnx (226210253 B, sha256 d944f9bb...880d, CC BY 4.0, downloaded from manifest.cjs URL)
- voices\sera.bin (conditioning, clone of a Supertonic 3 synthetic preset, OpenRAIL-M; not committed)
- node_modules\onnxruntime-node@1.30.0 (installed there so server/package-lock.json is untouched)

Endpoints (mounted by one line in src/index.mjs):
- POST /api/tts {text, voice?: "sera", speed?} -> audio/wav (24 kHz mono 16-bit). speed is accepted but ignored (engine has no tempo control).
- POST /api/tts/stream {text, voice?} -> application/x-ndjson, one line per sentence as it finishes:
  {"i":0,"n":3,"text":"...","seconds":1.8,"synthMs":420,"wav":"<base64 wav>"} ... {"done":true}
- GET /api/tts/health

Credit: Pocket-TTS (Kyutai) / Korean 100M (seastar105) / CC BY 4.0.
