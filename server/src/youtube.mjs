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
function tool(name) {
  const exe = path.join(config.binDir, process.platform === 'win32' ? `${name}.exe` : name);
  return fs.existsSync(exe) ? exe : name;
}
const toolEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), config.binDir, process.env.PATH].filter(Boolean).join(path.delimiter) });

function run(cmd, args, { timeoutMs = 120000, binary = false } = {}) {
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
        '--no-playlist', '--no-progress', '--newline', '--no-warnings',
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
export const statusOf = (id) => ({ videoId: id, cached: isCached(id), ...(state.get(id) || { state: isCached(id) ? 'cached' : 'unknown' }) });

export async function initYoutube() {
  await fsp.mkdir(ytDir(), { recursive: true });
  await reloadCatalog();
  fs.watchFile(catalogFile(), { interval: 5000 }, () => { reloadCatalog().catch((e) => log('reload failed', e.message)); });
  log(`catalog ${catalog.length} videos, cached ${catalog.filter((e) => isCached(e.id)).length}`);
}

async function probe(id) {
  const f = cachedPath(id);
  const out = await run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f], { timeoutMs: 20000 });
  const j = JSON.parse(out);
  const info = { w: j.streams?.[0]?.width, h: j.streams?.[0]?.height, duration: Number(j.format?.duration) };
  if (Number.isFinite(info.duration)) durations.set(id, info.duration);
  return info;
}
const probeCache = new Map();
const getInfo = (id) => { if (!probeCache.has(id)) probeCache.set(id, probe(id).catch((e) => { probeCache.delete(id); throw e; })); return probeCache.get(id); };

export async function listYoutube() {
  const out = [];
  for (const e of catalog) {
    const cached = isCached(e.id);
    let duration = durations.get(e.id) ?? null;
    if (duration == null && cached) { try { duration = (await getInfo(e.id)).duration; } catch { /* ignore */ } }
    out.push({
      id: e.id, title: e.title, ...(e.channel ? { channel: e.channel } : {}), source: 'youtube', youtubeId: e.id,
      url: `https://www.youtube.com/watch?v=${e.id}`, thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      cached, duration: duration != null ? Math.round(duration) : null,
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
  const { w, h, duration } = await getInfo(id);
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
  const jpeg = await run(tool('ffmpeg'), ['-v', 'error', '-ss', t.toFixed(3), '-i', cachedPath(id), '-an', '-frames:v', '1', '-vf', vf, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 30000, binary: true });
  if (jpeg.length < 100) throw Object.assign(new Error('ffmpeg produced no frame'), { status: 422 });
  return { jpeg, crop: { x: x0, y: y0, size: S, frame: { w, h } }, t };
}
