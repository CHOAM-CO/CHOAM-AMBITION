import { api, MOCK, PARAMS } from './api.js';
import { CONFIG, GazeEventDetector } from './events.js';
import { MouseSource, WebGazerSource, runCalibration } from './gaze.js';
import { createMp4Player, createYouTubePlayer, parseYouTube } from './player.js';
import { grab, startDisplayCapture, hasDisplayCapture } from './capture.js';
import { toast, addCapture, showBubble, bubbleActive, dismissBubble, renderSummary } from './ui.js';

const $ = (s) => document.querySelector(s);
const MOUSE = PARAMS.get('gaze') === 'mouse';
const DEBUG = PARAMS.get('debug') === '1';
if (DEBUG) document.body.classList.add('debug');

const S = { video: null, player: null, session: null, source: null, tick: null, finished: false, caps: 0 };
let sm = null; // smoothed gaze {x,y}
let win = []; // recent raw samples for the median

// ---------- picker ----------
async function loadVideos() {
  const list = $('#video-list');
  try {
    const { videos } = await api.videos();
    list.innerHTML = '';
    if (!videos.length) list.innerHTML = '<p class="muted">등록된 영상이 없어요. 아래에 YouTube 주소를 넣어 보세요.</p>';
    for (const v of videos) {
      const b = document.createElement('button');
      b.className = 'vcard'; b.textContent = v.title;
      b.onclick = () => start({ source: 'mp4', url: v.url, title: v.title });
      list.appendChild(b);
    }
  } catch (e) {
    list.innerHTML = '<p class="muted">영상 목록을 불러오지 못했어요.</p>';
    toast('영상 목록 오류: ' + e.message);
  }
}

$('#yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const yt = parseYouTube($('#yt-url').value);
  if (!yt) return toast('YouTube 주소를 확인해 주세요 (watch?v=, youtu.be, shorts)');
  start({ source: 'youtube', yt, url: yt.url, title: 'YouTube ' + yt.id });
});

// ---------- start flow ----------
function setup(msg) { $('#setup').hidden = !msg; $('#setup-msg').textContent = msg || ''; }

async function start(video) {
  S.video = video;
  $('#screen-pick').hidden = true;
  try {
    if (video.source === 'youtube') {
      setup('화면 공유를 허용해 주세요 (이 탭, 프레임 캡처용)');
      try { await startDisplayCapture(); } catch (e) { toast('화면 공유 없이는 YouTube 캡처가 안 돼요'); }
    }
    if (MOUSE) {
      S.source = new MouseSource(); await S.source.start();
    } else {
      S.source = new WebGazerSource();
      for (;;) {
        try { setup('카메라 준비 중…'); await S.source.start(setup); break; }
        catch (e) {
          const choice = await askFail(e);
          if (choice === 'mouse') { S.source = new MouseSource(); await S.source.start(); break; }
        }
      }
      setup(null);
      if (S.source.mode === 'webcam') {
        startTick(); // gaze dot visible during calibration
        await runCalibration($('#calib'), S.source, () => sm);
      }
    }
  } finally { setup(null); }
  await beginWatching();
}

function askFail(e) {
  return new Promise((res) => {
    const box = $('#setup');
    box.hidden = false;
    $('#setup-msg').innerHTML = '';
    const p = document.createElement('p'); p.textContent = '카메라를 켜지 못했어요: ' + (e.message || e.name);
    const r = document.createElement('div'); r.className = 'row';
    const a = document.createElement('button'); a.className = 'btn primary'; a.textContent = '다시 시도';
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = '마우스로 대신 진행';
    a.onclick = () => res('retry'); b.onclick = () => res('mouse');
    r.append(a, b); $('#setup-msg').append(p, r);
  });
}

async function beginWatching() {
  $('#screen-watch').hidden = false;
  $('#btn-done').hidden = false;
  $('#chip-src').textContent = S.source.mode === 'mouse' ? '시선: 마우스' : '시선: 웹캠';
  const host = $('#player');
  try {
    S.player = S.video.source === 'mp4' ? createMp4Player(host, S.video.url) : await createYouTubePlayer(host, S.video.yt);
  } catch (e) { toast('플레이어 오류: ' + e.message); return; }
  S.player.onEnded(finish);
  try {
    const r = await api.session({ videoUrl: S.video.url, videoTitle: S.player.title || S.video.title, source: S.video.source });
    S.session = r.sessionId;
  } catch (e) { toast('세션 생성 실패 (캡처 때 다시 시도해요): ' + e.message); }
  startTick();
  S.player.play();
}

