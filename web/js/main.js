import { api, MOCK, PARAMS } from './api.js?v=r19';
import { CONFIG, GazeEventDetector, GazeSmoother } from './events.js?v=r19';
import { MouseSource, WebGazerSource, runCalibration } from './gaze.js?v=r19';
import { EyeTheiaSource } from './eyetheia.js?v=r19';
import { createMp4Player, createYouTubePlayer } from './player.js?v=r19';
import { grab, fullFrame } from './capture.js?v=r19';
import { toast, addCapture, clearCaptures, renderScenes, addWish, showBubble, bubbleActive, dismissBubble, bubbleSay, bubbleLock, flashBadge, renderSummary, fmtTime, chatAdd, chatClear, danmakuClear, handShow } from './ui.js?v=r19';
import { HeadGestures } from './gesture.js?v=r19';
import { ExpressionDetector, SIM } from './expression.js?v=r19';
import { Dwell } from './dwell.js?v=r19';
import { Voice } from './voice.js?v=r19';
import { VadMic, AgentVoice, matchAnswer, isEchoText } from './call.js?v=r19';

const $ = (s) => document.querySelector(s);
const MOUSE = PARAMS.get('gaze') === 'mouse';
const DEBUG = PARAMS.get('debug') === '1';
if (DEBUG) document.body.classList.add('debug');

// state: landing | setup | home | watch | summary
const S = { state: 'landing', catalog: [], video: null, videoUrl: null, player: null, session: null, source: null, tick: null, finished: false, token: 0, nextTimer: null, homeTimer: null };
let sm = null; // smoothed gaze {x,y}
const smoother = new GazeSmoother();
const dwell = new Dwell();

function show(state) {
  S.state = state;
  $('#screen-landing').hidden = state !== 'landing';
  $('#screen-home').hidden = state !== 'home';
  $('#add-form').hidden = state !== 'home';
  $('#screen-watch').hidden = !(state === 'watch' || state === 'summary');
  $('#summary').hidden = state !== 'summary';
  dwell.setGroup(state);
}

// ---------- start (the only click) ----------
$('#btn-start').onclick = async () => {
  callStart(); // inside the click: unlocks audio playback and lets the mic permission prompt appear
  $('#btn-start').disabled = true;
  S.state = 'setup';
  $('#screen-landing').hidden = true;
  try {
    if (MOUSE) {
      S.source = new MouseSource(); await S.source.start(); startTick();
    } else {
      const useWG = PARAMS.get('tracker') === 'webgazer';
      S.source = useWG ? new WebGazerSource() : new EyeTheiaSource();
      for (;;) {
        try { setup('카메라 준비 중…'); await S.source.start(setup); break; }
        catch (e) {
          const choice = await askFail(e);
          if (choice === 'mouse') { S.source = new MouseSource(); await S.source.start(); break; }
          S.source = useWG ? new WebGazerSource() : new EyeTheiaSource(); // retry with a fresh source
        }
      }
      setup(null);
      S.source.onHand = handAction; // EyeTheia only: hand gestures from the same camera
      S.source.onHandFeedback = (f) => { if (f) handShow(f.name, f.progress, f.mapped); }; // live indicator before anything fires
      startTick(); // gaze dot visible during calibration
      if (S.source.mode === 'webcam') await runCalibration($('#calib'), S.source, () => sm, PARAMS.get('calib') === 'click');
    }
  } finally { setup(null); }
  $('#chip-src').textContent = S.source.mode === 'mouse' ? '시선: 마우스' : '시선: 웹캠';
  goHome();
};

function setup(msg) { $('#setup').hidden = !msg; $('#setup-msg').textContent = msg || ''; }

function askFail(e) {
  return new Promise((res) => {
    $('#setup').hidden = false;
    $('#setup-msg').innerHTML = '';
    const p = document.createElement('p'); p.textContent = '카메라를 켜지 못했어요: ' + (e.message || e.name);
    const r = document.createElement('div'); r.className = 'row';
    const a = document.createElement('button'); a.className = 'btn primary'; a.textContent = '다시 시도';
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = '마우스로 대신 진행';
    a.onclick = () => res('retry'); b.onclick = () => res('mouse');
    r.append(a, b); $('#setup-msg').append(p, r);
  });
}

// ---------- home ----------
const normalize = (v) => ({ ...v, source: v.source || (v.youtubeId ? 'youtube' : 'mp4') });
let catalogKey = '';

async function loadCatalog() {
  try {
    const { videos } = await api.videos();
    S.catalog = videos.map(normalize);
    const key = JSON.stringify(S.catalog);
    if (key !== catalogKey) { catalogKey = key; renderHome(); }
  } catch (e) {
    if (!S.catalog.length) $('#video-list').innerHTML = '<p class="muted">영상 목록을 불러오지 못했어요.</p>';
    toast('영상 목록 오류: ' + e.message);
  }
}

// "영상 추가": paste any YouTube URL + Enter. Card shows at once (준비 중); playable via the embed immediately, gaze captures once cached.
(() => {
  const form = $('#add-form'), input = $('#add-input');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url || form.classList.contains('busy')) return;
    form.classList.add('busy');
    try {
      const r = await api.addVideo(url);
      input.value = ''; input.blur();
      toast(r.existing ? '이미 있는 영상이에요' : '영상을 추가했어요. 준비 중이에요');
      await loadCatalog();
    } catch (err) {
      toast('영상 추가 실패: ' + (err.body?.error || err.message));
    } finally { form.classList.remove('busy'); }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') input.blur(); });
})();

