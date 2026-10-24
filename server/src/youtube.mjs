// YouTube catalog + local cache (yt-dlp) + server-side frame crop (ffmpeg).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';

const log = (...a) => console.log(new Date().toISOString(), '[yt]', ...a);
export const validYtId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{11}$/.test(s);

const catalogFile = () => path.join(config.mediaDir, 'youtube.json');
const ytDir = () => path.join(config.mediaDir, 'yt');
export const cachedPath = (id) => path.join(ytDir(), `${id}.mp4`);

// Prefer the portable build in binDir; fall back to PATH (local dev).
export function tool(name) {
  const exe = path.join(config.binDir, process.platform === 'win32' ? `${name}.exe` : name);
  return fs.existsSync(exe) ? exe : name;
}
const toolEnv = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PATH: [path.dirname(process.execPath), config.binDir, process.env.PATH].filter(Boolean).join(path.delimiter) });

export function run(cmd, args, { timeoutMs = 120000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: toolEnv(), windowsHide: true });
    const out = []; let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} timeout`)); }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0) resolve(binary ? buf : buf.toString('utf8'));
      else reject(new Error(`${path.basename(cmd)} exit ${code}: ${err.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400)}`));
    });
  });
}

// ---- catalog ------------------------------------------------------------------------------
let catalog = [];
let chain = Promise.resolve();
const durations = new Map(); // id -> seconds (from catalog or ffprobe)
const state = new Map();     // id -> {state:'queued'|'downloading'|'error', error?, retryAt?}

async function readCatalog() {
  try {
    const j = JSON.parse(await fsp.readFile(catalogFile(), 'utf8'));
    return (Array.isArray(j) ? j : []).filter((e) => e && validYtId(e.id)).map((e) => ({ ...e, title: e.title || e.id }));
  } catch { return []; }
}
const isCached = (id) => { try { return fs.statSync(cachedPath(id)).size > 0; } catch { return false; } };

async function reloadCatalog() {
  catalog = await readCatalog();
  for (const e of catalog) if (Number.isFinite(+e.duration)) durations.set(e.id, +e.duration);
  for (const e of catalog) if (!isCached(e.id)) enqueue(e.id);
}

function addToCatalog(entry) {
  chain = chain.then(async () => {
    const cur = await readCatalog();
    if (!cur.some((e) => e.id === entry.id)) cur.push(entry);
    const tmp = `${catalogFile()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cur, null, 2));
    await fsp.rename(tmp, catalogFile());
    catalog = cur;
  }).catch((e) => log('catalog write failed', e.message));
  return chain;
}

// ---- download queue (never blocks requests) -------------------------------------------------
export const MAX_DURATION_S = 30 * 60; // refuse longer videos (disk)
const queue = []; let active = 0; const MAX_ACTIVE = 2; const RETRY_MS = 5 * 60 * 1000;

function enqueue(id, { addAfter = false } = {}) {
  const st = state.get(id);
  if (st && (st.state === 'queued' || st.state === 'downloading')) return;
  if (st?.state === 'error' && st.retryAt > Date.now() && !addAfter) return;
  state.set(id, { state: 'queued' });
  queue.push({ id, addAfter });
  pump();
}
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift(); active++;
    download(job).catch((e) => log('job crashed', e.message)).finally(() => { active--; pump(); });
  }
}

