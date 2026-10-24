// DOM helpers: toasts, capture panel, agent bubble, summary.
import { CONFIG } from './events.js?v=r15';

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
// Chzzk/Twitch-style chat line: [badge] nickname: text, nickname coloured per speaker, auto-scroll
function msgShell(cls, avatar, who, badge) {
  const m = document.createElement('div'); m.className = 'msg ' + cls;
  const av = document.createElement('span'); av.className = 'av'; av.textContent = avatar;
  const mb = document.createElement('div'); mb.className = 'mb';
  if (badge) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = badge; mb.appendChild(b); }
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
  mb.appendChild(w); m.append(av, mb);
  return { m, mb };
}
/** who: 'agent' | 'user' | 'sys' (gesture / event line). returns {setText, setItems, remove} */
export function chatAdd({ who, text, items, links, badge }) {
  const { m, mb } = who === 'agent' ? msgShell('agent', 'AI', '에이전트', 'AI')
    : who === 'sys' ? msgShell('sys', '', '', badge || '제스처')
    : msgShell('user', '나', '나', badge || '');
  const t = document.createElement('span'); t.className = 'txt'; t.textContent = text || ''; mb.appendChild(t);
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
  const { m, mb } = msgShell('cap-msg', '📷', `장면 캡처 · ${fmtTime(videoTime)}`, '📷');
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

// donation-alert header (Toonation/Twip style): agent avatar + name + amount-like badge
function donHead(badge) {
  const h = document.createElement('div'); h.className = 'don-head';
  const a = document.createElement('span'); a.className = 'don-av'; a.textContent = 'AI';
  const n = document.createElement('b'); n.textContent = '에이전트';
  const t = document.createElement('span'); t.className = 'don-badge'; t.textContent = badge;
  h.append(a, n, t); return h;
}

// transient donation alerts (reactions, acks): one at a time, queued so they never overlap
const alertQ = []; let alertBusy = false;
export function alertPop({ text, emoji = '💬', badge = '반응', ms = 2600 }) {
  if (alertQ.length >= 3) alertQ.shift();
  alertQ.push({ text, emoji, badge, ms }); nextAlert();
}
function nextAlert() {
  if (alertBusy || !alertQ.length) return;
  const { text, emoji, badge, ms } = alertQ.shift();
  alertBusy = true;
  const el = document.createElement('div'); el.className = 'don-alert';
  const big = document.createElement('div'); big.className = 'don-line'; big.textContent = `${emoji} ${text}`;
  el.append(donHead(badge), big);
  $('#alert-slot').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); alertBusy = false; nextAlert(); }, 300); }, ms);
}

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

let bubbleEl = null, bubbleTimer = null, bubbleText = null;
export const bubbleActive = () => !!bubbleEl;
export function dismissBubble() {
  clearTimeout(bubbleTimer);
  if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; bubbleText = null; }
}
/** opens the question bubble; returns false if one is already open (one at a time) */
export function showBubble({ say, onYes, onNo, yesLabel = '찾아봐', noLabel = '괜찮아', badge = '질문' }) {
  if (bubbleEl) return false;
  const el = document.createElement('div');
  el.className = 'bubble';
  bubbleText = document.createElement('p'); bubbleText.textContent = say;
  const row = document.createElement('div'); row.className = 'row'; row.dataset.role = 'choices';
  const yes = document.createElement('button'); yes.className = 'btn primary'; yes.textContent = yesLabel;
  const no = document.createElement('button'); no.className = 'btn'; no.textContent = noLabel;
  yes.onclick = onYes; no.onclick = onNo;
  row.append(yes, no);
  el.append(donHead(badge), bubbleText, row);
  $('#bubble-slot').appendChild(el);
  bubbleEl = el;
  bubbleTimer = setTimeout(dismissBubble, CONFIG.bubbleTtlMs);
  return true;
}
export function bubbleSay(text) { if (bubbleText) bubbleText.textContent = text; }
/** remove the yes/no buttons (answered) */
export function bubbleLock() { const r = bubbleEl && bubbleEl.querySelector('[data-role=choices]'); if (r) r.remove(); }
export function bubbleLinks(links) {
  if (!bubbleEl) return;
  bubbleLock();
  bubbleEl.querySelectorAll('.links, .muted, [data-role=close]').forEach((n) => n.remove());
  if (links && links.length) bubbleEl.appendChild(linkList(links));
  const close = document.createElement('button'); close.className = 'btn'; close.textContent = '닫기'; close.dataset.role = 'close'; close.onclick = dismissBubble;
  bubbleEl.appendChild(close);
}

/** voice-chat bubble: text first ("찾아보는 중…"), then reply + item cards. Replaces any open bubble. */
let chatTimer = null;
export function openChatBubble(text) {
  dismissBubble();
  const el = document.createElement('div');
  el.className = 'bubble chat';
  bubbleText = document.createElement('p'); bubbleText.textContent = text;
  el.append(donHead('답변'), bubbleText);
  $('#bubble-slot').appendChild(el);
  bubbleEl = el;
  bubbleTimer = setTimeout(dismissBubble, 60000);
  return el;
}
const shortUrl = (u) => { try { const x = new URL(u); return x.host.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 24) : ''); } catch { return (u || '').slice(0, 36); } };
export function updateChatBubble(el, { text, items, ttlMs = 25000 }) {
  if (el !== bubbleEl) return false; // replaced meanwhile
  bubbleText.textContent = text;
  el.querySelectorAll('.chat-items').forEach((n) => n.remove());
  if (items && items.length) {
    const box = document.createElement('div'); box.className = 'chat-items';
    for (const it of items) {
      const c = document.createElement('div'); c.className = 'chat-item';
      const n = document.createElement('strong'); n.textContent = it.name || '';
      c.appendChild(n);
      if (it.price) { const p = document.createElement('span'); p.className = 'price'; p.textContent = it.price; c.appendChild(p); }
      const u = document.createElement('span'); u.className = 'plain-link'; u.textContent = `${it.source ? it.source + ' · ' : ''}${shortUrl(it.url)}`; c.appendChild(u);
      box.appendChild(c);
    }
    el.appendChild(box);
  }
  clearTimeout(bubbleTimer); bubbleTimer = setTimeout(dismissBubble, ttlMs);
  return true;
}

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