function renderHome() {
  const list = $('#video-list');
  dwell.clear('home');
  list.innerHTML = '';
  if (!S.catalog.length) { list.innerHTML = '<p class="muted">등록된 영상이 없어요.</p>'; return; }
  for (const v of S.catalog.slice(0, 8)) { // gaze cannot scroll: 2 rows (3 or 4 per row) is what fits
    const ready = v.cached !== false;
    const card = document.createElement('div');
    card.className = 'vcard' + (ready ? '' : ' pending');
    const th = document.createElement('div'); th.className = 'vthumb';
    const img = document.createElement('img'); img.alt = '';
    const thumb = v.thumbnail || (v.youtubeId ? `https://i.ytimg.com/vi/${v.youtubeId}/hqdefault.jpg` : null);
    if (thumb) img.src = thumb; else img.classList.add('blank');
    img.onerror = () => img.classList.add('blank');
    th.appendChild(img);
    if (v.duration) { const d = document.createElement('span'); d.className = 'vdur'; d.textContent = fmtTime(v.duration); th.appendChild(d); }
    const failed = !ready && v.state === 'error';
    if (!ready) { const b = document.createElement('span'); b.className = 'vbadge' + (failed ? ' err' : ''); b.textContent = failed ? '다운로드 실패' : '준비 중'; th.appendChild(b); }
    const info = document.createElement('div'); info.className = 'vinfo';
    const av = document.createElement('span'); av.className = 'avatar'; av.textContent = (v.title || 'A').trim().charAt(0).toUpperCase();
    const tx = document.createElement('div'); tx.className = 'vtxt';
    const t = document.createElement('div'); t.className = 'vtitle'; t.textContent = v.title;
    const ch = document.createElement('div'); ch.className = 'vch'; ch.textContent = v.source === 'youtube' ? 'YouTube' : 'AMBITION 샘플';
    const mt = document.createElement('div'); mt.className = 'vmeta'; mt.textContent = ready ? '재생 준비됨' : failed ? '5분 뒤 다시 시도해요' : '준비 중이에요…';
    tx.append(t, ch, mt); info.append(av, tx);
    card.append(th, info);
    list.appendChild(card);
    dwell.register(card, () => playVideo(v), { group: 'home', enabled: () => ready });
  }
}

function goHome() {
  teardown();
  show('home');
  loadCatalog();
  clearInterval(S.homeTimer);
  S.homeTimer = setInterval(() => { if (S.state === 'home') loadCatalog(); }, 10000); // pick up cached=false -> true
}

// ---------- watch ----------
function teardown() {
  S.token++;
  clearInterval(S.nextTimer);
  dismissBubble(); dlg = null;
  if (S.player) { try { S.player.destroy(); } catch {} S.player = null; }
  S.finished = false;
}

async function playVideo(v) {
  teardown();
  clearInterval(S.homeTimer);
  const token = S.token;
  S.video = v; S.session = null; S.labels = [];
  S.videoUrl = v.source === 'youtube' ? `https://www.youtube.com/watch?v=${v.youtubeId}` : v.url;
  clearCaptures(); chatClear(); danmakuClear(); renderScenes([]); lastScene = 0;
  $('#watch-title').textContent = v.title;
  $('#watch-sub').textContent = v.source === 'youtube' ? 'YouTube · 시선 + 음성 + 고개 제스처로 같이 보는 중' : '샘플 영상 · 시선 + 음성 + 고개 제스처로 같이 보는 중';
  show('watch');
  const host = $('#player');
  try {
    const p = v.source === 'mp4' ? createMp4Player(host, v.url) : await createYouTubePlayer(host, { id: v.youtubeId });
    if (token !== S.token) { p.destroy(); return; }
    S.player = p;
  } catch (e) { toast('플레이어 오류: ' + e.message); return; }
  S.player.onEnded(finish);
  try {
    const r = await api.session({ videoUrl: S.videoUrl, videoTitle: v.title, source: v.source, youtubeId: v.youtubeId });
    if (token === S.token) S.session = r.sessionId;
  } catch (e) { toast('세션 생성 실패 (캡처 때 다시 시도해요): ' + e.message); }
  if (v.source === 'mp4') S.player.play();
}

// 관심 목록: collapsible section at the top of the right column, with a count badge; opens for a few seconds on a new item, or on dwell
const drawer = $('#wishbox');
let drawerTimer = null;
function setDrawer(open, ms) {
  clearTimeout(drawerTimer);
  drawer.classList.toggle('collapsed', !open);
  if (open) drawerTimer = setTimeout(() => setDrawer(false), ms);
}
window.addEventListener('wish-added', () => setDrawer(true, 4000));
dwell.register($('#wish-head'), () => setDrawer(drawer.classList.contains('collapsed'), 10000), { group: 'watch' });
const sceneBox = $('#scenebox'); let sceneOpenTimer = null;
dwell.register($('#scene-head'), () => {
  const open = sceneBox.classList.contains('collapsed');
  sceneBox.classList.toggle('collapsed', !open); clearTimeout(sceneOpenTimer);
  if (open) { refreshScenes(); sceneOpenTimer = setTimeout(() => sceneBox.classList.add('collapsed'), 12000); }
}, { group: 'watch' });
dwell.register($('#btn-home'), goHome, { group: 'watch' });
dwell.register($('#btn-done'), () => finish(), { group: 'watch' });
dwell.register($('#btn-home2'), goHome, { group: 'summary' });
dwell.register($('#btn-next'), () => goNext(), { group: 'summary' });

function nextVideo() {
  const list = S.catalog.filter((v) => v.cached !== false);
  if (!list.length || !S.video) return null;
  const i = list.findIndex((v) => v.id === S.video.id);
  const n = list[(i + 1) % list.length];
  return n.id === S.video.id ? null : n;
}
function goNext() { const n = nextVideo(); if (n) playVideo(n); else goHome(); }

// ---------- gaze loop ----------
const detector = new GazeEventDetector(onGazeEvent);
detector.onScene = (ev) => sceneSnap(ev);
const dot = $('#gaze-dot');
const actionsEl = $('.watch-actions');
const camEl = $('#cam');

function startTick() {
  if (S.tick) return;
  S.tick = setInterval(tick, 1000 / CONFIG.sampleHz);
}

