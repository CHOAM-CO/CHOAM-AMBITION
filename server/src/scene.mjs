// Scene log: saccade-triggered full-frame screenshots, transcribed by Haiku into labelled entries (objects / people / features / summary).
import { completeSimple } from '@mariozechner/pi-ai';
import { config } from './config.mjs';
import * as store from './store.mjs';
import * as yt from './youtube.mjs';
import { visionModel, visionPayload, parseJson, textOf } from './ai.mjs';

const log = (...a) => console.log(new Date().toISOString(), '[scene]', ...a);
const MIN_GAP_S = 2;
const MAX_SCENES = 300;

const SCENE_SYSTEM = `You transcribe ONE video frame into a compact scene log entry. Answer with ONE JSON object only, no prose:
{"objects": [short Korean noun phrases for every distinct object/product/item visible, most prominent first, with colour/material when clear, max 12],
 "people": [{"desc": Korean appearance/role/outfit only, "action": Korean verb phrase of what they do}] (max 5, [] if none),
 "features": [Korean short phrases: dominant colours, legible on-screen text (quote it), setting/place, lighting, mood, camera shot type, max 8],
 "summary": ONE Korean line (<= 60 chars) saying what is on screen}
Rules: Korean only. Never identify a real person by face or name from appearance. Name a brand/model only if its logo or text is clearly legible. No ring/marker mentions. Be concrete and terse; no sentences in the lists. Never put a double quote character inside a string value (quote on-screen text with single quotes ' ').`;

const strList = (a, n) => (Array.isArray(a) ? a : []).map((x) => String(x ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, n);

async function describeOnce(jpeg) {
  const res = await completeSimple(visionModel, {
    systemPrompt: SCENE_SYSTEM,
    messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: 'JSON for this frame.' }] }],
  }, { apiKey: config.apiKey, maxTokens: 600, onPayload: visionPayload });
  if (res.stopReason === 'error') throw new Error(res.errorMessage || 'scene model failed');
  const j = parseJson(textOf(res));
  return {
    objects: strList(j.objects, 12),
    people: (Array.isArray(j.people) ? j.people : []).slice(0, 5).map((p) => ({ desc: String(p?.desc ?? '').slice(0, 80), action: String(p?.action ?? '').slice(0, 80) })).filter((p) => p.desc),
    features: strList(j.features, 8),
    summary: String(j.summary ?? '').trim().slice(0, 120),
  };
}

async function describe(jpeg) {
  try { return await describeOnce(jpeg); } catch (e) { if (!/JSON/.test(e.message)) throw e; return describeOnce(jpeg); } // malformed JSON from the model: one retry
}

export async function handleScene(body, { HttpError }) {
  const t0 = Date.now();
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const videoTime = Number.isFinite(+body.videoTime) ? Math.max(0, +body.videoTime) : 0;
  const youtubeId = body.youtubeId || undefined;

  // rate guard + reservation, atomic per session: drop if the last scene was < 2 s ago in wall clock or video time
  let skipped = false;
  await store.withSession(session.id, async () => {
    const s = await store.getSession(session.id);
    const now = Date.now();
    const lw = s.lastSceneWall || 0, lv = s.lastSceneVideoTime;
    if (now - lw < MIN_GAP_S * 1000 || (lv != null && Math.abs(videoTime - lv) < MIN_GAP_S)) { skipped = true; return; }
    s.lastSceneWall = now; s.lastSceneVideoTime = videoTime;
    await store.saveSession(s);
  });
  if (skipped) return { skipped: true };

  let jpeg;
  if (body.image) {
    const m = /^(?:data:image\/jpe?g;base64,)?(.+)$/s.exec(String(body.image));
    jpeg = Buffer.from(m[1], 'base64');
    if (jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, 'image is not a valid JPEG');
  } else if (youtubeId) {
    if (!yt.validYtId(youtubeId)) throw new HttpError(400, 'invalid youtubeId');
    try { jpeg = (await yt.grabFrames({ youtubeId }, videoTime, null)).full; }
    catch (e) { if (e instanceof yt.NotCachedError) throw new HttpError(409, 'not_cached'); throw new HttpError(500, `frame extraction failed: ${e.message}`); }
  } else {
    try { jpeg = (await yt.grabFrames({ videoUrl: body.videoUrl || session.videoUrl }, videoTime, null)).full; }
    catch (e) { throw new HttpError(400, `image or youtubeId required (${e.message})`); }
  }
  const tFrame = Date.now() - t0;

  const id = store.newId('sc');
  const entry = {
    id, t: new Date().toISOString(), videoTime, youtubeId: youtubeId ?? null,
    videoTitle: body.videoTitle || session.videoTitle || null,
    trigger: body.trigger === 'saccade' ? 'saccade' : String(body.trigger || 'manual').slice(0, 20),
    gaze: body.gaze && Number.isFinite(+body.gaze.x) && Number.isFinite(+body.gaze.y) ? { x: +body.gaze.x, y: +body.gaze.y } : null,
    imageUrl: `/api/scene/img/${session.id}/${id}.jpg`,
  };
  const work = (async () => {
    await store.saveSceneJpeg(session.id, id, jpeg);
    let d;
    try { d = await describe(jpeg); } catch (e) { log('describe failed', e.message); entry.error = String(e.message || e).slice(0, 200); d = { objects: [], people: [], features: [], summary: '' }; }
    Object.assign(entry, d); entry.ms = Date.now() - t0;
    await store.withSession(session.id, async () => {
      const s = await store.getSession(session.id);
      s.scenes = [...(s.scenes || []), entry].slice(-MAX_SCENES);
      await store.saveSession(s);
    });
    log(`${id} vt=${videoTime.toFixed(1)} frame=${tFrame}ms total=${entry.ms}ms objs=${entry.objects.length} "${entry.summary}"`);
    return entry;
  })();
  if (body.async === true || body.async === 1 || body.async === '1') { work.catch((e) => log('scene failed', e.message)); return { accepted: true, sceneId: id, imageUrl: entry.imageUrl }; }
  return { entry: await work };
}

