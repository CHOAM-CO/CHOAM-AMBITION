import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import * as store from './store.mjs';
import { analyzeCrop, summarize, linksFor, visionModel, summaryModel } from './ai.mjs';
import * as yt from './youtube.mjs';
import { handleChat } from './chat.mjs';
import { handleVoiceTurn, handleVoiceTalk } from './voice.mjs';
import { transcribe } from './asr.mjs';
import { ttsRoute } from '../tts/index.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', ...headers });
  res.end(buf);
}

async function readJson(req) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > config.maxBodyBytes) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

async function readRaw(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > config.maxBodyBytes) throw new HttpError(413, 'body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

// STT: raw audio -> local Qwen3-ASR service on the box
async function handleAsr(req, url) {
  const t0 = Date.now();
  const audio = await readRaw(req);
  if (!audio.length) throw new HttpError(400, 'empty audio body');
  const j = await transcribe(audio, { lang: url.searchParams.get('lang') || 'auto', context: url.searchParams.get('context') || '', contentType: req.headers['content-type'] || 'application/octet-stream' });
  return { ...j, totalMs: Date.now() - t0 };
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const normLabel = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
const imageUrl = (sid, cid) => `/api/img/${sid}/${cid}.jpg`;

async function listVideos() {
  let files = [];
  try { files = await fsp.readdir(config.mediaDir); } catch { /* no media dir */ }
  const mp4 = files.filter((f) => f.toLowerCase().endsWith('.mp4')).sort().map((f) => ({
    id: f.replace(/\.mp4$/i, ''),
    title: f.replace(/\.mp4$/i, '').replace(/[_-]+/g, ' ').trim(),
    url: `/media/${encodeURIComponent(f)}`,
    source: 'mp4',
  }));
  return [...await yt.listYoutube(), ...mp4];
}

async function handleCapture(body) {
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const t0 = Date.now();
  let jpeg, ytInfo = null;
  if (body.image) {
    const m = /^data:image\/jpe?g;base64,(.+)$/s.exec(body.image || '');
    if (!m) throw new HttpError(400, 'image must be a data:image/jpeg;base64 URL');
    jpeg = Buffer.from(m[1], 'base64');
    if (jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, 'image is not a valid JPEG');
  } else if (body.youtubeId) {
    if (!yt.validYtId(body.youtubeId)) throw new HttpError(400, 'invalid youtubeId');
    try { const r = await yt.cropFrame(body.youtubeId, body.videoTime, body.gaze); jpeg = r.jpeg; ytInfo = { youtubeId: body.youtubeId, ...r.crop, seekedTo: r.t }; }
    catch (e) {
      if (e instanceof yt.NotCachedError) throw new HttpError(409, 'not_cached');
      throw e.status ? e : new HttpError(500, `frame extraction failed: ${e.message}`);
    }
  } else throw new HttpError(400, 'image or youtubeId required');
  const tCrop = Date.now() - t0;

  const captureId = store.newId('c');
  const meta = {
    captureId, sessionId: session.id, videoUrl: body.videoUrl ?? session.videoUrl, videoTime: num(body.videoTime),
    capturedAt: body.capturedAt ?? new Date().toISOString(), receivedAt: new Date().toISOString(),
    kind: body.kind === 'saccade' ? 'saccade' : 'fixation', dwellMs: num(body.dwellMs),
    gaze: { x: num(body.gaze?.x), y: num(body.gaze?.y) }, imageUrl: imageUrl(session.id, captureId),
    bytes: jpeg.length, alternatives: [], item: null, clear: false, confidence: 0, query: null,
    ...(ytInfo ? { youtube: ytInfo } : {}), cropMs: tCrop,
  };
  // 1) persist image + metadata first, so a vision failure never loses the capture
  await store.saveCapture(meta, jpeg);
  await store.withSession(session.id, async () => {
    const s = await store.getSession(session.id);
    s.captureIds.push(captureId);
    await store.saveSession(s);
  });

  // 2) vision
  let v = null;
  try { v = await analyzeCrop(jpeg, session.labels || []); } catch (e) { meta.visionError = String(e.message || e).slice(0, 300); log('vision error', captureId, meta.visionError); }
  if (v) {
    meta.item = v.label ? { label: v.label, category: v.category, description: v.description } : null;
    meta.clear = !!(v.label && v.clear);
    meta.confidence = v.confidence; meta.query = meta.clear ? v.query : null;
    meta.alternatives = v.alternatives;
    meta.usage = v.usage ? { input: v.usage.input, output: v.usage.output } : undefined;
  }

  // 3) speak decision, atomic per session
  let speak = false;
  await store.withSession(session.id, async () => {
    const s = await store.getSession(session.id);
    const key = normLabel(meta.item?.label);
    const addLabel = (l) => { if (!(s.labels || (s.labels = [])).some((x) => normLabel(x) === normLabel(l))) s.labels.push(l); };
    if (meta.clear) addLabel(meta.item.label);
    for (const a of meta.alternatives) addLabel(a.label);
    const clear = meta.clear && meta.query && v?.say && meta.confidence >= 0.6;
    if (clear && Date.now() - (s.lastSpokenAt || 0) >= config.speakCooldownMs && !s.spoken.includes(key)) {
      speak = true; s.lastSpokenAt = Date.now(); s.spoken.push(key);
    }
    await store.saveSession(s);
  });
  meta.speak = speak; meta.say = speak ? v.say : null;
  meta.latencyMs = Date.now() - t0;
  await store.updateCapture(meta);
  log('capture', captureId, meta.item?.category, meta.item?.label, 'speak=' + speak, meta.latencyMs + 'ms', ytInfo ? `crop ${tCrop}ms` : '');

  return {
    captureId, imageUrl: meta.imageUrl, item: meta.item, speak, say: meta.say,
    query: meta.query, links: linksFor(meta.query, meta.item?.category),
    alternatives: meta.alternatives.map((a) => ({ label: a.label, category: a.category, description: a.description, query: a.query, say: a.say, links: linksFor(a.query, a.category) })),
  };
}

async function handleFeedback(body) {
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  if (body.answer !== 'yes' && body.answer !== 'no') throw new HttpError(400, 'answer must be "yes" or "no"');
  if (typeof body.label !== 'string' || !body.label.trim()) throw new HttpError(400, 'label required');
  const cap = await store.getCapture(body.captureId);
  if (!cap || cap.sessionId !== session.id) throw new HttpError(404, 'unknown captureId');
  const at = new Date().toISOString();
  // capture file is only written by the capture handler and this handler; serialize per session
  await store.withSession(session.id, async () => {
    const c = await store.getCapture(cap.captureId);
    (c.feedback || (c.feedback = [])).push({ label: body.label, answer: body.answer, at });
    await store.updateCapture(c);
    const s = await store.getSession(session.id);
    (s.feedback || (s.feedback = {}))[normLabel(body.label)] = { label: body.label, answer: body.answer, captureId: cap.captureId, at };
    await store.saveSession(s);
  });
  log('feedback', cap.captureId, body.label, body.answer);
  return { ok: true };
}

async function handleSummary(body) {
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const captures = await store.getCaptures(session);
  return summarize(session, captures);
}

async function route(req, res, url) {
  const p = url.pathname, method = req.method;
  if (await ttsRoute(req, res, p)) return;
  if (method === 'GET' && p === '/api/health') {
    return send(res, 200, { ok: true, models: { vision: visionModel.id, summary: summaryModel.id }, startedAt: config.startedAt });
  }
  if (method === 'GET' && p === '/api/videos') return send(res, 200, { videos: await listVideos() });
  if (method === 'POST' && p === '/api/session') {
    const b = await readJson(req);
    const s = await store.createSession({ videoUrl: b.videoUrl, videoTitle: b.videoTitle, source: b.source === 'youtube' ? 'youtube' : 'mp4' });
    return send(res, 200, { sessionId: s.id });
  }
  if (method === 'POST' && p === '/api/capture') return send(res, 200, await handleCapture(await readJson(req)));
  if (method === 'POST' && p === '/api/youtube/prefetch') {
    const r = yt.prefetch((await readJson(req)).videoId);
    return send(res, r.ok ? 200 : 400, r);
  }
  if (method === 'POST' && p === '/api/youtube/add') return send(res, 200, await yt.addVideo((await readJson(req)).url));
  if (method === 'POST' && p === '/api/youtube/remove') return send(res, 200, await yt.removeVideo((await readJson(req)).url));
  let ym;
  if (method === 'GET' && (ym = p.match(/^\/api\/youtube\/status\/([^/]+)$/))) return send(res, 200, yt.statusOf(ym[1]));
  if (method === 'POST' && p === '/api/asr') return send(res, 200, await handleAsr(req, url));
  if (method === 'POST' && p === '/api/voice/turn') return handleVoiceTurn(await readJson(req), req, res, { HttpError });
  if (method === 'POST' && p === '/api/voice/talk') {
    const audio = await readRaw(req);
    if (!audio.length) throw new HttpError(400, 'empty audio body');
    return handleVoiceTalk(audio, req, res, url, { HttpError });
  }
  if (method === 'POST' && p === '/api/chat') return send(res, 200, await handleChat(await readJson(req), { HttpError }));
  if (method === 'POST' && p === '/api/feedback') return send(res, 200, await handleFeedback(await readJson(req)));
  if (method === 'POST' && p === '/api/summary') return send(res, 200, await handleSummary(await readJson(req)));
  let m;
  if (method === 'GET' && (m = p.match(/^\/api\/session\/([^/]+)$/))) {
    const session = await store.getSession(m[1]);
    if (!session) throw new HttpError(404, 'unknown session');
    return send(res, 200, { session, captures: await store.getCaptures(session) });
  }
  if (method === 'GET' && (m = p.match(/^\/api\/img\/([^/]+)\/([^/]+?)\.jpg$/))) {
    const cap = await store.getCapture(m[2]);
    if (!cap || cap.sessionId !== m[1]) throw new HttpError(404, 'not found');
    const buf = await fsp.readFile(store.capJpg(cap.captureId));
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'public, max-age=31536000, immutable' });
    return res.end(buf);
  }
  throw new HttpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { await route(req, res, new URL(req.url, 'http://x')); }
  catch (e) {
    const status = e.status || 500;
    if (status >= 500) log('error', req.method, req.url, e.stack || e);
    if (!res.headersSent) send(res, status, { error: e.message || 'internal error' });
    else res.end();
  }
});
process.on('uncaughtException', (e) => log('uncaughtException', e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e?.stack || e));

if (!config.apiKey) log('WARNING: ANTHROPIC_API_KEY not set; vision/summary will fail');
await fsp.mkdir(path.join(config.dataDir, 'sessions'), { recursive: true });
await fsp.mkdir(path.join(config.dataDir, 'captures'), { recursive: true });
await yt.initYoutube();
server.requestTimeout = 120000;
server.listen(config.port, config.host, () => log(`ambition-api listening on ${config.host}:${config.port} vision=${visionModel.id} summary=${summaryModel.id}`));