function tick() {
  const nowG = performance.now();
  gest.setListening(!!dlg && dlg.asking && bubbleActive(), nowG);
  gest.update(nowG);
  exprTick(nowG);
  let raw = S.source && S.source.latest();
  const K = CONFIG.correction;
  if (raw && K.active && S.source.mode !== 'mouse') {
    raw = { x: Math.max(0, Math.min(innerWidth, K.a * raw.x + K.b)), y: Math.max(0, Math.min(innerHeight, K.c * raw.y + K.d)), t: raw.t };
  }
  const now = performance.now();
  if (!raw) { sm = null; smoother.reset(); dot.style.opacity = 0; detector.reset(); dwell.update(null, now); return; }
  const mouse = S.source.mode === 'mouse';
  const sg = S.source.smoothing; // per-source (EyeTheia: live CONFIG.eyetheia.smoothing)
  const cfg = mouse ? { window: CONFIG.medianWindowMouse, alpha: CONFIG.smoothingAlphaMouse, deadzonePx: 0 }
    : sg ? sg : { window: CONFIG.medianWindow, alpha: CONFIG.smoothingAlpha, deadzonePx: 0 };
  smoother.push(raw, cfg);
  sm = { x: smoother.x, y: smoother.y }; // events + dwell read the smoothed signal
  dot.style.opacity = 1;
  dot.style.transform = `translate(${smoother.shownX}px, ${smoother.shownY}px)`; // the dot gets the dead-zone on top
  dwell.update(sm, now);

  const p = S.player;
  let inside = false;
  if (p && S.state === 'watch' && !S.finished && p.isPlaying()) {
    const r = p.contentRect();
    inside = sm.x >= r.left && sm.x <= r.left + r.width && sm.y >= r.top && sm.y <= r.top + r.height;
    const ar = actionsEl.getBoundingClientRect(); // looking at the dwell buttons is not looking at the video
    if (sm.x >= ar.left - 24 && sm.x <= ar.right + 24 && sm.y >= ar.top - 24 && sm.y <= ar.bottom + 24) inside = false;
    const cr = camEl.getBoundingClientRect(); // the agent cam overlays the video corner
    if (sm.x >= cr.left - 12 && sm.x <= cr.right + 12 && sm.y >= cr.top - 12 && sm.y <= cr.bottom + 12) inside = false;
  }
  S.inside = inside;
  dot.classList.toggle('active', inside);
  if (inside) detector.push(now, sm.x, sm.y); else detector.reset();
  dot.style.setProperty('--p', (inside ? detector.fixProgress : 0) * 360 + 'deg');
  if (DEBUG) $('#hud').textContent = `${S.state} gaze ${sm.x | 0},${sm.y | 0} inside=${inside} fix=${detector.fixProgress.toFixed(2)} call=${STT}/${muted ? 'muted' : vadReady ? 'ready' : 'loading'}${agentVoice.speaking ? '/speaking' : ''}${turnActive ? '/turn' : ''}${hearing ? '/hearing' : ''} sac=${detector.sacState} a=${K.a.toFixed(2)} b=${K.b | 0} c=${K.c.toFixed(2)} d=${K.d | 0}${K.active ? '' : ' (off)'}${S.source.debugInfo ? '\n' + S.source.debugInfo() : ''}\n${exprDet.debug()}`;
}

// ---------- capture ----------
let capBusy = false;
async function onGazeEvent(ev) { // ev.force: pointed at it (hand), always ask
  const p = S.player;
  if (!p || S.finished || S.state !== 'watch') return;
  // calm agent: one capture in flight, none while a question is open or anybody is talking (a pointing hand always goes through)
  if (!ev.force && (capBusy || bubbleActive() || agentVoice.speaking || hearing || turnActive)) return;
  capBusy = true; activity();
  try { await doCapture(ev); } finally { capBusy = false; activity(); }
}
async function doCapture(ev) {
  const p = S.player;
  const token = S.token, v = S.video;
  const videoTime = p.time();
  let shot;
  try { shot = await grab(p, ev.x, ev.y); }
  catch (e) { toast('캡처 실패: ' + e.message); return; }
  const card = addCapture({ thumb: shot.image || null, videoTime, kind: ev.kind });
  try {
    if (!S.session) {
      const r = await api.session({ videoUrl: S.videoUrl, videoTitle: v.title, source: v.source, youtubeId: v.youtubeId });
      if (token !== S.token) return;
      S.session = r.sessionId;
    }
    const body = {
      sessionId: S.session, videoUrl: S.videoUrl, videoTime: +videoTime.toFixed(2),
      capturedAt: new Date().toISOString(), kind: ev.kind, dwellMs: ev.dwellMs, gaze: shot.gaze,
    };
    if (v.source === 'youtube') body.youtubeId = v.youtubeId; else body.image = shot.image; // youtube: server renders the frame
    const res = await api.capture(body);
    if (token !== S.token) return;
    card.setResult(res);
    if (res.item && res.item.label) { S.labels.push(res.item.label); if (S.labels.length > 8) S.labels.shift(); }
    res.__thumb = shot.image || res.imageUrl;
    if (ev.force) { // pointing: force the question bubble
      dismissBubble(); dlg = null;
      res.say = '이거 말씀하시는 거죠?'; res.speak = true;
    }
    if (res.speak && res.say && !S.finished) openDialog(card, res);
  } catch (e) {
    if (token !== S.token) return;
    if (e.status === 409) { card.remove(); return; } // not_cached: skip silently
    card.setError();
    toast('서버 오류: ' + e.message);
  }
}

// ---------- scene log: every real look-jump posts a full-frame snapshot (fire and forget, no UI beyond a tick in chat) ----------
let lastScene = 0, sceneOff = false, sceneTimer = null;
async function sceneSnap(ev, extra = {}) {
  const p = S.player, v = S.video;
  if (sceneOff || !p || !v || !S.session || S.state !== 'watch' || S.finished || (!p.isPlaying() && !extra.expression)) return; // an expression is worth a note even while paused
  const now = performance.now();
  if (now - lastScene < 2000) return; // the server guards at 2 s as well
  lastScene = now;
  const token = S.token, videoTime = +p.time().toFixed(2);
  const rect = p.contentRect();
  const body = { sessionId: S.session, videoTime, videoTitle: v.title, trigger: 'saccade', async: true, ...extra,
    gaze: { x: +Math.min(1, Math.max(0, (ev.x - rect.left) / rect.width)).toFixed(4), y: +Math.min(1, Math.max(0, (ev.y - rect.top) / rect.height)).toFixed(4) } };
  if (v.source === 'youtube') body.youtubeId = v.youtubeId; else { body.image = fullFrame(p); if (!body.image) return; }
  try {
    const r = await api.scene(body);
    if (token !== S.token || r.skipped) return;
    chatAdd({ who: 'sys', text: `장면 기록 ${fmtTime(videoTime)}${extra.expression ? ' (' + extra.expression + ')' : ''}`, dm: false });
    clearTimeout(sceneTimer); sceneTimer = setTimeout(refreshScenes, 6000); // the description takes a few seconds
  } catch (e) {
    if (e.status === 404 && !/session/i.test(JSON.stringify(e.body || {}))) sceneOff = true; // server has no /api/scene
    else if (e.status === 404) S.session = null;
  }
}
setInterval(() => { if (S.state === 'watch' && !$('#scenebox').classList.contains('collapsed')) refreshScenes(); }, 5000); // poll while the tab is open
async function refreshScenes() {
  if (!S.session || sceneOff || MOCK) return;
  const token = S.token;
  try { const r = await api.scenes(S.session); if (token === S.token) renderScenes(r.scenes || []); } catch {}
}

