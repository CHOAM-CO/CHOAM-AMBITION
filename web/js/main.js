import { api, MOCK, PARAMS } from './api.js?v=r14';
import { CONFIG, GazeEventDetector, GazeSmoother } from './events.js?v=r14';
import { MouseSource, WebGazerSource, runCalibration } from './gaze.js?v=r14';
import { EyeTheiaSource } from './eyetheia.js?v=r14';
import { createMp4Player, createYouTubePlayer } from './player.js?v=r14';
import { grab } from './capture.js?v=r14';
import { toast, addCapture, clearCaptures, addWish, showBubble, bubbleActive, dismissBubble, bubbleSay, bubbleLock, bubbleLinks, flashBadge, renderSummary, fmtTime, openChatBubble, updateChatBubble, chatAdd, chatClear } from './ui.js?v=r14';
import { HeadGestures } from './gesture.js?v=r14';
import { Dwell } from './dwell.js?v=r14';
import { Voice } from './voice.js?v=r14';
import { VadMic, AgentVoice, classifyAnswer } from './call.js?v=r14';

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
  S.video = v; S.session = null;
  S.videoUrl = v.source === 'youtube' ? `https://www.youtube.com/watch?v=${v.youtubeId}` : v.url;
  clearCaptures(); chatClear();
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
const actionsEl = $('.watch-actions');

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
    const ar = actionsEl.getBoundingClientRect(); // looking at the dwell buttons is not looking at the video
    if (sm.x >= ar.left - 24 && sm.x <= ar.right + 24 && sm.y >= ar.top - 24 && sm.y <= ar.bottom + 24) inside = false;
  }
  dot.classList.toggle('active', inside);
  if (inside) detector.push(now, sm.x, sm.y); else detector.reset();
  dot.style.setProperty('--p', (inside ? detector.fixProgress : 0) * 360 + 'deg');
  if (DEBUG) $('#hud').textContent = `${S.state} gaze ${sm.x | 0},${sm.y | 0} inside=${inside} fix=${detector.fixProgress.toFixed(2)} call=${STT}/${muted ? 'muted' : vadReady ? 'ready' : 'loading'}${agentVoice.speaking ? '/speaking' : ''}${turnActive ? '/turn' : ''}${hearing ? '/hearing' : ''} sac=${detector.sacState} a=${K.a.toFixed(2)} b=${K.b | 0} c=${K.c.toFixed(2)} d=${K.d | 0}${K.active ? '' : ' (off)'}${S.source.debugInfo ? '\n' + S.source.debugInfo() : ''}`;
}

// ---------- capture ----------
async function onGazeEvent(ev) { // ev.force: pointed at it (hand), always ask
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
  d.chat = res.say ? chatAdd({ who: 'agent', text: res.say }) : null;
  const ok = showBubble({ say: res.say, onYes: () => answerYes(d), onNo: () => answerNo(d) });
  if (ok) { dlg = d; activity(); speakLine(res.say); }
}
function answerYes(d, said) {
  if (d !== dlg || !d.asking) return;
  d.asking = false;
  feedback('yes');
  chatAdd({ who: 'user', text: said || '끄덕 ✓ 응!' });
  const it = curItem();
  const isText = it.category === 'text';
  bubbleSay(isText && it.description ? it.description : '더 알아볼게요'); // text: show the translation/explanation
  bubbleLinks(it.links);
  chatAdd({ who: 'agent', text: isText && it.description ? it.description : '더 알아볼게요', links: it.links });
  d.card.showLinks(it.links || []);
  addWish({ id: d.res.captureId + ':' + d.alt, thumb: d.res.__thumb, label: it.label, category: it.category, links: it.links });
  speakLine(isText && it.description ? it.description : '더 알아볼게요');
  setTimeout(() => { if (dlg === d) dismissBubble(); }, isText ? 20000 : 12000); // nothing is clickable: close on its own
}
function answerNo(d, said) {
  if (d !== dlg || !d.asking) return;
  feedback('no');
  chatAdd({ who: 'user', text: said || '도리도리 ✗ 아니' });
  const alts = d.res.alternatives || [];
  if (d.alt + 1 < alts.length) {
    d.alt++;
    bubbleSay(alts[d.alt].say); // links appear only after a yes
    chatAdd({ who: 'agent', text: alts[d.alt].say }); speakLine(alts[d.alt].say);
  } else {
    d.asking = false;
    bubbleLock();
    bubbleSay('알겠어요, 방해 안 할게요');
    chatAdd({ who: 'agent', text: '알겠어요, 방해 안 할게요' }); speakLine('알겠어요, 방해 안 할게요');
    setTimeout(() => { if (dlg === d) dismissBubble(); }, 2000);
  }
}
function onGesture(g) {
  if (!dlg || !dlg.asking || !bubbleActive()) return;
  flashBadge(g === 'nod' ? '끄덕 ✓' : '도리도리 ✗', g === 'nod');
  g === 'nod' ? answerYes(dlg) : answerNo(dlg);
}
// ---------- hand gestures ----------
function pointNow() { // capture right now at the current gaze point
  if (S.state !== 'watch' || !S.player || !sm || S.finished) return;
  detector.lastCap = { t: performance.now(), x: sm.x, y: sm.y }; // keep the gaze detector from double-capturing
  onGazeEvent({ kind: 'fixation', x: sm.x, y: sm.y, dwellMs: 0, force: true });
}
function handAction(name) {
  const watching = S.state === 'watch' && S.player;
  switch (name) {
    case 'Thumb_Up': if (dlg && dlg.asking && bubbleActive()) { flashBadge('👍', true); answerYes(dlg); } break;
    case 'Thumb_Down': if (dlg && dlg.asking && bubbleActive()) { flashBadge('👎', false); answerNo(dlg); } break;
    case 'Open_Palm': if (watching) { flashBadge('✋', true); S.player.isPlaying() ? S.player.pause() : S.player.play(); } break;
    case 'Pointing_Up': if (watching) { flashBadge('☝️', true); pointNow(); } break;
    case 'Victory': if (watching || S.state === 'summary') { flashBadge('✌️', true); goNext(); } break;
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
});

