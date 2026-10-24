// Thin API client. ?mock=1 swaps every /api call for local fake responses.
import { mockApi } from './mock.js?v=r14';

export const PARAMS = new URLSearchParams(location.search);
export const MOCK = PARAMS.get('mock') === '1';

async function call(method, path, body) {
  if (MOCK) return mockApi(method, path, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!r.ok) {
      const err = new Error(`${method} ${path} -> ${r.status}`);
      err.status = r.status;
      err.body = await r.json().catch(() => null);
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST /api/asr: wav Blob -> {text, lang, ms, totalMs} */
async function asr(blob) {
  if (MOCK) return mockApi('POST', '/api/asr', null);
  const r = await fetch('/api/asr?lang=auto', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
  if (!r.ok) throw new Error(`asr ${r.status}`);
  return r.json();
}

/** POST /api/tts -> ArrayBuffer (wav). Throws when unavailable (the caller falls back to speechSynthesis). */
async function tts(text, signal) {
  if (MOCK) return mockApi('POST', '/api/tts', { text });
  const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: 'sera' }), signal });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  return r.arrayBuffer();
}

/** POST /api/voice/turn: NDJSON stream; onEvent gets every parsed line. Abortable. */
async function turn(body, signal, onEvent) {
  if (MOCK) { await mockApi('STREAM', '/api/voice/turn', { body, signal, onEvent }); return; }
  const r = await fetch('/api/voice/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`turn ${r.status}`);
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { onEvent(JSON.parse(line)); } catch {} }
    }
  }
  if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch {} }
}

export const api = {
  asr, tts, turn,
  health: () => call('GET', '/api/health'),
  videos: () => call('GET', '/api/videos'),
  addVideo: (url) => call('POST', '/api/youtube/add', { url }),
  session: (b) => call('POST', '/api/session', b),
  capture: (b) => call('POST', '/api/capture', b),
  summary: (b) => call('POST', '/api/summary', b),
  chat: (b) => call('POST', '/api/chat', b),
  feedback: (b) => call('POST', '/api/feedback', b).catch(() => {}), // fire and forget, endpoint may 404
};