// ---------- bubble dialogue (head gestures, Y/N keys, or buttons for debugging) ----------
let dlg = null; // {card, res, alt: -1 = original, asking}
const gest = new HeadGestures(() => (S.source && S.source.positions ? S.source.positions() : null), (g) => onGesture(g));

function curItem() {
  const { res, alt } = dlg;
  if (alt < 0) {
    const it = res.item || {};
    return { label: it.label, category: it.category, description: it.description, links: res.links };
  }
  const a = res.alternatives[alt];
  return { label: a.label || a.query || '', category: a.category, description: a.description, links: a.links };
}
function feedback(answer) {
  const it = curItem();
  api.feedback({ sessionId: S.session, captureId: dlg.res.captureId, label: it.label || '', answer });
}
function openDialog(card, res) {
  const d = { card, res, alt: -1, asking: true };
  d.chat = res.say ? chatAdd({ who: 'agent', text: res.say, dm: false }) : null; // the question shows as the pinned ask line
  const ok = showBubble({ say: res.say, onYes: () => answerYes(d), onNo: () => answerNo(d) });
  if (ok) { dlg = d; activity(); speakLine(res.say); }
}
function answerYes(d, said) {
  if (d !== dlg || !d.asking) return;
  d.asking = false;
  if (d.offer) { // yes to "영상 보실래요?": the server answers with play (video / article)
    chatAdd({ who: 'user', text: said || '응! (끄덕)' });
    bubbleLock(); runTurn('', { trigger: 'accept', source: 'voice' });
    return;
  }
  if (d.custom) { // thumbs-down "넘길까요?"
    chatAdd({ who: 'user', text: said || '응, 넘겨줘' });
    bubbleLock(); chatAdd({ who: 'agent', text: '좋아요, 넘길게요' }); speakLine('좋아요, 넘길게요');
    setTimeout(() => { if (S.state === 'watch' && S.token === d.token) goNext(); }, 1200);
    return;
  }
  feedback('yes');
  chatAdd({ who: 'user', text: said || '응! (끄덕)' });
  const it = curItem();
  const isText = it.category === 'text';
  bubbleLock(); // the question line goes away; the answer lands in chat + danmaku below
  addWish({ id: d.res.captureId + ':' + d.alt, thumb: d.res.__thumb, label: it.label, category: it.category });
  if (isText && it.description) { chatAdd({ who: 'agent', text: it.description }); speakLine(it.description); return; }
  runTurn('', { trigger: 'accept', source: 'voice' }); // content-first: the server looks it up and offers one concrete video/article
}
function answerNo(d, said) {
  if (d !== dlg || !d.asking) return;
  if (d.offer) { // no to an offer: drop it
    d.asking = false; bubbleLock();
    chatAdd({ who: 'user', text: said || '아니 (도리도리)' });
    chatAdd({ who: 'agent', text: '알겠어요' }); speakLine('알겠어요');
    return;
  }
  if (d.custom) {
    d.asking = false;
    chatAdd({ who: 'user', text: said || '아니, 계속 볼래' });
    bubbleLock(); chatAdd({ who: 'agent', text: '그대로 볼게요' }); speakLine('그대로 볼게요');
    setTimeout(() => { if (dlg === d) dismissBubble(); }, 1500);
    return;
  }
  feedback('no');
  chatAdd({ who: 'user', text: said || '아니 (도리도리)' });
  const alts = d.res.alternatives || [];
  if (d.alt + 1 < alts.length) {
    d.alt++;
    bubbleSay(alts[d.alt].say); // the question line shows the next alternative
    chatAdd({ who: 'agent', text: alts[d.alt].say, dm: false }); speakLine(alts[d.alt].say);
  } else {
    d.asking = false;
    bubbleLock();
    chatAdd({ who: 'agent', text: '알겠어요, 방해 안 할게요' }); speakLine('알겠어요, 방해 안 할게요');
    setTimeout(() => { if (dlg === d) dismissBubble(); }, 2000);
  }
}
function onGesture(g) {
  if (!dlg || !dlg.asking || !bubbleActive()) return;
  flashBadge(g === 'nod' ? '끄덕' : '도리도리', g === 'nod');
  g === 'nod' ? answerYes(dlg) : answerNo(dlg);
}
// ---------- facial expressions (blendshapes from the EyeTheia FaceLandmarker) ----------
const exprEl = $('#agent-expr');
let exprSim = null, exprShow = '', exprShowUntil = 0;
const exprDet = new ExpressionDetector((kind) => exprFire(kind), () => S.state === 'watch' && !!S.player && !S.finished && !asking() && !bubbleActive() && !agentVoice.speaking && !hearing && !turnActive);
function exprTick(now) {
  let b = null;
  if (exprSim && now < exprSim.until) b = SIM[exprSim.kind]; else exprSim = null;
  if (!b && S.source && S.source.blendshapes) b = S.source.blendshapes();
  exprDet.update(now, b);
  const txt = exprDet.cur || (now < exprShowUntil ? exprShow : '');
  if (txt !== exprEl.dataset.t) { exprEl.dataset.t = txt; exprEl.textContent = txt ? '표정: ' + txt : ''; }
}
function exprFire(kind) {
  const pool = CONFIG.expression.lines[kind], line = pool[(Math.random() * pool.length) | 0];
  exprShow = kind; exprShowUntil = performance.now() + 2500;
  activity();
  chatAdd({ who: 'sys', text: `표정 감지: ${kind}`, dm: false });
  chatAdd({ who: 'agent', text: line }); speakLine(line); // danmaku + chat + voice
  const p = S.player;
  if (p && sm) sceneSnap({ x: sm.x, y: sm.y }, { trigger: 'expression', expression: kind });
  else if (p) { const r = p.contentRect(); sceneSnap({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, { trigger: 'expression', expression: kind }); }
}
// ---------- content-first offers (server: offer -> yes -> play) ----------
const clip = (t, n = 38) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function onOffer(ev, token) {
  if (token !== S.token || !ev || !ev.title) return;
  const meta = [ev.channel, ev.duration ? fmtTime(ev.duration) : ''].filter(Boolean).join(' · ');
  chatAdd({ who: 'agent', text: `${ev.kind === 'article' ? '기사' : '영상'} · ${ev.title}${meta ? ' (' + meta + ')' : ''}`, dm: false });
  const d = { offer: ev, asking: true, token };
  if (bubbleActive()) dismissBubble();
  const say = ev.kind === 'article' ? `${clip(ev.title)} 기사 열어볼까요?` : `${clip(ev.title)} 보실래요?`;
  if (showBubble({ say, onYes: () => answerYes(d), onNo: () => answerNo(d) })) { dlg = d; activity(); }
}
async function onPlay(ev, token) {
  if (!ev || token !== S.token) return;
  for (let i = 0; i < 20 && agentVoice.speaking; i++) await new Promise((r) => setTimeout(r, 200)); // let "바로 틀어드릴게요" finish
  if (token !== S.token) return;
  if (ev.kind === 'article') {
    const w = window.open(ev.url, '_blank', 'noopener');
    chatAdd({ who: 'sys', text: w ? `기사 열었어요: ${ev.title}` : `팝업이 막혔어요: ${ev.url}`, dm: false });
    if (!w) toast('팝업이 막혔어요. 기사 주소는 채팅에 있어요');
    return;
  }
  const url = ev.url || `https://www.youtube.com/watch?v=${ev.youtubeId}`;
  chatAdd({ who: 'sys', text: '영상 준비 중…', dm: false });
  let v = null;
  try { v = (await api.addVideo(url)).video; } catch (e) { toast('영상 추가 실패: ' + (e.body?.error || e.message)); }
  if (token !== S.token) return;
  const id = (v && v.youtubeId) || ev.youtubeId;
  if (!id) return;
  playVideo({ ...(v || {}), id: (v && v.id) || id, title: ev.title || (v && v.title) || id, channel: (v && v.channel) || ev.channel, source: 'youtube', youtubeId: id, url }); // the embed plays before the cache finishes
}
// ---------- hand gestures ----------
function pointNow() { // capture right now at the current gaze point
  if (S.state !== 'watch' || !S.player || !sm || S.finished) return;
  detector.lastCap = { t: performance.now(), x: sm.x, y: sm.y }; // keep the gaze detector from double-capturing
  onGazeEvent({ kind: 'fixation', x: sm.x, y: sm.y, dwellMs: 0, force: true });
}
const THUMB_UP_LINES = ['오 이거 좋아요? 저도 좋네요', '좋죠! 마음에 들어요?', '오 이 장면 좋아요?'];
function askSkip() { // thumbs-down outside a question: offer to skip
  if (bubbleActive()) dismissBubble();
  const d = { custom: true, asking: true, token: S.token };
  const say = '별로예요? 다른 영상으로 넘길까요?';
  const ok = showBubble({ say, onYes: () => answerYes(d), onNo: () => answerNo(d) });
  if (ok) { dlg = d; chatAdd({ who: 'agent', text: say, dm: false }); speakLine(say); activity(); }
}
function reactThumb(up) { // thumbs outside a question: react to the current moment
  chatAdd({ who: 'sys', text: up ? '엄지 척' : '엄지 아래' });
  activity();
  if (up) {
    const line = THUMB_UP_LINES[(Math.random() * THUMB_UP_LINES.length) | 0];
    chatAdd({ who: 'agent', text: line }); speakLine(line);
  } else askSkip();
}
const asking = () => dlg && dlg.asking && bubbleActive();
function handAction(name) {
  const watching = S.state === 'watch' && S.player;
  if (watching || S.state === 'summary') handShow(name, 1, true, 1200);
  switch (name) {
    case 'Thumb_Up': if (asking()) answerYes(dlg); else if (watching && !S.finished) reactThumb(true); break;
    case 'Thumb_Down': if (asking()) answerNo(dlg); else if (watching && !S.finished) reactThumb(false); break;
    case 'Open_Palm': if (watching) { chatAdd({ who: 'sys', text: S.player.isPlaying() ? '멈춤' : '재생' }); S.player.isPlaying() ? S.player.pause() : S.player.play(); } break;
    case 'Pointing_Up': if (watching) { chatAdd({ who: 'sys', text: '이거!' }); pointNow(); } break;
    case 'Victory': if (watching || S.state === 'summary') { chatAdd({ who: 'sys', text: '다음 영상' }); goNext(); } break;
  }
}

// keyboard stand-ins: Y = nod, N = shake, and P = palm, I = pointing, V = victory (any mode; handy without a camera)
addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
  if (e.key === 'y' || e.key === 'Y') onGesture('nod');
  else if (e.key === 'n' || e.key === 'N') onGesture('shake');
  else if (e.key === 'm' || e.key === 'M') toggleMute();
  else if (e.key === 'p' || e.key === 'P') handAction('Open_Palm');
  else if (e.key === 'i' || e.key === 'I') handAction('Pointing_Up');
  else if (e.key === 'v' || e.key === 'V') handAction('Victory');
  else if (DEBUG && '123'.includes(e.key) && e.key) exprSim = { kind: ['웃음', '놀람', '찡그림'][+e.key - 1], until: performance.now() + 1200 }; // debug: simulate an expression
  else if (e.key === 'u' || e.key === 'U') handAction('Thumb_Up');
  else if (e.key === 'd' || e.key === 'D') handAction('Thumb_Down');
});