// ---------- call mode: VAD + ASR in, streamed turn + TTS out ----------
const capText = $('#caption-text'), capInput = $('#caption-input');
const STT = PARAMS.get('stt') || 'vad'; // vad (default) | webspeech | off
let capTimer = null, duckTimer = null, duckSaved = null, turnCtl = null, turnActive = false, chatSeq = 0, hearing = false, muted = false;
let lastActivity = performance.now(), vadReady = false;
const activity = () => { lastActivity = performance.now(); };

// header chip: 통화 · 듣는 중 / 생각 중 / 말하는 중
const CALL_LABEL = { loading: '준비 중', listening: '듣는 중', thinking: '생각 중', speaking: '말하는 중', muted: '음소거', error: '마이크 오류', off: '꺼짐', unsupported: '음성 미지원' };
function baseState() { return muted ? 'muted' : STT === 'off' ? 'off' : vadReady ? 'listening' : 'loading'; }
function setCall(s) {
  const c = $('#chip-mic');
  c.textContent = '통화 · ' + (CALL_LABEL[s] || s);
  c.className = 'chip dwell' + (s === 'listening' ? ' mic-on' : s === 'error' ? ' mic-error' : s === 'speaking' ? ' call-speaking' : s === 'thinking' ? ' call-thinking' : '');
  if (!capTimer) capText.textContent = s === 'listening' ? '🎙 …' : '🎙 ' + (CALL_LABEL[s] || s);
}
const refreshCall = () => setCall(agentVoice.speaking ? 'speaking' : turnActive ? 'thinking' : baseState());

function caption(text, ms = 3000) {
  capText.classList.remove('interim'); capText.textContent = '🎙 ' + text;
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
  if (on) { duck(true); if (voice) voice.hold(true); }
  else { activity(); scheduleUnduck(500); if (voice && !muted) voice.hold(false); }
  refreshCall();
});
const speakLine = (t) => { if (CONFIG.call.speakDialogs) agentVoice.enqueue(t); };

// STT: webspeech fallback (?stt=webspeech) shares the same text handler as VAD + ASR
const voice = STT === 'webspeech' ? new Voice({
  onState: (s) => { vadReady = s === 'on'; if (s === 'error') setCall('error'); else refreshCall(); },
  onSpeechStart: () => { hearing = true; duck(true); activity(); },
  onInterim: (t) => { clearTimeout(capTimer); capTimer = null; capText.textContent = '🎙 ' + t; capText.classList.add('interim'); scheduleUnduck(4000); },
  onFinal: (t) => { hearing = false; handleUserText(t, 'voice'); },
}) : null;

const vadMic = STT === 'vad' ? new VadMic({
  onSpeechStart: () => { hearing = true; duck(true); activity(); capTimer = null; capText.classList.add('interim'); capText.textContent = '🎙 듣는 중…'; },
  onSpeechRealStart: () => { // barge-in: the viewer talks over the agent
    if (agentVoice.speaking || turnActive) { agentVoice.stop(); if (turnCtl) turnCtl.abort(); }
  },
  onMisfire: () => { hearing = false; scheduleUnduck(1000); capText.classList.remove('interim'); refreshCall(); },
  onSpeechEnd: async (wav) => {
    hearing = false; activity();
    caption('인식 중…', 8000);
    try {
      const r = await api.asr(wav);
      const t = (r.text || '').trim();
      if (t) handleUserText(t, 'voice'); else { scheduleUnduck(500); refreshCall(); }
    } catch (e) { toast('음성 인식 오류: ' + e.message); scheduleUnduck(500); refreshCall(); }
  },
}) : null;

