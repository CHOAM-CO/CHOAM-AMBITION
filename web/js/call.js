// Call mode: Silero VAD (@ricky0123/vad-web) + backend ASR for the viewer's speech, and a gapless
// TTS player for the agent's streamed sentences (with speechSynthesis as the per-sentence fallback).
import { CONFIG } from './events.js?v=r23';
import { api } from './api.js?v=r23';
import { loadOrt, loadScript, ORT_BASE } from './ort.js?v=r23';
import { Voice } from './voice.js?v=r23';

const VAD_VER = '0.0.29';
const VAD_BASE = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_VER}/dist/`;

/** 16 kHz mono float32 -> 16-bit PCM wav (most widely accepted by ASR backends) */
export function encodeWav16(f32, sr = 16000) {
  const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

const norm = (t) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const YES_LONG = /^(넘겨|넘어가|스킵|좋아|좋죠|그래|그럼|맞아|맞어|맞다|오케이|ok|yes|yeah|yep|sure|찾아)/i;
const YES_SHORT = /^(응+|으응|네+|넹|예+|어+)$/; // one-syllable acknowledgements only count as a whole word ("어떻게" is not a yes)
const NO_TOK = /^(아니|아냐|아뇨|싫어|싫다|계속|됐어|됐다|괜찮|그냥|no+$|nope|nah|노$)/i;
/** while a yes/no question is open, any utterance is the answer: keyword match, the earliest keyword wins. 'yes' | 'no' | null */
export function matchAnswer(text) {
  const toks = String(text || '').trim().split(/\s+/).map(norm).filter(Boolean);
  for (const w of toks) {
    if (NO_TOK.test(w)) return 'no';
    if (YES_LONG.test(w) || YES_SHORT.test(w)) return 'yes';
  }
  return null;
}
/** the agent's own voice picked up by the mic: share of the heard text's char bigrams found in what the agent just said */
export function isEchoText(heard, lastAgent) {
  const h = norm(heard), a = norm(lastAgent);
  if (h.length < 4 || !a) return false;
  if (a.includes(h)) return true;
  const grams = new Set(); for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2));
  let hit = 0; const n = h.length - 1;
  for (let i = 0; i < n; i++) if (grams.has(h.slice(i, i + 2))) hit++;
  return hit / n >= CONFIG.call.echoOverlap;
}

/** mic -> VAD. onSpeechEnd gets a wav Blob. */
export class VadMic {
  constructor(h) { this.h = h; this.vad = null; this.muted = false; this.ready = false; }
  async start() {
    await loadOrt();
    await loadScript(`https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_VER}/dist/bundle.min.js`);
    const c = CONFIG.call;
    this.vad = await window.vad.MicVAD.new({
      model: 'v5', baseAssetPath: VAD_BASE, onnxWASMBasePath: ORT_BASE,
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      positiveSpeechThreshold: c.positiveThreshold, negativeSpeechThreshold: c.negativeThreshold,
      redemptionMs: c.redemptionMs, minSpeechMs: c.minSpeechMs, preSpeechPadMs: c.preSpeechPadMs,
      onSpeechStart: () => this.h.onSpeechStart(),
      onSpeechRealStart: () => this.h.onSpeechRealStart(),
      onVADMisfire: () => this.h.onMisfire(),
      onFrameProcessed: (p, frame) => { if (this.h.onFrame) this.h.onFrame(p, frame); },
      onSpeechEnd: (audio) => this.h.onSpeechEnd(encodeWav16(audio)),
    });
    this.ready = true;
    if (!this.muted) await this.vad.start();
  }
  /** while the agent's TTS plays: stricter VAD (its own sound leaks into the mic) */
  setSpeaking(on) {
    if (!this.vad || !this.vad.setOptions) return;
    const c = CONFIG.call, sp = c.speaking;
    try { this.vad.setOptions(on ? { positiveSpeechThreshold: sp.positiveThreshold, minSpeechMs: sp.minSpeechMs } : { positiveSpeechThreshold: c.positiveThreshold, minSpeechMs: c.minSpeechMs }); } catch {}
  }
  async mute(on) { this.muted = on; if (!this.vad) return; if (on) await this.vad.pause(); else await this.vad.start(); }
}

/** the agent's voice: enqueue sentences as they stream in; fetched in parallel, scheduled back to back */
export class AgentVoice {
  constructor(onSpeaking) {
    this.onSpeaking = onSpeaking; this.ctx = null; this.q = []; this.sources = new Set();
    this.nextT = 0; this.gen = 0; this.ctl = null; this.running = false; this.speaking = false; this.synth = false;
    this.fails = 0; this.downUntil = 0; this.voice = null; this.analyser = null; this.buf = null; this.clips = new Map();
    if ('speechSynthesis' in window) {
      const pick = () => { this.voice = Voice.pickVoice(speechSynthesis.getVoices()); };
      pick(); speechSynthesis.addEventListener('voiceschanged', pick);
    }
  }

  /** call inside a user gesture (the start click) */
  unlock() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (this.ctx) {
      this.ctx.resume();
      if (!this.analyser) {
        this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 256;
        this.analyser.connect(this.ctx.destination); this.buf = new Uint8Array(this.analyser.fftSize);
      }
    }
  }

  /** output level 0..1 (TTS audio RMS; a soft wobble while the speechSynthesis fallback talks) */
  level() {
    if (this.analyser && this.sources.size) {
      this.analyser.getByteTimeDomainData(this.buf);
      let s = 0; for (const v of this.buf) { const d = (v - 128) / 128; s += d * d; }
      return Math.min(1, Math.sqrt(s / this.buf.length) * 4);
    }
    return this.synth ? 0.35 + 0.3 * Math.abs(Math.sin(performance.now() / 110)) : 0;
  }

  /** pre-fetch short canned reactions as decoded audio so they can play within a frame, with no server wait */
  async prefetch(texts) {
    if (!this.ctx) return;
    for (const t of texts) {
      if (this.clips.has(t)) continue;
      try { this.clips.set(t, await this.ctx.decodeAudioData(await api.tts(t))); } catch { /* fall back to speechSynthesis at play time */ }
    }
  }

  /** instant local reaction; skipped while the agent is already talking. returns true if it played */
  quick(text) {
    if (this.speaking) return false;
    const buf = this.clips.get(text);
    if (buf && this.ctx) { this._set(true); this._schedule(buf); return true; }
    if (!('speechSynthesis' in window)) return false;
    const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR'; u.rate = 1.1; if (this.voice) u.voice = this.voice;
    const end = () => { this.synth = false; this._maybeIdle(); };
    u.onend = end; u.onerror = end;
    this.synth = true; this._set(true); speechSynthesis.speak(u);
    return true;
  }

  enqueue(text) {
    text = (text || '').trim();
    if (!text) return;
    if (!this.ctl) this.ctl = new AbortController();
    this.q.push({ text, p: this._fetch(text, this.ctl.signal) });
    this._set(true); // 'speaking' from the moment audio is on its way (keeps the video ducked)
    this._run();
  }

  /** a sentence whose audio arrived inline (POST /api/voice/talk: base64 wav, or error -> fetch it from /api/tts). Kept in seq order. */
  enqueueAudio(seq, sentence, b64) {
    if (!this.ctl) this.ctl = new AbortController();
    const signal = this.ctl.signal;
    let p;
    if (b64 && this.ctx) {
      const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      p = this.ctx.decodeAudioData(u8.buffer).catch(() => this._fetch(sentence, signal));
    } else p = this._fetch(sentence, signal);
    const it = { text: sentence, seq, p };
    let i = this.q.length; while (i > 0 && this.q[i - 1].seq != null && this.q[i - 1].seq > seq) i--;
    this.q.splice(i, 0, it);
    this._set(true); this._run();
  }

  async _fetch(text, signal) {
    if (!this.ctx || performance.now() < this.downUntil) return null; // TTS recently failing: straight to the fallback
    try {
      const ab = await api.tts(text, signal);
      const buf = await this.ctx.decodeAudioData(ab);
      this.fails = 0;
      return buf;
    } catch (e) {
      if (signal.aborted) return 'aborted';
      if (++this.fails >= 2) this.downUntil = performance.now() + 60000;
      return null;
    }
  }

  async _run() {
    if (this.running) return;
    this.running = true;
    const gen = this.gen;
    try {
      while (this.q.length && gen === this.gen) {
        const it = this.q[0], buf = await it.p;
        if (gen !== this.gen) break;
        this.q.shift();
        if (buf === 'aborted') break;
        if (buf) this._schedule(buf); else await this._fallback(it.text, gen);
      }
    } finally { this.running = false; }
    if (this.q.length) this._run(); else this._maybeIdle();
  }

  _schedule(buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(this.analyser || this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.03, this.nextT); // back to back: no gap between sentences
    src.start(t); this.nextT = t + buf.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); this._maybeIdle(); };
  }

  async _drain(gen) { while (this.sources.size && gen === this.gen) await new Promise((r) => setTimeout(r, 40)); }

  async _fallback(text, gen) {
    if (!('speechSynthesis' in window)) return;
    await this._drain(gen);
    if (gen !== this.gen) return;
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 1.05; if (this.voice) u.voice = this.voice;
      const guard = setTimeout(done, 20000 + text.length * 150);
      function done() { clearTimeout(guard); resolve(); }
      u.onend = done; u.onerror = done;
      this.synth = true; speechSynthesis.speak(u);
    });
    this.synth = false;
  }

  _maybeIdle() { if (!this.q.length && !this.running && !this.sources.size && !this.synth) this._set(false); }
  _set(on) { if (on !== this.speaking) { this.speaking = on; this.onSpeaking(on); } }

  /** barge-in: stop now, drop the queue */
  stop() {
    this.gen++;
    if (this.ctl) { this.ctl.abort(); this.ctl = null; }
    this.q = [];
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear(); this.nextT = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.synth = false;
    this._set(false);
  }
}