async function download({ id, addAfter }) {
  state.set(id, { state: 'downloading' });
  try {
    await fsp.mkdir(ytDir(), { recursive: true });
    if (!isCached(id)) {
      const t0 = Date.now();
      await run(tool('yt-dlp'), [
        '--no-playlist', '--no-progress', '--newline', '--no-warnings', '--match-filter', `duration<=?${MAX_DURATION_S} & !is_live`,
        '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location', config.binDir, '--cache-dir', config.ytCacheDir,
        // <=720p, video-only, h264 preferred (fast ffmpeg seeks)
        '-f', 'bv*[height<=720][vcodec^=avc1][ext=mp4]/bv*[height<=720][ext=mp4]/b[height<=720][ext=mp4]/b[height<=720]',
        '--merge-output-format', 'mp4', '-o', cachedPath(id), `https://www.youtube.com/watch?v=${id}`,
      ], { timeoutMs: 20 * 60 * 1000 });
      if (!isCached(id)) throw new Error('download finished but file missing');
      log('cached', id, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (addAfter) {
      let meta = { id };
      try {
        const [title, channel, dur] = (await run(tool('yt-dlp'), ['--no-playlist', '--skip-download', '--js-runtimes', `node:${process.execPath}`, '--cache-dir', config.ytCacheDir,
          '--print', '%(title)s\n%(channel)s\n%(duration)s', `https://www.youtube.com/watch?v=${id}`], { timeoutMs: 60000 })).split(/\r?\n/);
        meta = { id, title, channel, duration: Number(dur) || undefined };
      } catch (e) { log('metadata failed', id, e.message); meta.title = id; }
      await addToCatalog(meta);
      if (meta.duration) durations.set(id, meta.duration);
    }
    state.delete(id);
  } catch (e) {
    log('download failed', id, e.message);
    state.set(id, { state: 'error', error: e.message, retryAt: Date.now() + RETRY_MS });
  }
}

export function prefetch(id) {
  if (!validYtId(id)) return { ok: false, error: 'invalid videoId' };
  const inCatalog = catalog.some((e) => e.id === id);
  if (isCached(id) && inCatalog) return { ok: true, videoId: id, cached: true, queued: false };
  enqueue(id, { addAfter: !inCatalog });
  return { ok: true, videoId: id, cached: isCached(id), queued: true };
}
// Any YouTube URL form (watch?v=, youtu.be/, shorts/, embed/, live/) or a raw 11-char id.
export function parseYtInput(input) {
  const s = String(input || '').trim();
  let m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (!m && /^[\w-]{11}$/.test(s)) m = [s, s];
  return m ? m[1] : null;
}
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

async function fetchMeta(id) {
  try {
    const [title, channel, dur] = (await run(tool('yt-dlp'), ['--no-playlist', '--skip-download', '--no-warnings', '--js-runtimes', `node:${process.execPath}`, '--cache-dir', config.ytCacheDir,
      '--print', '%(title)s\n%(channel)s\n%(duration)s', `https://www.youtube.com/watch?v=${id}`], { timeoutMs: 45000 })).split(/\r?\n/);
    return { title, channel, duration: Number(dur) || undefined };
  } catch (e) {
    log('metadata failed', id, e.message);
    try { // oEmbed fallback: title/author only (duration then enforced by --match-filter at download)
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { const j = await r.json(); return { title: j.title, channel: j.author_name }; }
    } catch { /* ignore */ }
    return {};
  }
}

// Add a video by URL: persists to the catalog right away, starts the download, returns the card (cached:false until done).
export async function addVideo(input) {
  const id = parseYtInput(input);
  if (!id) throw httpErr(400, 'not a YouTube URL or id');
  let existing = catalog.find((e) => e.id === id);
  const existed = !!existing;
  if (!existing) {
    const meta = await fetchMeta(id);
    if (meta.duration && meta.duration > MAX_DURATION_S) throw httpErr(422, `video too long (${Math.round(meta.duration / 60)} min, max ${MAX_DURATION_S / 60})`);
    existing = { id, title: meta.title || id, ...(meta.channel ? { channel: meta.channel } : {}), ...(meta.duration ? { duration: meta.duration } : {}), addedAt: Date.now() };
    await addToCatalog(existing);
    if (meta.duration) durations.set(id, meta.duration);
    log('added', id, existing.title);
  }
  if (!isCached(id)) enqueue(id, { addAfter: false });
  return { ok: true, existing: existed, video: (await listYoutube()).find((v) => v.id === id) };
}

export function removeVideo(input) {
  const id = parseYtInput(input);
  if (!id) throw httpErr(400, 'not a YouTube URL or id');
  chain = chain.then(async () => {
    const cur = (await readCatalog()).filter((e) => e.id !== id);
    const tmp = `${catalogFile()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cur, null, 2));
    await fsp.rename(tmp, catalogFile());
    catalog = cur; state.delete(id);
  }).catch((e) => log('catalog write failed', e.message));
  return chain.then(() => ({ ok: true, removed: id }));
}

export const statusOf = (id) => ({ videoId: id, cached: isCached(id), ...(state.get(id) || { state: isCached(id) ? 'cached' : 'unknown' }) });

export async function initYoutube() {
  await fsp.mkdir(ytDir(), { recursive: true });
  await reloadCatalog();
  fs.watchFile(catalogFile(), { interval: 5000 }, () => { reloadCatalog().catch((e) => log('reload failed', e.message)); });
  log(`catalog ${catalog.length} videos, cached ${catalog.filter((e) => isCached(e.id)).length}`);
}

async function probe(f) {
  const out = await run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f], { timeoutMs: 20000 });
  const j = JSON.parse(out);
  const info = { w: j.streams?.[0]?.width, h: j.streams?.[0]?.height, duration: Number(j.format?.duration) };
  if (Number.isFinite(info.duration)) durations.set(f, info.duration);
  return info;
}
const probeCache = new Map();
const getInfoFile = (f) => { if (!probeCache.has(f)) probeCache.set(f, probe(f).catch((e) => { probeCache.delete(f); throw e; })); return probeCache.get(f); };
const getInfo = (id) => getInfoFile(cachedPath(id));

export async function listYoutube() {
  const out = [];
  const ordered = [...catalog].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); // user-added first, newest first
  for (const e of ordered) {
    const cached = isCached(e.id);
    let duration = durations.get(e.id) ?? null;
    if (duration == null && cached) { try { duration = (await getInfo(e.id)).duration; } catch { /* ignore */ } }
    out.push({
      id: e.id, title: e.title, ...(e.channel ? { channel: e.channel } : {}), source: 'youtube', youtubeId: e.id,
      url: `https://www.youtube.com/watch?v=${e.id}`, thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      cached, duration: duration != null ? Math.round(duration) : null,
      ...(!cached && state.get(e.id)?.state ? { state: state.get(e.id).state, ...(state.get(e.id).error ? { error: state.get(e.id).error } : {}) } : {}),
    });
  }
  return out;
}

// ---- frame crop ---------------------------------------------------------------------------
export class NotCachedError extends Error {}

// Square crop (~55% of the short side) around the gaze point (clamped), with a semi-transparent red ring at the gaze point.
export async function cropFrame(id, videoTime, gaze) {
  if (!validYtId(id)) throw Object.assign(new Error('invalid youtubeId'), { status: 400 });
  if (!isCached(id)) throw new NotCachedError();
  return cropFile(cachedPath(id), videoTime, gaze);
}

async function cropFile(file, videoTime, gaze) {
  const { w, h, duration } = await getInfoFile(file);
  const gx = Math.min(1, Math.max(0, Number(gaze?.x) || 0.5)), gy = Math.min(1, Math.max(0, Number(gaze?.y) || 0.5));
  const t = Math.max(0, Math.min(Number(videoTime) || 0, (Number.isFinite(duration) ? duration : 1e9) - 0.3));
  const S = Math.max(64, Math.round((Math.min(w, h) * 0.55) / 2) * 2);
  const px = gx * w, py = gy * h;
  const x0 = Math.round(Math.min(w - S, Math.max(0, px - S / 2))), y0 = Math.round(Math.min(h - S, Math.max(0, py - S / 2)));
  const cx = (px - x0).toFixed(1), cy = (py - y0).toFixed(1);
  const R = (S * 0.09).toFixed(1), T = Math.max(3, S * 0.012).toFixed(1);
  // ring: 50% red blend on a thin circle (geq works per-pixel on the small crop only)
  const ring = `between(hypot(X-${cx},Y-${cy}),${R}-${T},${R}+${T})`;
  const vf = `crop=${S}:${S}:${x0}:${y0},format=rgb24,geq=r='if(${ring},(r(X,Y)+255)/2,r(X,Y))':g='if(${ring},g(X,Y)/2,g(X,Y))':b='if(${ring},b(X,Y)/2,b(X,Y))',format=yuvj420p`;
  const jpeg = await run(tool('ffmpeg'), ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-an', '-frames:v', '1', '-vf', vf, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 30000, binary: true });
  if (jpeg.length < 100) throw Object.assign(new Error('ffmpeg produced no frame'), { status: 422 });
  return { jpeg, crop: { x: x0, y: y0, size: S, frame: { w, h } }, t };
}

// Local mp4 from the media dir (basename only, no traversal).
export function mp4Path(videoUrl) {
  const m = /^\/media\/([^/?#]+\.mp4)$/i.exec(String(videoUrl || '').split('?')[0]);
  if (!m) return null;
  const f = path.join(config.mediaDir, path.basename(decodeURIComponent(m[1])));
  return fs.existsSync(f) ? f : null;
}

// Full frame (downscaled to <=768 px wide) plus gaze-ring crop (null when no gaze) for the chat agent.
export async function grabFrames({ youtubeId, videoUrl }, videoTime, gaze) {
  let file;
  if (youtubeId) {
    if (!validYtId(youtubeId)) throw new Error('invalid youtubeId');
    if (!isCached(youtubeId)) throw new NotCachedError();
    file = cachedPath(youtubeId);
  } else { file = mp4Path(videoUrl); if (!file) throw new Error('no video file for this session'); }
  const { duration } = await getInfoFile(file);
  const t = Math.max(0, Math.min(Number(videoTime) || 0, (Number.isFinite(duration) ? duration : 1e9) - 0.3));
  const fullP = run(tool('ffmpeg'), ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-an', '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 30000, binary: true });
  const cropP = gaze && Number.isFinite(+gaze.x) && Number.isFinite(+gaze.y) ? cropFile(file, t, gaze).then((r) => r.jpeg) : Promise.resolve(null);
  const [full, crop] = await Promise.all([fullP, cropP]);
  return { full, crop, t };
}

// Flat YouTube search via yt-dlp (no download). recent=true sorts newest first (ytsearchdate). Durations are seconds (null when unknown, e.g. live).
export async function searchVideos(query, { n = 6, recent = false } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  // -j (JSON lines) instead of --print: on the Windows box --print goes out in the console codepage and mangles Korean titles
  const out = await run(tool('yt-dlp'), ['--flat-playlist', '--no-warnings', '-j', '--js-runtimes', `node:${process.execPath}`, '--cache-dir', config.ytCacheDir,
    `${recent ? 'ytsearchdate' : 'ytsearch'}${Math.min(10, n)}:${q}`], { timeoutMs: 30000 });
  const res = [];
  for (const l of out.split(/\r?\n/)) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!validYtId(j.id)) continue;
    res.push({ youtubeId: j.id, duration: Number(j.duration) || null, title: j.title, channel: j.channel || j.uploader || null, views: Number(j.view_count) || null, url: `https://www.youtube.com/watch?v=${j.id}` });
  }
  return res;
}