if (vadMic) window.__call = vadMic.h; // debug/test hook: __call.onSpeechStart() / onSpeechRealStart() / onSpeechEnd(wavBlob)

async function callStart() { // inside the start click
  agentVoice.unlock();
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

// a short spoken yes/no answers the open bubble like a nod/shake; anything else is a normal turn
function handleUserText(raw) {
  const text = (raw || '').trim(), source = arguments[1] || 'voice';
  if (text) caption(text);
  activity();
  if (text.length <= CONFIG.voice.minChars || S.state !== 'watch' || !S.player || S.finished) { scheduleUnduck(1500); return; }
  if (dlg && dlg.asking && bubbleActive()) {
    const a = classifyAnswer(text);
    if (a) { agentVoice.stop(); flashBadge(a === 'yes' ? '음성 ✓' : '음성 ✗', a === 'yes'); a === 'yes' ? answerYes(dlg, text) : answerNo(dlg, text); return; }
  }
  runTurn(text, { trigger: 'user', source });
}

let turnBubble = null;
async function runTurn(text, { trigger, source }) {
  const token = S.token, v = S.video, seq = ++chatSeq;
  if (turnCtl) turnCtl.abort();
  agentVoice.stop();
  const ctl = turnCtl = new AbortController();
  turnActive = true; activity(); duck(true); dlg = null;
  refreshCall();
  if (trigger === 'user') chatAdd({ who: 'user', text });
  let thinking = chatAdd({ who: 'agent', text: '…' });
  const clearThinking = () => { if (thinking) { thinking.remove(); thinking = null; } };
  const said = []; let allItems = []; turnBubble = null;
  const bubbleNow = () => {
    const t = said.join(' ').slice(-180);
    if (!turnBubble) turnBubble = openChatBubble(t || '…');
    else updateChatBubble(turnBubble, { text: t, items: allItems });
  };
  try {
    if (!S.session) {
      const r = await api.session({ videoUrl: S.videoUrl, videoTitle: v.title, source: v.source, youtubeId: v.youtubeId });
      if (token !== S.token) return;
      S.session = r.sessionId;
    }
    const rect = S.player.contentRect();
    const gaze = sm ? { x: +Math.min(1, Math.max(0, (sm.x - rect.left) / rect.width)).toFixed(4), y: +Math.min(1, Math.max(0, (sm.y - rect.top) / rect.height)).toFixed(4) } : null;
    const body = { sessionId: S.session, text, trigger, source, videoUrl: S.videoUrl, videoTitle: v.title, videoTime: +S.player.time().toFixed(2), gaze };
    if (v.source === 'youtube') body.youtubeId = v.youtubeId;
    await api.turn(body, ctl.signal, (ev) => {
      if (token !== S.token || ctl.signal.aborted || seq !== chatSeq) return;
      if (ev.type === 'say') {
        clearThinking(); said.push(ev.text);
        chatAdd({ who: 'agent', text: ev.text });
        bubbleNow(); agentVoice.enqueue(ev.text);
      } else if (ev.type === 'tool') {
        refreshCall(); // searching: keep "생각 중"
      } else if (ev.type === 'items') {
        clearThinking(); allItems = allItems.concat(ev.items || []);
        chatAdd({ who: 'agent', text: '', items: ev.items });
        bubbleNow();
        for (const it of ev.items || []) {
          addWish({ id: 'turn' + seq + ':' + it.name, label: it.price ? `${it.name} · ${it.price}` : it.name, category: 'product', links: [{ title: it.source || '', url: it.url }] });
        }
      } else if (ev.type === 'ignored') {
        clearThinking(); if (turnBubble) { dismissBubble(); turnBubble = null; }
      }
    });
  } catch (e) {
    if (!ctl.signal.aborted && token === S.token) toast('대화 오류: ' + e.message);
  } finally {
    clearThinking();
    if (turnCtl === ctl) { turnActive = false; turnCtl = null; }
    if (!agentVoice.speaking) scheduleUnduck(500);
    refreshCall();
  }
}

// idle: nothing said, no bubble and no agent speech for 45 s while a video plays -> the agent may speak up
setInterval(() => {
  if (S.state !== 'watch' || !S.player || S.finished || muted || turnActive || hearing || agentVoice.speaking || bubbleActive()) return;
  if (!S.player.isPlaying() || performance.now() - lastActivity < CONFIG.call.idleMs) return;
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
