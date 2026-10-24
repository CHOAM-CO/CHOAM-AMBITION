// Korean TTS routes. Mounted from src/index.mjs with one call: `if (await ttsRoute(req, res, p)) return;`
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createEngine } = require('./engine.cjs');
const { MODEL_FILE, DEFAULT_VOICE, CREDIT } = require('./manifest.cjs');
const { modelsPresent } = require('./models.cjs');

const DIR = process.env.AMBITION_TTS_DIR || 'D:\\ambition\\tts';
const MAX_CHARS = 800;
const MAX_BODY = 64 * 1024;
const log = (...a) => console.log(new Date().toISOString(), 'tts', ...a);

let engine = null;
function getEngine() {
  if (!engine) engine = createEngine(path.join(DIR, MODEL_FILE), { voicesDir: path.join(DIR, 'voices'), threads: Number(process.env.AMBITION_TTS_THREADS || 4) });
  return engine;
}

// Sentence split for /stream: break after . ! ? 。 … or newline, merge fragments shorter than 6 chars into the next one.
export function splitSentences(text) {
  const raw = text.replace(/\r/g, '').match(/[^.!?。…\n]+(?:[.!?。…]+["'”’)\]]*|\n+|$)/g) || [];
  const out = [];
  let carry = '';
  for (const r of raw) {
    const t = (carry + ' ' + r).trim();
    if (!t) continue;
    if (t.replace(/[\s.!?。…]/g, '').length < 6) { carry = t; continue; }
    out.push(t); carry = '';
  }
  if (carry) out.length ? (out[out.length - 1] += ' ' + carry) : out.push(carry);
  return out;
}

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
const bad = (status, msg) => Object.assign(new Error(msg), { status });
function jsonOut(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}
function parse(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw bad(400, 'text required');
  if (text.length > MAX_CHARS) throw bad(413, `text too long (max ${MAX_CHARS} chars)`);
  return { text, voice: typeof body.voice === 'string' && body.voice ? body.voice : DEFAULT_VOICE };
}

// Start loading the model shortly after boot so the first request is not cold.
if (process.env.AMBITION_TTS_PRELOAD !== '0' && modelsPresent(DIR)) {
  setTimeout(() => {
    const t0 = Date.now();
    getEngine().load().then(() => {
      log(`model loaded in ${Date.now() - t0}ms; warming`);
      return getEngine().synth('안녕하세요.').then(() => log(`warm done at ${Date.now() - t0}ms`));
    }).catch((e) => log('preload failed:', e.message));
  }, 1500).unref();
}

// Returns true when it handled the request.
export async function ttsRoute(req, res, p) {
  if (!p.startsWith('/api/tts')) return false;
  if (req.method === 'GET' && p === '/api/tts/health') {
    const e = getEngine();
    jsonOut(res, 200, { ok: true, state: e.state, error: e.lastError, modelPresent: modelsPresent(DIR), voices: e.listVoices().map((v) => v.id), credit: CREDIT });
    return true;
  }
  if (req.method !== 'POST' || (p !== '/api/tts' && p !== '/api/tts/stream')) return false;
  const { text, voice } = parse(await readBody(req));
  if (!modelsPresent(DIR)) throw bad(503, 'tts model not installed');
  const e = getEngine();

  if (p === '/api/tts') {
    const t0 = Date.now();
    const wav = await e.synth(text, voice);
    const ms = Date.now() - t0;
    log(`synth ${text.length} chars -> ${wav.length} B in ${ms}ms`);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store', 'x-tts-ms': String(ms), 'x-tts-credit': 'Pocket-TTS (Kyutai) / seastar105 ko-100m / CC BY 4.0' });
    res.end(wav);
    return true;
  }

  // /api/tts/stream: NDJSON, one line per sentence as it finishes
  const sentences = splitSentences(text);
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });
  const t0 = Date.now();
  try {
    for (let i = 0; i < sentences.length && !aborted; i++) {
      const ts = Date.now();
      const wav = await e.synth(sentences[i], voice);
      const seconds = Math.max(0, (wav.length - 44) / 2 / 24000);
      res.write(JSON.stringify({ i, n: sentences.length, text: sentences[i], seconds: +seconds.toFixed(2), synthMs: Date.now() - ts, wav: wav.toString('base64') }) + '\n');
    }
    res.end(JSON.stringify({ done: true, totalMs: Date.now() - t0 }) + '\n');
  } catch (err) {
    log('stream error', err.message);
    res.end(JSON.stringify({ error: err.message }) + '\n');
  }
  return true;
}
