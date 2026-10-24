// Thin API client. ?mock=1 swaps every /api call for local fake responses.
import { mockApi } from './mock.js?v=r17';

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
async function asr(blob, context) {
  if (MOCK) return mockApi('POST', '/api/asr', null);
  const r = await fetch('/api/asr?lang=auto' + (context ? '&context=' + encodeURIComponent(String(context).slice(0, 500)) : ''), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
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

let talkOk = null; // null = unknown, false = server has no /api/voice/talk (404): use asr + turn
/** POST /api/voice/talk (wav in; NDJSON out incl. per-sentence audio). Resolves true when it ran, false when the endpoint does not exist.
 *  Throws an Error with .status/.body on other failures (404 with a sessionId error means the session is unknown). */
async function talk(wav, params, signal, onEvent) {
  if (MOCK || talkOk === false) return false;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const r = await fetch('/api/voice/talk?' + q, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, signal });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    if (r.status === 404 && !/session/i.test(JSON.stringify(body || {}))) { talkOk = false; return false; }
    const err = new Error(`talk ${r.status}`); err.status = r.status; err.body = body; throw err;
  }
  talkOk = true;
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
  return true;
}

export const api = {
  asr, tts, turn, talk,
  health: () => call('GET', '/api/health'),
  videos: () => call('GET', '/api/videos'),
  addVideo: (url) => call('POST', '/api/youtube/add', { url }),
  session: (b) => call('POST', '/api/session', b),
  capture: (b) => call('POST', '/api/capture', b),
  summary: (b) => call('POST', '/api/summary', b),
  chat: (b) => call('POST', '/api/chat', b),
  scene: async (b) => { const r = await fetch('/api/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json().catch(() => null); if (!r.ok) { const e = new Error('scene ' + r.status); e.status = r.status; e.body = j; throw e; } return j; },
  scenes: async (sessionId) => { const r = await fetch('/api/scene?sessionId=' + encodeURIComponent(sessionId)); if (!r.ok) throw new Error('scenes ' + r.status); return r.json(); },
  feedback: (b) => call('POST', '/api/feedback', b).catch(() => {}), // fire and forget, endpoint may 404
};