// ---------- call mode: VAD + ASR in, streamed turn + TTS out ----------
const capText = $('#caption-text'), capInput = $('#caption-input');
const STT = PARAMS.get('stt') || 'vad'; // vad (default) | webspeech | off
let capTimer = null, duckTimer = null, duckSaved = null, turnCtl = null, turnActive = false, chatSeq = 0, hearing = false, muted = false;
let lastActivity = performance.now(), vadReady = false;
const activity = () => { lastActivity = performance.now(); };

// ---------- local ack (user speech end only), ASR hotword context, agent presence ----------
let micLvl = 0, lastAck = 0;
const ACKS = { speech: ['음…', '잠깐만요'] };
function ack(kind) { // local audio only, never waits for the server, no on-screen element
  const now = performance.now();
  if (now - lastAck < 2500 || agentVoice.speaking) return;
  lastAck = now;
  const pool = ACKS[kind];
  agentVoice.quick(pool[(Math.random() * pool.length) | 0]);
}
function asrContext() { // hotword bias for the ASR system prompt (server clips to 500 chars)
  const v = S.video || {};
  return [v.title, v.channel, ...(S.labels || []).slice(-5), '뒷광고', '최저가', '다나와', '모니터', '가방'].filter(Boolean).join(', ').slice(0, 500);
}
// what the agent said recently (echo filter + lastAgent param)
const agentLines = [];
function noteAgent(t) { agentLines.push({ t: performance.now(), text: t }); if (agentLines.length > 6) agentLines.shift(); }
function recentAgent(ms = 20000) { const n = performance.now(); return agentLines.filter((l) => n - l.t < ms).slice(-3).map((l) => l.text).join(' '); }
const isEcho = (t) => isEchoText(t, recentAgent());

