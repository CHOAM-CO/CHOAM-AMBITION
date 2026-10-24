// In-page article reading: resolve Google News redirect links to the publisher URL, extract readable content, 2-sentence Haiku summary.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { completeSimple } from '@mariozechner/pi-ai';
import { config } from './config.mjs';
import { visionModel, visionPayload, textOf } from './ai.mjs';

const log = (...a) => console.log(new Date().toISOString(), '[article]', ...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const resolved = new Map(); // google url -> real url
const cache = new Map();    // real url -> result
const inflight = new Map();

const isGoogleNews = (u) => { try { const x = new URL(u); return x.hostname === 'news.google.com' && /\/articles\//.test(x.pathname); } catch { return false; } };

// Google serves a JS interstitial for /rss/articles/<id>; its own page JS calls batchexecute with a per-article signature. Do the same.
export async function resolveUrl(u, ms = 4000) {
  if (!isGoogleNews(u)) return u;
  if (resolved.has(u)) return resolved.get(u);
  try {
    const id = new URL(u).pathname.split('/articles/')[1].split('/')[0];
    const sig = AbortSignal.timeout(ms);
    const page = await (await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'user-agent': UA }, signal: sig })).text();
    const sg = /data-n-a-sg="([^"]+)"/.exec(page)?.[1], ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
    if (!sg || !ts) throw new Error('no signature in interstitial');
    const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
    const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA }, body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]])), signal: sig });
    const txt = (await r.text()).replace(/^\)\]\}'\s*/, '');
    const rows = JSON.parse(txt);
    const row = rows.find((x) => x[0] === 'wrb.fr');
    const real = JSON.parse(row[2])[1];
    if (!/^https?:\/\//.test(real)) throw new Error('bad url from google');
    resolved.set(u, real);
    return real;
  } catch (e) { log('resolve failed', e.message); return u; }
}

async function fetchHtml(url, ms) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5', accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer()).subarray(0, 3_000_000);
  let cs = /charset=([\w-]+)/i.exec(r.headers.get('content-type') || '')?.[1];
  if (!cs) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  let html; try { html = new TextDecoder(cs || 'utf-8').decode(buf); } catch { html = buf.toString('utf8'); }
  return { html, finalUrl: r.url };
}

const meta = (doc, ...names) => { for (const n of names) { const el = doc.querySelector(`meta[property="${n}"],meta[name="${n}"]`); const v = el?.getAttribute('content'); if (v && v.trim()) return v.trim(); } return null; };

async function summarize(title, paragraphs) {
  const body = paragraphs.join('\n').slice(0, 4000);
  const res = await completeSimple(visionModel, {
    systemPrompt: '뉴스 기사 본문을 읽고 한국어 해요체로 정확히 2문장 요약해요. TTS로 읽히니 마크다운/URL/이모지 없이, 각 문장은 짧게(60자 안팎). 본문에 없는 내용은 쓰지 마요. 요약문만 출력.',
    messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: `제목: ${title}\n\n${body}` }] }],
  }, { apiKey: config.apiKey, maxTokens: 250, onPayload: visionPayload });
  if (res.stopReason === 'error') throw new Error(res.errorMessage || 'summary failed');
  const sents = textOf(res).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g);
  return sents ? sents.slice(0, 2).join(' ').trim() : textOf(res).trim(); // hard cap: 2 sentences
}

async function read(url, totalMs) {
  const t0 = Date.now(); const left = () => Math.max(1000, totalMs - (Date.now() - t0));
  const real = await resolveUrl(url, 3500);
  if (isGoogleNews(real)) return { error: 'could not resolve publisher url', url: real };
  const { html, finalUrl } = await fetchHtml(real, Math.min(5000, left()));
  const { document } = parseHTML(html);
  const og = { title: meta(document, 'og:title'), site: meta(document, 'og:site_name'), image: meta(document, 'og:image'), published: meta(document, 'article:published_time', 'og:article:published_time', 'pubdate', 'date') || document.querySelector('time[datetime]')?.getAttribute('datetime') || null };
  let art = null;
  try { art = new Readability(document).parse(); } catch (e) { log('readability failed', e.message); }
  const text = (art?.textContent || '').replace(/\r/g, '');
  const paragraphs = text.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 25).slice(0, 12);
  if (!paragraphs.length) return { error: 'no readable article text', url: finalUrl };
  const title = (art?.title || og.title || '').trim();
  const out = { url: finalUrl, site: og.site || art?.siteName || new URL(finalUrl).hostname.replace(/^www\./, ''), title, byline: art?.byline?.trim() || null, publishedAt: og.published, image: og.image, paragraphs, summary: null };
  try { out.summary = await Promise.race([summarize(title, paragraphs), new Promise((_, rej) => setTimeout(() => rej(new Error('summary timeout')), left()))]); } catch (e) { log('summary failed', e.message); }
  log(`${finalUrl} ${Date.now() - t0}ms paras=${paragraphs.length} summary=${!!out.summary}`);
  return out;
}

export function readArticle(url, totalMs = 8000) {
  if (!/^https?:\/\//.test(String(url || ''))) return Promise.resolve({ error: 'bad url', url });
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);
  const p = read(url, totalMs).catch((e) => ({ error: String(e.message || e).slice(0, 160), url })).then((r) => {
    if (!r.error) { cache.set(url, r); cache.set(r.url, r); if (cache.size > 200) cache.delete(cache.keys().next().value); }
    return r;
  }).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}
