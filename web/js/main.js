import { api, MOCK, PARAMS } from './api.js?v=r10';
import { CONFIG, GazeEventDetector, GazeSmoother } from './events.js?v=r10';
import { MouseSource, WebGazerSource, runCalibration } from './gaze.js?v=r10';
import { EyeTheiaSource } from './eyetheia.js?v=r10';
import { createMp4Player, createYouTubePlayer } from './player.js?v=r10';
import { grab } from './capture.js?v=r10';
import { toast, addCapture, clearCaptures, addWish, showBubble, bubbleActive, dismissBubble, bubbleSay, bubbleLock, bubbleLinks, flashBadge, renderSummary, fmtTime, openChatBubble, updateChatBubble } from './ui.js?v=r10';
import { HeadGestures } from './gesture.js?v=r10';
import { Dwell } from './dwell.js?v=r10';
import { Voice } from './voice.js?v=r10';

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
  $('#screen-watch').hidden = !(state === 'watch' || state === 'summary');
  $('#summary').hidden = state !== 'summary';
  dwell.setGroup(state);
}

// ---------- start (the only click) ----------
$('#btn-start').onclick = async () => {
  voice.start(); // inside the click: lets the mic permission prompt appear
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

function renderHome() {
  const list = $('#video-list');
  dwell.clear('home');
  list.innerHTML = '';
  if (!S.catalog.length) { list.innerHTML = '<p class="muted">등록된 영상이 없어요.</p>'; return; }
  for (const v of S.catalog.slice(0, 9)) { // gaze cannot scroll: 3x3 is what fits
    const ready = v.cached !== false;
    const card = document.createElement('div');
    card.className = 'vcard' + (ready ? '' : ' pending');
    const img = document.createElement('img'); img.alt = '';
    const thumb = v.thumbnail || (v.youtubeId ? `https://i.ytimg.com/vi/${v.youtubeId}/hqdefault.jpg` : null);
    if (thumb) img.src = thumb; else img.classList.add('blank');
    img.onerror = () => img.classList.add('blank');
    const t = document.createElement('div'); t.className = 'vtitle'; t.textContent = v.title;
    card.append(img, t);
    if (v.duration) { const d = document.createElement('span'); d.className = 'vdur'; d.textContent = fmtTime(v.duration); card.appendChild(d); }
    if (!ready) { const b = document.createElement('span'); b.className = 'vbadge'; b.textContent = '준비 중'; card.appendChild(b); }
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
  S.video = v; S.session = null;
  S.videoUrl = v.source === 'youtube' ? `https://www.youtube.com/watch?v=${v.youtubeId}` : v.url;
  clearCaptures();
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
const dot = $('#gaze-dot');

function startTick() {
  if (S.tick) return;
  S.tick = setInterval(tick, 1000 / CONFIG.sampleHz);
}

function tick() {
  const nowG = performance.now();
  gest.setListening(!!dlg && dlg.asking && bubbleActive(), nowG);
  gest.update(nowG);
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
  }
  dot.classList.toggle('active', inside);
  if (inside) detector.push(now, sm.x, sm.y); else detector.reset();
  dot.style.setProperty('--p', (inside ? detector.fixProgress : 0) * 360 + 'deg');
  if (DEBUG) $('#hud').textContent = `${S.state} gaze ${sm.x | 0},${sm.y | 0} inside=${inside} fix=${detector.fixProgress.toFixed(2)} mic=${voice.state}${voice.speaking ? '/speaking' : ''}${voice.inSpeech ? '/hearing' : ''} sac=${detector.sacState} a=${K.a.toFixed(2)} b=${K.b | 0} c=${K.c.toFixed(2)} d=${K.d | 0}${K.active ? '' : ' (off)'}${S.source.debugInfo ? '\n' + S.source.debugInfo() : ''}`;
}

// ---------- capture ----------
async function onGazeEvent(ev) {
  const p = S.player;
  if (!p || S.finished || S.state !== 'watch') return;
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
    res.__thumb = shot.image || res.imageUrl;
    if (res.speak && res.say && !S.finished) openDialog(card, res);
  } catch (e) {
    if (token !== S.token) return;
    if (e.status === 409) { card.remove(); return; } // not_cached: skip silently
    card.setError();
    toast('서버 오류: ' + e.message);
  }
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
  const ok = showBubble({ say: res.say, onYes: () => answerYes(d), onNo: () => answerNo(d) });
  if (ok) dlg = d;
}
function answerYes(d) {
  if (d !== dlg || !d.asking) return;
  d.asking = false;
  feedback('yes');
  const it = curItem();
  const isText = it.category === 'text';
  bubbleSay(isText && it.description ? it.description : '더 알아볼게요'); // text: show the translation/explanation
  bubbleLinks(it.links);
  d.card.showLinks(it.links || []);
  addWish({ id: d.res.captureId + ':' + d.alt, thumb: d.res.__thumb, label: it.label, category: it.category, links: it.links });
  setTimeout(() => { if (dlg === d) dismissBubble(); }, isText ? 20000 : 12000); // nothing is clickable: close on its own
}
function answerNo(d) {
  if (d !== dlg || !d.asking) return;
  feedback('no');
  const alts = d.res.alternatives || [];
  if (d.alt + 1 < alts.length) {
    d.alt++;
    bubbleSay(alts[d.alt].say); // links appear only after a yes
  } else {
    d.asking = false;
    bubbleLock();
    bubbleSay('알겠어요, 방해 안 할게요');
    setTimeout(() => { if (dlg === d) dismissBubble(); }, 2000);
  }
}
function onGesture(g) {
  if (!dlg || !dlg.asking || !bubbleActive()) return;
  flashBadge(g === 'nod' ? '끄덕 ✓' : '도리도리 ✗', g === 'nod');
  g === 'nod' ? answerYes(dlg) : answerNo(dlg);
}
// keyboard stand-ins: Y = nod, N = shake (works in every mode; handy without a camera)
addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
  if (e.key === 'y' || e.key === 'Y') onGesture('nod');
  else if (e.key === 'n' || e.key === 'N') onGesture('shake');
});