// agent presence: plain streamer profile (avatar ring + state text + equalizer bars), no orb
const avEl = $('#agent-av'), avState = $('#agent-state'), eq = $('#agent-eq'), eqBars = [...eq.querySelectorAll('b')];
const STATE_TXT = { idle: '대기 중', looking: '보는 중', listening: '듣는 중', thinking: '생각 중', speaking: '말하는 중' };
let avSt = '';
function presenceFrame(t) {
  requestAnimationFrame(presenceFrame);
  if (S.state !== 'watch' && S.state !== 'summary') return;
  let st = 'idle', lvl = 0;
  micLvl *= 0.85;
  if (agentVoice.speaking) { st = 'speaking'; lvl = agentVoice.level(); }
  else if (turnActive) st = 'thinking';
  else if (hearing) { st = 'listening'; lvl = micLvl; }
  else if (S.inside) st = 'looking';
  if (st !== avSt) { avSt = st; avEl.className = 'ch-av ' + st; avState.textContent = STATE_TXT[st]; }
  const on = st === 'speaking' || st === 'listening';
  if (eq.style.display !== (on ? 'inline-flex' : 'none')) eq.style.display = on ? 'inline-flex' : 'none';
  if (on) eqBars.forEach((b, i) => { b.style.height = (3 + lvl * 12 * (0.45 + 0.55 * Math.abs(Math.sin(t / 110 + i * 1.4)))).toFixed(0) + 'px'; });
}
requestAnimationFrame(presenceFrame);

// player chrome (Chzzk bottom bar): progress + time, play/pause state
const fmt2 = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
setInterval(() => {
  const p = S.player; if (!p || S.state !== 'watch') return;
  const cur = p.time(), dur = p.duration ? p.duration() : 0;
  $('#pb-fill').style.width = dur ? Math.min(100, cur / dur * 100) + '%' : '0';
  $('#pb-time').textContent = `${fmt2(cur)} / ${fmt2(dur)}`;
  document.querySelector('.player-wrap').classList.toggle('paused', !p.isPlaying());
}, 250);

// header chip: 통화 · 듣는 중 / 생각 중 / 말하는 중
const CALL_LABEL = { loading: '준비 중', listening: '듣는 중', thinking: '생각 중', speaking: '말하는 중', muted: '음소거', error: '마이크 오류', off: '꺼짐', unsupported: '음성 미지원' };
function baseState() { return muted ? 'muted' : STT === 'off' ? 'off' : vadReady ? 'listening' : 'loading'; }
function setCall(s) {
  const c = $('#chip-mic');
  c.textContent = '통화 · ' + (CALL_LABEL[s] || s);
  c.className = 'chip dwell' + (s === 'listening' ? ' mic-on' : s === 'error' ? ' mic-error' : s === 'speaking' ? ' call-speaking' : s === 'thinking' ? ' call-thinking' : '');
  if (!capTimer) capText.textContent = s === 'listening' ? '말하면 채팅으로 올라가요' : CALL_LABEL[s] || s;
}
const refreshCall = () => setCall(agentVoice.speaking ? 'speaking' : turnActive ? 'thinking' : baseState());

function caption(text, ms = 3000) {
  capText.classList.remove('interim'); capText.textContent = text;
  clearTimeout(capTimer);
  capTimer = setTimeout(() => { capTimer = null; capText.classList.remove('interim'); refreshCall(); }, ms);
}

// duck the video volume to ~15% while either side talks
function duck(on) {
  const p = S.player; if (!p || !p.setVolume) return;
  if (on) { if (duckSaved == null) { duckSaved = p.getVolume(); p.setVolume(duckSaved * CONFIG.voice.duckLevel); } }
  else if (duckSaved != null) { p.setVolume(duckSaved); duckSaved = null; }
}
function scheduleUnduck(ms) { clearTimeout(duckTimer); duckTimer = setTimeout(() => { if (!turnActive && !agentVoice.speaking && !hearing) duck(false); }, ms); }

const agentVoice = new AgentVoice((on) => {
  if (on) { duck(true); if (voice) voice.hold(true); } else { activity(); scheduleUnduck(500); if (voice && !muted) voice.hold(false); }
  if (vadMic) vadMic.setSpeaking(on); // stricter VAD while the agent talks (echo)
  refreshCall();
});
const speakLine = (t) => { noteAgent(t); if (CONFIG.call.speakDialogs) agentVoice.enqueue(t); };

// STT: webspeech fallback (?stt=webspeech) shares the same text handler as VAD + ASR
const voice = STT === 'webspeech' ? new Voice({
  onState: (s) => { vadReady = s === 'on'; if (s === 'error') setCall('error'); else refreshCall(); },
  onSpeechStart: () => { hearing = true; duck(true); activity(); },
  onInterim: (t) => { clearTimeout(capTimer); capTimer = null; capText.textContent = t; capText.classList.add('interim'); scheduleUnduck(4000); },
  onFinal: (t) => { hearing = false; handleUserText(t, 'voice'); },
}) : null;