export async function listScenes(sessionId, HttpError) {
  const s = await store.getSession(sessionId);
  if (!s) throw new HttpError(404, 'unknown sessionId');
  const scenes = (s.scenes || []).slice().sort((a, b) => a.t.localeCompare(b.t));
  return { sessionId: s.id, count: scenes.length, scenes };
}

// ---- agent memory block ------------------------------------------------------------------------
const KST = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const kstFull = (d = new Date()) => `${KST.format(d)} (Asia/Seoul)`;
const kstHms = (iso) => KST.format(new Date(iso)).slice(11);
export const mmss = (sec) => { const t = Math.max(0, Math.round(Number(sec) || 0)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

export function ago(iso, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}초 전`;
  const m = Math.floor(sec / 60), r = sec % 60;
  if (m < 60) return `${m}분 ${r}초 전`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분 전`;
}
// natural spoken video position: 20초 / 3분 / 1분 35초
export const vpos = (sec) => { const t = Math.max(0, Math.round(Number(sec) || 0)); const m = Math.floor(t / 60), r = t % 60; return m ? (r ? `${m}분 ${r}초` : `${m}분`) : `${r}초`; };
const stamp = (iso, vt, now) => `[${kstHms(iso)} 실제시각 (${ago(iso, now)}) | 영상 ${vt == null ? '알 수 없음' : vpos(vt)}]`;

export function nowLine(videoTime) {
  const d = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24, mi = Number(p.minute), se = Number(p.second);
  const ampm = h < 12 ? '오전' : '오후', h12 = h % 12 === 0 ? 12 : h % 12;
  return `현재 시각: ${ampm} ${h12}시 ${String(mi).padStart(2, '0')}분 ${String(se).padStart(2, '0')}초 (${KST.format(d)} KST, 24시간제 ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')})\n현재 영상 위치: ${vpos(videoTime)}`;
}

// One chronological timeline (oldest -> newest, last `limit`): scene log + gaze captures + yes/no feedback.
export function memoryBlock(session, captures, limit = 30) {
  const rows = []; const now = Date.now();
  for (const sc of session.scenes || []) {
    const bits = [sc.summary || '(전사 실패)'];
    if (sc.objects?.length) bits.push(`물건: ${sc.objects.slice(0, 8).join(', ')}`);
    if (sc.people?.length) bits.push(`인물: ${sc.people.map((p) => `${p.desc}${p.action ? ' ' + p.action : ''}`).join(', ')}`);
    if (sc.features?.length) bits.push(`특징: ${sc.features.slice(0, 5).join(', ')}`);
    rows.push({ t: sc.t, line: `${stamp(sc.t, sc.videoTime, now)} 장면 ${bits.join(' — ')}` });
  }
  const capById = new Map();
  for (const c of captures) {
    capById.set(c.captureId, c);
    if (!c.item) continue;
    const t = c.receivedAt || c.capturedAt;
    rows.push({ t, line: `${stamp(t, c.videoTime, now)} 시선이 머문 것 — ${c.item.label} (${c.item.category})${c.item.description ? ': ' + c.item.description : ''}` });
  }
  for (const f of Object.values(session.feedback || {})) {
    const c = capById.get(f.captureId);
    rows.push({ t: f.at, line: `${stamp(f.at, c ? c.videoTime : null, now)} 시청자 피드백 — ${f.label}: ${f.answer === 'yes' ? '맞다고 함' : '아니라고 함'}` });
  }
  rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const last = rows.slice(-limit);
  return last.length ? last.map((r) => r.line).join('\n') : '(아직 기록 없음)';
}
