// DOM helpers: toasts, capture panel, agent bubble, summary.
import { CONFIG } from './events.js?v=r17';

const $ = (s) => document.querySelector(s);
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');

export function toast(msg, ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function linkList(links) {
  const ul = document.createElement('ul');
  ul.className = 'links';
  for (const l of links || []) {
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = safeUrl(l.url); a.target = '_blank'; a.rel = 'noopener'; a.textContent = l.title || l.url;
    li.appendChild(a); ul.appendChild(li);
  }
  return ul;
}

export const CATEGORY_KO = { product: '상품', place: '장소', food: '음식', animal: '동물', text: '글자', person: '인물', scene: '장면', other: '기타' };
const catTag = (c) => (c ? CATEGORY_KO[c] || c : '');

let capCount = 0;
const setCount = () => { $('#cap-count').textContent = capCount; $('#chap-count').textContent = capCount; };
export function clearCaptures() {
  capCount = 0; setCount();
  $('#captures').innerHTML = ''; $('#captures-empty').hidden = false;
}

// ---- live-chat feed (right column): agent lines, the viewer's lines, capture events, item cards ----
const feed = () => $('#chat-feed');
export function chatClear() { feed().innerHTML = ''; }
function chatPush(el) {
  const f = feed(); f.appendChild(el);
  while (f.children.length > 200) f.firstChild.remove();
  f.scrollTop = f.scrollHeight;
  return el;
}
// Chzzk chat line: coloured nickname + text, one row per message, auto-scroll
function msgShell(cls, who) {
  const m = document.createElement('div'); m.className = 'msg ' + cls;
  const mb = document.createElement('div'); mb.className = 'mb';
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
  mb.appendChild(w); m.appendChild(mb);
  return { m, mb };
}
/** who: 'agent' | 'user' | 'sys' (gesture / event line). Agent and viewer lines also fly over the video as danmaku. returns {setText, setItems, remove} */
export function chatAdd({ who, text, items, links, dm = true }) {
  const { m, mb } = who === 'agent' ? msgShell('agent', '에이전트') : who === 'sys' ? msgShell('sys', '') : msgShell('user', '나');
  const t = document.createElement('span'); t.className = 'txt'; t.textContent = text || ''; mb.appendChild(t);
  if (dm && text && text !== '…') danmaku(text, who);
  const api = {
    setText(x) { t.textContent = x; feed().scrollTop = feed().scrollHeight; },
    setItems(its) {
      mb.querySelectorAll('.item, .lk').forEach((n) => n.remove());
      for (const it of its || []) {
        const c = document.createElement('div'); c.className = 'item';
        const n = document.createElement('strong'); n.textContent = it.name || ''; c.appendChild(n);
        if (it.price) { const p = document.createElement('span'); p.className = 'price'; p.textContent = it.price; c.appendChild(p); }
        const u = document.createElement('span'); u.className = 'plain-link'; u.textContent = `${it.source ? it.source + ' · ' : ''}${shortUrl(it.url)}`; c.appendChild(u);
        mb.appendChild(c);
      }
      feed().scrollTop = feed().scrollHeight;
    },
    remove() { m.remove(); },
  };
  if (items) api.setItems(items);
  if (links && links.length) api.setItems(links.map((l) => ({ name: l.title || '', url: l.url })));
  chatPush(m);
  return api;
}

// ---- danmaku: Bilibili/Niconico bullet comments over the video. Constant ~8 s pass, lanes in the top 2/3, no boxes ----
const DM_MS = 8000;
const lanes = []; // per lane: {t, w} of the last comment sent through it
let dmQ = [], dmTimer = null;
export function danmakuClear() { const l = $('#danmaku'); if (l) l.innerHTML = ''; lanes.length = 0; dmQ = []; }
function dmPlace(text, kind) {
  const layer = $('#danmaku'); if (!layer) return true;
  const W = layer.clientWidth, H = layer.clientHeight; if (!W) return true;
  const fs = Math.max(16, Math.round(W * 0.03)), laneH = Math.round(fs * 1.3), top0 = Math.round(fs * 1.3) + 22, n = Math.max(1, Math.floor((H * 0.66 - top0) / laneH)); // lanes start under the pinned question line
  const el = document.createElement('span'); el.className = 'dm ' + (kind === 'user' ? 'user' : kind === 'sys' ? 'sys' : 'agent');
  el.textContent = text.length > 70 ? text.slice(0, 70) + '…' : text; el.style.fontSize = (kind === 'sys' ? Math.round(fs * .85) : fs) + 'px';
  el.style.visibility = 'hidden'; layer.appendChild(el);
  const w = el.offsetWidth, now = performance.now();
  for (let i = 0; i < n; i++) {
    const l = lanes[i];
    // no collision with the previous comment in this lane: its tail is clear, and the newer (faster, if longer) one cannot catch up before it leaves
    const need = l ? DM_MS * Math.max(l.w / (W + l.w), w / (W + w)) + 300 : 0;
    if (l && now - l.t < need) continue;
    lanes[i] = { t: now, w };
    el.style.top = top0 + i * laneH + 'px'; el.style.setProperty('--dur', DM_MS + 'ms'); el.style.setProperty('--cw', W + 'px'); el.style.visibility = '';
    el.style.transform = ''; el.addEventListener('animationend', () => el.remove());
    return true;
  }
  el.remove(); return false;
}
export function danmaku(text, kind = 'agent', { transient = false } = {}) {
  if (!text) return;
  if (dmPlace(text, kind)) return;
  if (transient) return; // reactions are dropped when the lanes are busy
  dmQ.push({ text, kind }); if (dmQ.length > 4) dmQ.shift();
  if (!dmTimer) dmTimer = setInterval(() => {
    while (dmQ.length && dmPlace(dmQ[0].text, dmQ[0].kind)) dmQ.shift();
    if (!dmQ.length) { clearInterval(dmTimer); dmTimer = null; }
  }, 400);
}

export function addCapture({ thumb, videoTime, kind }) {
  $('#captures-empty').hidden = true;
  const li = document.createElement('li');
  li.className = 'cap';
  li.innerHTML = '<img alt=""><div class="meta"><span class="time"></span><span class="kind"></span><strong class="label">분석 중…</strong><span class="tag" hidden></span><span class="desc"></span><div class="extra"></div></div>';
  const img = li.querySelector('img');
  if (thumb) img.src = thumb; else img.classList.add('blank');
  img.onerror = () => img.classList.add('blank');
  li.querySelector('.time').textContent = fmtTime(videoTime);
  li.querySelector('.kind').textContent = kind === 'fixation' ? '응시' : '시선 이동';
  $('#captures').prepend(li);
  $('#captures').scrollTo({ left: 0, behavior: 'smooth' }); // newest first: keep it in view
  capCount++; setCount();
  // the same event as a live-chat message with its thumbnail
  const { m, mb } = msgShell('cap-msg', `장면 캡처 · ${fmtTime(videoTime)}`);
  const mini = document.createElement('div'); mini.className = 'mini';
  const mi = document.createElement('img'); mi.alt = ''; if (thumb) mi.src = thumb;
  const mt = document.createElement('div'); const ml = document.createElement('strong'); ml.textContent = '분석 중…'; const mg = document.createElement('span'); mg.className = 'tag'; mg.hidden = true;
  mt.append(ml, document.createElement('br'), mg); mini.append(mi, mt); mb.appendChild(mini);
  chatPush(m);
  return {
    setResult(res) {
      if (res.imageUrl && !thumb) { img.classList.remove('blank'); img.src = res.imageUrl; mi.src = res.imageUrl; }
      const lab = li.querySelector('.label');
      if (res.item) {
        lab.textContent = res.item.label; li.querySelector('.desc').textContent = res.item.description || '';
        const t = li.querySelector('.tag'); if (res.item.category) { t.textContent = catTag(res.item.category); t.hidden = false; mg.textContent = t.textContent; mg.hidden = false; }
        ml.textContent = res.item.label;
      } else { lab.textContent = '인식된 것 없음'; li.classList.add('none'); ml.textContent = '인식된 것 없음'; }
    },
    setError() { li.querySelector('.label').textContent = '분석 실패'; li.classList.add('none'); ml.textContent = '분석 실패'; },
    remove() { li.remove(); m.remove(); capCount--; setCount(); if (!capCount) $('#captures-empty').hidden = false; },
    thumbSrc: () => img.src,
    showLinks(links) { const ex = li.querySelector('.extra'); ex.innerHTML = ''; ex.appendChild(linkList(links)); },
  };
}

/** 관심 목록 (nod = add). Links are plain text: nothing on screen is clickable in the hands-free demo. */
const wishIds = new Set();
export function addWish({ id, thumb, label, category, links }) {
  if (id && wishIds.has(id)) return;
  if (id) wishIds.add(id);
  $('#wish-empty').hidden = true;
  const li = document.createElement('li');
  li.className = 'cap wish';
  const img = document.createElement('img'); img.alt = ''; if (thumb) img.src = thumb; else img.classList.add('blank');
  const m = document.createElement('div'); m.className = 'meta';
  const l = document.createElement('strong'); l.textContent = label || '';
  m.appendChild(l);
  if (category) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = catTag(category); m.appendChild(t); }
  for (const k of links || []) {
    const p = document.createElement('span'); p.className = 'plain-link';
    const u = (k.url || '').replace(/^https?:\/\//, '');
    p.textContent = `${k.title || ''} ${u.length > 44 ? u.slice(0, 44) + '…' : u}`.trim(); m.appendChild(p);
  }
  li.append(img, m);
  $('#wish').prepend(li);
  $('#wish-count').textContent = $('#wish').children.length;
  window.dispatchEvent(new CustomEvent('wish-added'));
}

/** transient reaction: a single danmaku line (dropped when the lanes are busy) */
export function alertPop({ text }) { danmaku(text, 'agent', { transient: true }); }

// live hand-gesture indicator next to the agent cam: emoji + name, ring fills while a held gesture is being held
const HAND = { Thumb_Up: ['👍', '좋아요'], Thumb_Down: ['👎', '별로'], Open_Palm: ['✋', '멈춤/재생'], Pointing_Up: ['☝️', '이거'], Victory: ['✌️', '다음'], Closed_Fist: ['✊', '주먹'], ILoveYou: ['🤟', '사랑해'] };
let handTimer = null;
export function handShow(name, progress = 0, mapped = true, hideMs = 450) {
  const el = $('#hand-ind'); if (!el) return;
  const [emo, label] = HAND[name] || ['🖐', name];
  el.hidden = false; el.classList.toggle('unmapped', !mapped);
  el.querySelector('.hi-emo').textContent = emo; el.querySelector('.hi-name').textContent = label;
  el.style.setProperty('--hp', Math.round(progress * 360) + 'deg');
  clearTimeout(handTimer); handTimer = setTimeout(() => { el.hidden = true; }, hideMs);
}
export function handHide() { /* feedback gap: the timer hides it */ }

// yes/no question: one small translucent line pinned at the top centre of the video, with a thin timeout underline
let bubbleEl = null, bubbleTimer = null, bubbleText = null;
export const bubbleActive = () => !!bubbleEl;
export function dismissBubble() {
  clearTimeout(bubbleTimer);
  if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; bubbleText = null; }
}
/** opens the question line; returns false if one is already open (one at a time) */
export function showBubble({ say, onYes, onNo, keys = '👍 / 👎' }) {
  if (bubbleEl) return false;
  const el = document.createElement('div'); el.className = 'ask';
  const W = ($('#danmaku') || {}).clientWidth || 800;
  el.style.fontSize = Math.max(16, Math.round(W * 0.03)) + 'px';
  bubbleText = document.createElement('span'); bubbleText.textContent = say;
  const k = document.createElement('span'); k.className = 'ask-keys';
  const y = document.createElement('span'); y.textContent = '👍'; y.onclick = onYes;
  const n = document.createElement('span'); n.textContent = '👎'; n.onclick = onNo;
  k.append(y, document.createTextNode(' / '), n);
  const bar = document.createElement('i'); bar.className = 'ask-bar'; bar.style.setProperty('--ttl', CONFIG.bubbleTtlMs + 'ms');
  el.append(bubbleText, k, bar);
  $('#bubble-slot').appendChild(el);
  bubbleEl = el;
  bubbleTimer = setTimeout(dismissBubble, CONFIG.bubbleTtlMs);
  return true;
}
/** change the question text (next alternative) */
export function bubbleSay(text) { if (bubbleText) bubbleText.textContent = text; }
/** answered: the question line goes away */
export function bubbleLock() { dismissBubble(); }
const shortUrl = (u) => { try { const x = new URL(u); return x.host.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 24) : ''); } catch { return (u || '').slice(0, 36); } };

