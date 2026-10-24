// Call mode: Silero VAD (@ricky0123/vad-web) + backend ASR for the viewer's speech, and a gapless
// TTS player for the agent's streamed sentences (with speechSynthesis as the per-sentence fallback).
import { CONFIG } from './events.js?v=r14';
import { api } from './api.js?v=r14';
import { loadOrt, loadScript, ORT_BASE } from './ort.js?v=r14';
import { Voice } from './voice.js?v=r14';

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

/** short spoken answers to a yes/no bubble: 'yes' | 'no' | null (anything else is a normal turn) */
export function classifyAnswer(text) {
  const t = (text || '').replace(/[\s.,!?~…]+/g, '');
  if (!t || t.length > 12) return null;
  if (/(아니|아냐|됐어|괜찮)/.test(t)) return 'no';
  if (/^(네|예|응|어|맞아|맞어|좋아|그래|찾아줘|찾아봐)/.test(t)) return 'yes';
  return null;
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
      onSpeechEnd: (audio) => this.h.onSpeechEnd(encodeWav16(audio)),
    });
    this.ready = true;
    if (!this.muted) await this.vad.start();
  }
  async mute(on) { this.muted = on; if (!this.vad) return; if (on) await this.vad.pause(); else await this.vad.start(); }
}

/** the agent's voice: enqueue sentences as they stream in; fetched in parallel, scheduled back to back */
export class AgentVoice {
  constructor(onSpeaking) {
    this.onSpeaking = onSpeaking; this.ctx = null; this.q = []; this.sources = new Set();
    this.nextT = 0; this.gen = 0; this.ctl = null; this.running = false; this.speaking = false; this.synth = false;
    this.fails = 0; this.downUntil = 0; this.voice = null;
    if ('speechSynthesis' in window) {
      const pick = () => { this.voice = Voice.pickVoice(speechSynthesis.getVoices()); };
      pick(); speechSynthesis.addEventListener('voiceschanged', pick);
    }
  }

  /** call inside a user gesture (the start click) */
  unlock() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (this.ctx) this.ctx.resume();
  }

  enqueue(text) {
    text = (text || '').trim();
    if (!text) return;
    if (!this.ctl) this.ctl = new AbortController();
    this.q.push({ text, p: this._fetch(text, this.ctl.signal) });
    this._set(true); // 'speaking' from the moment audio is on its way (keeps the video ducked)
    this._run();
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
    src.buffer = buf; src.connect(this.ctx.destination);
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