const vadMic = STT === 'vad' ? new VadMic({
  onSpeechStart: () => { hearing = true; duck(true); activity(); capTimer = null; capText.classList.add('interim'); capText.textContent = '듣는 중…'; },
  onSpeechRealStart: () => { // barge-in: the viewer talks over the agent (the VAD is already stricter while the agent speaks)
    if (agentVoice.speaking || turnActive) { agentVoice.stop(); if (turnCtl) turnCtl.abort(); }
  },
  onMisfire: () => { hearing = false; scheduleUnduck(1000); capText.classList.remove('interim'); refreshCall(); },
  onFrame: (p, frame) => { // mic level for the presence bars
    let s = 0; for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    micLvl = Math.max(micLvl, Math.min(1, Math.sqrt(s / frame.length) * 8));
  },
  onSpeechEnd: async (wav) => {
    hearing = false; activity();
    caption('인식 중…', 8000);
    if (S.state !== 'watch' || !S.player || S.finished) { scheduleUnduck(500); refreshCall(); return; }
    if (!asking()) ack('speech'); // instant local "음…" while the server works
    try {
      const ran = await runTalk(wav);
      if (ran !== false) return;
      const r = await api.asr(wav, asrContext()); // old 3-call path: asr -> turn -> tts
      const t = (r.text || '').trim();
      if (t) handleUserText(t, 'voice'); else { scheduleUnduck(500); refreshCall(); }
    } catch (e) { toast('음성 인식 오류: ' + e.message); scheduleUnduck(500); refreshCall(); }
  },
}) : null;

if (vadMic) window.__call = vadMic.h; // debug/test hook: __call.onSpeechStart() / onSpeechRealStart() / onSpeechEnd(wavBlob)

async function callStart() { // inside the start click
  agentVoice.unlock();
  agentVoice.prefetch(['음…', '잠깐만요']); // canned reaction, decoded now so it plays instantly later
  setCall(STT === 'off' ? 'off' : 'loading');
  if (voice) voice.start();
  if (vadMic) vadMic.start().then(() => { vadReady = true; refreshCall(); }).catch((e) => { console.warn('VAD failed', e); setCall('error'); toast('마이크를 켜지 못했어요: ' + (e.message || e.name)); });
}

async function toggleMute() {
  muted = !muted;
  if (vadMic) await vadMic.mute(muted);
  if (voice) voice.mute(muted);
  if (muted) { hearing = false; scheduleUnduck(300); }
  refreshCall();
}
dwell.register($('#chip-mic'), toggleMute, { group: 'watch' });

// an open yes/no question: whatever the viewer says is the answer. returns true when handled locally
function localAnswer(text) {
  if (!asking()) return false;
  const a = matchAnswer(text);
  if (!a) return false;
  agentVoice.stop(); caption(text);
  flashBadge(a === 'yes' ? '음성 · 응' : '음성 · 아니', a === 'yes');
  a === 'yes' ? answerYes(dlg, text) : answerNo(dlg, text);
  return true;
}

// typed / webspeech / old-path text
function handleUserText(raw) {
  const text = (raw || '').trim(), source = arguments[1] || 'voice';
  if (text) caption(text);
  activity();
  if (S.state !== 'watch' || !S.player || S.finished) { scheduleUnduck(1500); return; }
  if (source !== 'typed' && isEcho(text)) { scheduleUnduck(500); refreshCall(); return; } // the agent's own voice
  if (localAnswer(text)) return;
  if (text.length <= CONFIG.voice.minChars && !asking()) { scheduleUnduck(1500); return; }
  runTurn(text, { trigger: 'user', source });
}

// ---- one turn, shared by the voice/turn (text in) and voice/talk (audio in) paths ----
function turnView(token, seq, text, trigger, { userLine = true } = {}) {
  let thinking = null, userAdded = false, items = [], playEv = null;
  const clearThinking = () => { if (thinking) { thinking.remove(); thinking = null; } };
  const begin = () => { // the viewer's line goes into chat/danmaku once the agent really answers (narration picked up by the mic is never shown as the viewer)
    if (!userAdded && trigger === 'user' && userLine && text) { userAdded = true; chatAdd({ who: 'user', text }); }
  };
  return {
    start(early) { if (early) begin(); thinking = chatAdd({ who: 'agent', text: '…', dm: false }); },
    begin, clearThinking,
    flush() { const e = playEv; playEv = null; if (e) onPlay(e, token); },
    setText(t) { text = t; },
    handle(ev, { audioFromServer }) {
      if (ev.type === 'say') {
        clearThinking(); begin(); noteAgent(ev.text);
        chatAdd({ who: 'agent', text: ev.text });
        if (!audioFromServer) agentVoice.enqueue(ev.text);
      } else if (ev.type === 'audio') {
        agentVoice.enqueueAudio(ev.seq, ev.sentence, ev.b64 || null);
      } else if (ev.type === 'tool') {
        refreshCall(); // searching: keep "생각 중"
        if (thinking) thinking.setText('찾는 중…');
      } else if (ev.type === 'offer') {
        clearThinking(); onOffer(ev, token);
      } else if (ev.type === 'play') {
        clearThinking(); playEv = ev; // runs after the turn's say lines (playing wipes the chat column)
      } else if (ev.type === 'items') {
        clearThinking(); begin(); items = items.concat(ev.items || []);
        chatAdd({ who: 'agent', text: '', items: ev.items });
        for (const it of ev.items || []) {
          addWish({ id: 'turn' + seq + ':' + it.name, label: it.price ? `${it.name} · ${it.price}` : it.name, category: 'product', links: [{ title: it.source || '', url: it.url }] });
        }
      } else if (ev.type === 'ignored') {
        clearThinking();
      }
    },
  };
}
function turnEnd(ctl) {
  if (turnCtl === ctl) { turnActive = false; turnCtl = null; }
  if (!agentVoice.speaking) scheduleUnduck(500);
  refreshCall();
}
async function ensureSession(token, v) {
  if (S.session) return true;
  const r = await api.session({ videoUrl: S.videoUrl, videoTitle: v.title, source: v.source, youtubeId: v.youtubeId });
  if (token !== S.token) return false;
  S.session = r.sessionId; return true;
}
function gazeNorm() {
  const rect = S.player.contentRect();
  return sm ? { x: +Math.min(1, Math.max(0, (sm.x - rect.left) / rect.width)).toFixed(4), y: +Math.min(1, Math.max(0, (sm.y - rect.top) / rect.height)).toFixed(4) } : null;
}