// ---------- voice chat ----------
const capText = $('#caption-text'), capInput = $('#caption-input');
let capTimer = null, duckTimer = null, duckSaved = null, chatBusy = 0, chatSeq = 0;
const MIC_LABEL = { on: '마이크 켜짐', off: '마이크 꺼짐', error: '마이크 오류', unsupported: '음성 미지원' };

const voice = new Voice({
  onState: (s) => {
    const c = $('#chip-mic'); c.textContent = MIC_LABEL[s] || s; c.className = 'chip' + (s === 'on' ? ' mic-on' : s === 'error' ? ' mic-error' : '');
    if (!capTimer) capText.textContent = s === 'on' ? '🎙 …' : '🎙 ' + (MIC_LABEL[s] || s);
  },
  onSpeechStart: () => { duck(true); scheduleUnduck(4000); },
  onInterim: (t) => { clearTimeout(capTimer); capTimer = null; capText.textContent = '🎙 ' + t; capText.classList.add('interim'); scheduleUnduck(4000); },
  onFinal: (t) => handleUtterance(t, 'voice'),
});

function caption(text, ms = 3000) {
  capText.classList.remove('interim'); capText.textContent = '🎙 ' + text;
  clearTimeout(capTimer);
  capTimer = setTimeout(() => { capTimer = null; capText.classList.remove('interim'); capText.textContent = voice.state === 'on' ? '🎙 …' : '🎙 ' + (MIC_LABEL[voice.state] || ''); }, ms);
}

// duck the video volume to ~20% while the viewer talks / the agent answers
function duck(on) {
  const p = S.player; if (!p || !p.setVolume) return;
  if (on) { if (duckSaved == null) { duckSaved = p.getVolume(); p.setVolume(duckSaved * CONFIG.voice.duckLevel); } }
  else if (duckSaved != null) { p.setVolume(duckSaved); duckSaved = null; }
}
function scheduleUnduck(ms) { clearTimeout(duckTimer); duckTimer = setTimeout(() => { if (!chatBusy && !voice.speaking) duck(false); }, ms); }

async function handleUtterance(raw, source) {
  const text = (raw || '').trim();
  if (text) caption(text);
  if (text.length <= CONFIG.voice.minChars || S.state !== 'watch' || !S.player || S.finished) { scheduleUnduck(1500); return; }
  const token = S.token, v = S.video, seq = ++chatSeq;
  chatBusy++;
  duck(true);
  dlg = null;
  const bubble = openChatBubble('찾아보는 중…'); // immediately
  try {
    if (!S.session) {
      const r = await api.session({ videoUrl: S.videoUrl, videoTitle: v.title, source: v.source, youtubeId: v.youtubeId });
      if (token !== S.token) return;
      S.session = r.sessionId;
    }
    const rect = S.player.contentRect();
    const gaze = sm ? { x: +Math.min(1, Math.max(0, (sm.x - rect.left) / rect.width)).toFixed(4), y: +Math.min(1, Math.max(0, (sm.y - rect.top) / rect.height)).toFixed(4) } : null;
    const body = { sessionId: S.session, text, source, videoUrl: S.videoUrl, videoTitle: v.title, videoTime: +S.player.time().toFixed(2), gaze };
    if (v.source === 'youtube') body.youtubeId = v.youtubeId;
    const res = await api.chat(body);
    if (token !== S.token || seq !== chatSeq) return;
    if (res.ignored) { dismissBubble(); return; } // not for the agent: show nothing
    updateChatBubble(bubble, { text: res.reply || '', items: res.items });
    for (const it of res.items || []) {
      addWish({ id: (res.captureId || 'chat' + seq) + ':' + it.name, label: it.price ? `${it.name} · ${it.price}` : it.name, category: 'product', links: [{ title: it.source || '', url: it.url }] });
    }
    if (res.speak && res.reply) await voice.speak(res.reply);
  } catch (e) {
    if (token === S.token && seq === chatSeq) { dismissBubble(); toast('대화 오류: ' + e.message); }
  } finally {
    chatBusy--;
    scheduleUnduck(chatBusy ? 4000 : 400);
  }
}

// typing stand-in for speech (mouse / debug mode), e.g. for headless smoke tests
if (MOUSE || DEBUG) {
  capInput.hidden = false;
  capInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !capInput.value.trim()) return;
    const t = capInput.value; capInput.value = '';
    duck(true); handleUtterance(t, 'typed');
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