let badgeTimer = null;
export function flashBadge(text, ok) {
  const el = $('#gesture-badge');
  el.textContent = text; el.className = 'show ' + (ok ? 'ok' : 'no');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => { el.className = ''; }, 1400);
}

export function renderSummary(data) {
  const box = $('#summary-body');
  box.innerHTML = '';
  const h = document.createElement('p'); h.className = 'say'; h.textContent = data.say || '';
  box.appendChild(h);
  const recs = data.recommendations || [];
  if (!recs.length) { const e = document.createElement('p'); e.className = 'muted'; e.textContent = '추천할 항목이 없어요.'; box.appendChild(e); }
  const grid = document.createElement('div'); grid.className = 'rec-grid';
  for (const r of recs.slice(0, 6)) { // gaze cannot scroll: keep it to what fits
    const c = document.createElement('article'); c.className = 'rec';
    const img = document.createElement('img'); img.alt = ''; img.src = r.imageUrl;
    const b = document.createElement('div'); b.className = 'meta';
    const t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(r.videoTime || 0);
    const l = document.createElement('strong'); l.textContent = r.label || '';
    const why = document.createElement('span'); why.className = 'desc'; why.textContent = r.reason || '';
    b.append(t, l, why, linkList(r.links));
    c.append(img, b); grid.appendChild(c);
  }
  box.appendChild(grid);
}

/** 장면 기록: chronological scene log (timestamp + summary + thumbnail) from GET /api/scene */
export function renderScenes(scenes) {
  const ol = $('#scenes'); if (!ol) return;
  ol.innerHTML = '';
  $('#scene-empty').hidden = !!scenes.length;
  $('#scene-count').textContent = scenes.length;
  for (const sc of scenes) {
    const li = document.createElement('li'); li.className = 'cap scene';
    const img = document.createElement('img'); img.alt = ''; img.src = sc.imageUrl || ''; img.onerror = () => img.classList.add('blank');
    const m = document.createElement('div'); m.className = 'meta';
    const t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(sc.videoTime || 0);
    const d = document.createElement('span'); d.className = 'sdesc';
    d.textContent = sc.summary || (sc.objects && sc.objects.length ? sc.objects.slice(0, 4).join(', ') : '(분석 중)');
    m.append(t, d); li.append(img, m); ol.appendChild(li);
  }
  const b = ol.parentElement; b.scrollTop = b.scrollHeight;
}
