import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
export const validId = (s) => typeof s === 'string' && ID_RE.test(s);
export const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

const sessionDir = (id) => path.join(config.dataDir, 'sessions', id);
const sessionFile = (id) => path.join(sessionDir(id), 'session.json');
const capDir = () => path.join(config.dataDir, 'captures');
export const capJpg = (cid) => path.join(capDir(), `${cid}.jpg`);
const capJson = (cid) => path.join(capDir(), `${cid}.json`);

async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

// Per-session serial queue: session.json read-modify-write and the speak decision are atomic.
const queues = new Map();
export function withSession(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(id, next);
  next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
  return next;
}

export async function createSession({ videoUrl, videoTitle, source }) {
  const id = newId('s');
  const session = {
    id, videoUrl: videoUrl ?? null, videoTitle: videoTitle ?? null, source: source ?? 'mp4',
    createdAt: new Date().toISOString(), captureIds: [], lastSpokenAt: 0, spoken: [], labels: [],
  };
  await fs.mkdir(sessionDir(id), { recursive: true });
  await writeJsonAtomic(sessionFile(id), session);
  return session;
}

export async function getSession(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(await fs.readFile(sessionFile(id), 'utf8')); } catch { return null; }
}
export const saveSession = (s) => writeJsonAtomic(sessionFile(s.id), s);

export async function saveCapture(meta, jpegBuf) {
  await fs.mkdir(capDir(), { recursive: true });
  await fs.writeFile(capJpg(meta.captureId), jpegBuf);
  await writeJsonAtomic(capJson(meta.captureId), meta);
}
export const updateCapture = (meta) => writeJsonAtomic(capJson(meta.captureId), meta);
export async function getCapture(cid) {
  if (!validId(cid)) return null;
  try { return JSON.parse(await fs.readFile(capJson(cid), 'utf8')); } catch { return null; }
}
export async function getCaptures(session) {
  const all = await Promise.all(session.captureIds.map(getCapture));
  return all.filter(Boolean);
}