/** audio -> /api/voice/talk. Resolves false when the server has no such endpoint (the caller then runs asr + turn). */
async function runTalk(wav) {
  const token = S.token, v = S.video, seq = ++chatSeq;
  if (turnCtl) turnCtl.abort();
  agentVoice.stop();
  const ctl = turnCtl = new AbortController();
  turnActive = true; activity(); duck(true); refreshCall();
  const wasAsking = !!asking(), view = turnView(token, seq, '', 'user');
  const stale = () => token !== S.token || ctl.signal.aborted || seq !== chatSeq;
  let answered = false, started = false, heard = '';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await ensureSession(token, v))) return true;
      const g = gazeNorm();
      const params = {
        sessionId: S.session, lang: 'auto', context: asrContext(), lastAgent: recentAgent().slice(-300), asking: wasAsking ? 1 : '',
        youtubeId: v.source === 'youtube' ? v.youtubeId : '', videoUrl: S.videoUrl, videoTitle: v.title, videoTime: +S.player.time().toFixed(2), gaze: g ? `${g.x},${g.y}` : '',
      };
      try {
        const ran = await api.talk(wav, params, ctl.signal, (ev) => {
          if (stale()) return;
          if (ev.type === 'asr') {
            const t = (ev.text || '').trim();
            if (!t) { ctl.abort(); return; }
            heard = t; caption(t); view.setText(t);
            if (isEcho(t)) { ctl.abort(); return; } // the agent hearing itself
            if (wasAsking && asking() && localAnswer(t)) { answered = true; ctl.abort(); return; }
            if (t.length <= CONFIG.voice.minChars && !wasAsking) { ctl.abort(); return; }
            started = true; view.start();
          } else if (ev.type === 'answer') {
            if (ev.value && asking()) { answered = true; agentVoice.stop(); flashBadge(ev.value === 'yes' ? '음성 · 응' : '음성 · 아니', ev.value === 'yes'); ev.value === 'yes' ? answerYes(dlg, heard) : answerNo(dlg, heard); }
          } else if (ev.type === 'error') { toast('대화 오류: ' + (ev.message || '')); }
          else view.handle(ev, { audioFromServer: true });
        });
        if (ran === false) return false;
        break;
      } catch (e) {
        if (e.status === 404 && attempt === 0) { S.session = null; continue; } // unknown session: make a new one, once
        throw e;
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted && token === S.token) toast('대화 오류: ' + e.message);
  } finally {
    view.clearThinking();
    if (!started && !answered) { scheduleUnduck(500); }
    turnEnd(ctl);
    view.flush();
  }
  return true;
}

async function runTurn(text, { trigger, source }) {
  const token = S.token, v = S.video, seq = ++chatSeq;
  if (turnCtl) turnCtl.abort();
  agentVoice.stop();
  const ctl = turnCtl = new AbortController();
  turnActive = true; activity(); duck(true); dismissBubble(); dlg = null;
  refreshCall();
  const view = turnView(token, seq, text, trigger);
  view.start(true);
  try {
    if (!(await ensureSession(token, v))) return;
    const body = { sessionId: S.session, ...(text ? { text } : {}), trigger, source, videoUrl: S.videoUrl, videoTitle: v.title, videoTime: +S.player.time().toFixed(2), gaze: gazeNorm() };
    if (v.source === 'youtube') body.youtubeId = v.youtubeId;
    await api.turn(body, ctl.signal, (ev) => {
      if (token !== S.token || ctl.signal.aborted || seq !== chatSeq) return;
      view.handle(ev, { audioFromServer: false });
    });
  } catch (e) {
    if (!ctl.signal.aborted && token === S.token) {
      if (trigger === 'accept' && /409/.test(e.message)) { chatAdd({ who: 'agent', text: '더 찾을 건 없네요' }); speakLine('더 찾을 건 없네요'); }
      else toast('대화 오류: ' + e.message);
    }
  } finally {
    view.clearThinking();
    turnEnd(ctl);
    view.flush();
  }
}

// idle: nothing happened for a while (no speech, capture, bubble or agent talk) while a video plays -> the agent may speak up
setInterval(() => {
  if (S.state !== 'watch' || !S.player || S.finished || muted || turnActive || hearing || capBusy || agentVoice.speaking || bubbleActive()) return;
  if (!S.player.isPlaying() || performance.now() - lastActivity < Math.max(CONFIG.call.idleMs, CONFIG.call.quietMs)) return;
  activity();
  runTurn('', { trigger: 'idle', source: 'voice' });
}, 5000);

// typing stand-in for speech (mouse / debug mode): goes straight to the turn, skipping ASR
if (MOUSE || DEBUG) {
  capInput.hidden = false;
  capInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !capInput.value.trim()) return;
    const t = capInput.value; capInput.value = '';
    handleUserText(t, 'typed');
  });
}

// ---------- summary ----------
async function finish() {
  if (S.finished || S.state !== 'watch') return;
  S.finished = true;
  const token = S.token;
  dismissBubble(); dlg = null;
  S.player && S.player.pause();
  show('summary');
  $('#summary-body').innerHTML = '<p class="muted">정리하는 중이에요…</p>';
  try {
    if (!S.session) throw new Error('세션이 없어요');
    const data = await api.summary({ sessionId: S.session });
    if (token !== S.token) return;
    renderSummary(data);
  } catch (e) {
    if (token !== S.token) return;
    $('#summary-body').innerHTML = '';
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = '요약을 불러오지 못했어요: ' + e.message;
    $('#summary-body').append(p);
    toast('요약 오류: ' + e.message);
  }
  startNextCountdown(token);
}

function startNextCountdown(token) {
  clearInterval(S.nextTimer);
  let left = Math.round(CONFIG.nextVideoAutoMs / 1000);
  const label = () => { $('#next-count').textContent = `(${left}초 뒤 자동)`; };
  label();
  S.nextTimer = setInterval(() => {
    if (token !== S.token || S.state !== 'summary') return clearInterval(S.nextTimer);
    if (--left <= 0) { clearInterval(S.nextTimer); goNext(); } else label();
  }, 1000);
}

$('#chip-mode').hidden = !(MOCK || MOUSE);
$('#chip-mode').textContent = [MOCK && 'mock', MOUSE && 'mouse'].filter(Boolean).join('+');
$('#hud').hidden = !DEBUG;
show('landing');
