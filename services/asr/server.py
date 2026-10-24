# ambition-asr: Qwen3-ASR HTTP service. GPU 0 only. Bind 127.0.0.1:8790.
import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
ROOT = r"D:\ambition\asr"
os.environ.setdefault("HF_HOME", ROOT + r"\hf")
os.environ.setdefault("TEMP", ROOT + r"\tmp")
os.environ.setdefault("TMP", ROOT + r"\tmp")
import io, json, subprocess, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import numpy as np
import torch
from qwen_asr import Qwen3ASRModel

FFMPEG = r"D:\ambition\bin\ffmpeg.exe"
MODEL = os.environ.get("ASR_MODEL", "Qwen/Qwen3-ASR-1.7B")
LANGS = {"ko": "Korean", "en": "English"}
LOCK = threading.Lock()
MAX_BYTES = 50 * 1024 * 1024

print(f"loading {MODEL} on cuda:0 ...", flush=True)
t0 = time.time()
model = Qwen3ASRModel.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda:0",
                                      max_inference_batch_size=8, max_new_tokens=512)
print(f"loaded in {time.time()-t0:.1f}s", flush=True)

def decode(data: bytes) -> np.ndarray:
    p = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                        "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                       input=data, capture_output=True, timeout=60,
                       creationflags=0x08000000)
    if p.returncode != 0 or not p.stdout:
        raise ValueError("ffmpeg decode failed: " + p.stderr.decode("utf-8", "replace")[:300])
    return np.frombuffer(p.stdout, dtype=np.float32).copy()

import re
HAN = re.compile("[\u4e00-\u9fff]")
OK_LANGS = {"korean", "english", ""}

def transcribe(wav: np.ndarray, lang, context=""):
    with LOCK, torch.inference_mode():
        r = model.transcribe(audio=(wav, 16000), context=context, language=LANGS.get(lang))[0]
        r.redone = False
        if lang is None:
            # auto may only resolve to Korean/English; anything else -> redo forced Korean (one extra pass)
            det = {x.strip().lower() for x in (r.language or "").split(",")}
            if not det <= OK_LANGS:
                r = model.transcribe(audio=(wav, 16000), context=context, language="Korean")[0]
                r.redone = True
    return r

# warmup
try:
    transcribe(np.zeros(16000, dtype=np.float32), None)
except Exception:
    traceback.print_exc()

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, fmt, *a):
        print("%s %s" % (self.address_string(), fmt % a), flush=True)
    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._send(200, {"ok": True, "model": MODEL, "device": torch.cuda.get_device_name(0)})
        else:
            self._send(404, {"error": "not found"})
    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        t0 = time.time()
        try:
            lang = parse_qs(u.query).get("lang", ["auto"])[0].lower()
            if lang not in ("auto", "ko", "en"):
                return self._send(400, {"error": "lang must be auto|ko|en"})
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BYTES:
                return self._send(400, {"error": "empty or too large body"})
            wav = decode(self.rfile.read(n))
            ctx = (parse_qs(u.query).get("context", [""])[0] or "")[:500]
            r = transcribe(wav, None if lang == "auto" else lang, ctx)
            text = HAN.sub("", r.text or "").strip()
            # very short clip that needed the Korean re-pass and yields only 1-2 chars: noise, return empty
            nw = len(re.sub(r"[\W_]", "", text))
            if nw == 0 or (r.redone and len(wav) < 9600 and nw <= 2):
                text = ""
            self._send(200, {"text": text, "lang": r.language,
                             "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": str(e)[:500]})

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", 8790), H)
    print("listening 127.0.0.1:8790", flush=True)
    srv.serve_forever()