// ---------- gaze loop ----------
const detector = new GazeEventDetector(onGazeEvent);
const dot = $('#gaze-dot');

function startTick() {
  if (S.tick) return;
  S.tick = setInterval(tick, 1000 / CONFIG.sampleHz);
}

function tick() {
  const raw = S.source && S.source.latest();
  const now = performance.now();
  if (!raw) { sm = null; win = []; dot.style.opacity = 0; detector.reset(); return; }
  const mouse = S.source.mode === 'mouse';
  const a = mouse ? CONFIG.smoothingAlphaMouse : CONFIG.smoothingAlpha;
  win.push(raw); if (win.length > (mouse ? CONFIG.medianWindowMouse : CONFIG.medianWindow)) win.shift();
  const med = (k) => { const v = win.map((p) => p[k]).sort((m, n) => m - n); return v[v.length >> 1]; };
  const mx = med('x'), my = med('y');
  sm = sm ? { x: sm.x + a * (mx - sm.x), y: sm.y + a * (my - sm.y) } : { x: mx, y: my };
  dot.style.opacity = 1;
  dot.style.transform = `translate(${sm.x}px, ${sm.y}px)`;

  const p = S.player;
  let inside = false;
  if (p && !S.finished && p.isPlaying()) {
    const r = p.contentRect();
    inside = sm.x >= r.left && sm.x <= r.left + r.width && sm.y >= r.top && sm.y <= r.top + r.height;
  }
  dot.classList.toggle('active', inside);
  if (inside) detector.push(now, sm.x, sm.y); else detector.reset();
  dot.style.setProperty('--p', (inside ? detector.fixProgress : 0) * 360 + 'deg');
  if (DEBUG) $('#hud').textContent = `gaze ${sm.x | 0},${sm.y | 0} inside=${inside} fix=${detector.fixProgress.toFixed(2)} sac=${detector.sacState}`;
}

// ---------- capture ----------
async function onGazeEvent(ev) {
  const p = S.player;
  if (!p || S.finished) return;
  const videoTime = p.time();
  let shot;
  try { shot = await grab(p, ev.x, ev.y); }
  catch (e) { toast('캡처 실패: ' + e.message); return; }
  const card = addCapture({ thumb: shot.image, videoTime, kind: ev.kind });
  try {
    if (!S.session) S.session = (await api.session({ videoUrl: S.video.url, videoTitle: S.video.title, source: S.video.source })).sessionId;
    const res = await api.capture({
      sessionId: S.session, videoUrl: S.video.url, videoTime: +videoTime.toFixed(2),
      capturedAt: new Date().toISOString(), kind: ev.kind, dwellMs: ev.dwellMs, gaze: shot.gaze, image: shot.image,
    });
    card.setResult(res);
    if (res.speak && res.say && !S.finished) {
      showBubble({ say: res.say, links: res.links, onReveal: () => card.showLinks(res.links) });
    }
  } catch (e) {
    card.setError();
    toast('서버 오류: ' + e.message);
  }
}

// ---------- summary ----------
async function finish() {
  if (S.finished) return;
  S.finished = true;
  dismissBubble();
  S.player && S.player.pause();
  $('#summary').hidden = false;
  $('#summary-body').innerHTML = '<p class="muted">정리하는 중이에요…</p>';
  try {
    if (!S.session) throw new Error('세션이 없어요');
    renderSummary(await api.summary({ sessionId: S.session }));
  } catch (e) {
    $('#summary-body').innerHTML = '';
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = '요약을 불러오지 못했어요: ' + e.message;
    const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = '다시 시도';
    b.onclick = () => { S.finished = false; finish(); };
    $('#summary-body').append(p, b);
    toast('요약 오류: ' + e.message);
  }
}
$('#btn-done').onclick = finish;
$('#btn-restart').onclick = () => { location.href = location.pathname + location.search; };

$('#chip-mode').hidden = !(MOCK || MOUSE);
$('#chip-mode').textContent = [MOCK && 'mock', MOUSE && 'mouse'].filter(Boolean).join('+');
$('#hud').hidden = !DEBUG;
loadVideos();
