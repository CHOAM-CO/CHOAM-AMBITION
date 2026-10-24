// DOM helpers: toasts, capture panel, agent bubble, summary.
import { CONFIG } from './events.js?v=r3';

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

let capCount = 0;
export function addCapture({ thumb, videoTime, kind }) {
  $('#captures-empty').hidden = true;
  const li = document.createElement('li');
  li.className = 'cap';
  li.innerHTML = '<img alt=""><div class="meta"><span class="time"></span><span class="kind"></span><strong class="label">분석 중…</strong><span class="desc"></span><div class="extra"></div></div>';
  li.querySelector('img').src = thumb;
  li.querySelector('.time').textContent = fmtTime(videoTime);
  li.querySelector('.kind').textContent = kind === 'fixation' ? '응시' : '시선 이동';
  $('#captures').prepend(li);
  $('#cap-count').textContent = ++capCount;
  return {
    setResult(res) {
      const lab = li.querySelector('.label');
      if (res.item) { lab.textContent = res.item.label; li.querySelector('.desc').textContent = res.item.description || ''; }
      else { lab.textContent = '인식된 물건 없음'; li.classList.add('none'); }
    },
    setError() { li.querySelector('.label').textContent = '분석 실패'; li.classList.add('none'); },
    showLinks(links) { const ex = li.querySelector('.extra'); ex.innerHTML = ''; ex.appendChild(linkList(links)); },
  };
}

let bubbleEl = null, bubbleTimer = null;
export const bubbleActive = () => !!bubbleEl;
export function dismissBubble() {
  clearTimeout(bubbleTimer);
  if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; }
}
export function showBubble({ say, links, onReveal }) {
  if (bubbleEl) return false; // one at a time
  const el = document.createElement('div');
  el.className = 'bubble';
  const p = document.createElement('p'); p.textContent = say;
  const row = document.createElement('div'); row.className = 'row';
  const yes = document.createElement('button'); yes.className = 'btn primary'; yes.textContent = '찾아봐';
  const no = document.createElement('button'); no.className = 'btn'; no.textContent = '괜찮아';
  no.onclick = dismissBubble;
  yes.onclick = () => {
    row.remove();
    if (links && links.length) el.appendChild(linkList(links));
    else { const e = document.createElement('p'); e.className = 'muted'; e.textContent = '아직 찾은 링크가 없어요.'; el.appendChild(e); }
    const close = document.createElement('button'); close.className = 'btn'; close.textContent = '닫기'; close.onclick = dismissBubble;
    el.appendChild(close);
    onReveal && onReveal();
  };
  row.append(yes, no);
  el.append(p, row);
  $('#bubble-slot').appendChild(el);
  bubbleEl = el;
  bubbleTimer = setTimeout(dismissBubble, CONFIG.bubbleTtlMs);
  return true;
}

export function renderSummary(data) {
  const box = $('#summary-body');
  box.innerHTML = '';
  const h = document.createElement('p'); h.className = 'say'; h.textContent = data.say || '';
  box.appendChild(h);
  const recs = data.recommendations || [];
  if (!recs.length) { const e = document.createElement('p'); e.className = 'muted'; e.textContent = '추천할 항목이 없어요.'; box.appendChild(e); }
  const grid = document.createElement('div'); grid.className = 'rec-grid';
  for (const r of recs) {
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
