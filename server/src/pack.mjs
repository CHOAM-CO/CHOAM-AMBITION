// Per-video context pack: yt-dlp metadata + subtitles, then one Sonnet research pass (web search) for who/what + timely hooks.
// Built in the background (never blocks a request), cached on disk per youtubeId.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { config } from './config.mjs';
import * as yt from './youtube.mjs';
import { summaryModel, summaryPayload } from './ai.mjs';
import { webSearch, fetchPageText } from './chat.mjs';
import { kstFull, vpos } from './scene.mjs';

const log = (...a) => console.log(new Date().toISOString(), '[pack]', ...a);
const dir = () => path.join(config.dataDir, 'packs');
const file = (id) => path.join(dir(), `${id}.json`);
const mem = new Map();      // id -> pack (latest)
const building = new Map(); // id -> promise
const RESEARCH_MS = 90000;

export async function getPack(id) {
  if (!yt.validYtId(id)) return null;
  if (mem.has(id)) return mem.get(id);
  try { const p = JSON.parse(await fsp.readFile(file(id), 'utf8')); mem.set(id, p); return p; } catch { return null; }
}
async function save(p) { mem.set(p.id, p); await fsp.mkdir(dir(), { recursive: true }); const t = `${file(p.id)}.tmp`; await fsp.writeFile(t, JSON.stringify(p, null, 2)); await fsp.rename(t, file(p.id)); }

// Fire-and-forget: start building if there is no pack yet (or a failed one older than 10 min).
export function ensurePack(id) {
  if (!yt.validYtId(id) || building.has(id)) return;
  const pr = (async () => {
    const cur = await getPack(id);
    if (cur && (cur.status === 'ready' || (cur.status === 'meta' && Date.now() - cur.builtAt < 10 * 60000))) return;
    await build(id);
  })().catch((e) => log('build failed', id, e.message)).finally(() => building.delete(id));
  building.set(id, pr);
}
export const packStatus = async (id) => { const p = await getPack(id); return { id, status: p?.status || (building.has(id) ? 'building' : 'none') }; };

// ---- step 1: metadata + subtitles ----------------------------------------------------------------
function parseJson3(txt) {
  let j; try { j = JSON.parse(txt); } catch { return []; }
  const out = []; let last = '';
  for (const ev of j.events || []) {
    const text = (ev.segs || []).map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text || text === last) continue;
    last = text; out.push({ t: Math.round((ev.tStartMs || 0) / 100) / 10, text });
  }
  return out;
}

async function fetchMetaAndSubs(id) {
  const base = ['--no-playlist', '--skip-download', '--no-warnings', '--js-runtimes', `node:${process.execPath}`, '--cache-dir', config.ytCacheDir];
  const url = `https://www.youtube.com/watch?v=${id}`;
  const j = JSON.parse(await yt.run(yt.tool('yt-dlp'), [...base, '--dump-single-json', url], { timeoutMs: 60000 }));
  const meta = {
    title: j.title, channel: j.channel || j.uploader, description: String(j.description || '').slice(0, 2500),
    tags: (j.tags || []).slice(0, 30), categories: j.categories || [], chapters: (j.chapters || []).map((c) => ({ t: Math.round(c.start_time), title: c.title })),
    uploadDate: j.upload_date ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}` : null, duration: j.duration, liveStatus: j.live_status,
  };
  let subs = [], subLang = null;
  const tmp = path.join(dir(), `tmp_${id}`);
  try {
    await fsp.mkdir(tmp, { recursive: true });
    await yt.run(yt.tool('yt-dlp'), [...base, '--write-subs', '--write-auto-subs', '--sub-langs', 'ko,ko-orig,en,en-orig', '--sub-format', 'json3', '-o', path.join(tmp, '%(id)s'), url], { timeoutMs: 60000 }).catch((e) => log('subs failed', id, e.message));
    const files = (await fsp.readdir(tmp)).filter((f) => f.endsWith('.json3'));
    const pick = ['.ko.', '.ko-orig.', '.en.', '.en-orig.'].map((k) => files.find((f) => f.includes(k))).find(Boolean);
    if (pick) { subs = parseJson3(await fsp.readFile(path.join(tmp, pick), 'utf8')); subLang = pick.split('.').slice(-2, -1)[0]; }
  } catch (e) { log('subs parse failed', id, e.message); }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return { meta, subs, subLang };
}

// ---- step 2: research ---------------------------------------------------------------------------
const RESEARCH_SYSTEM = `You prepare a context pack for an assistant that watches a YouTube video together with a viewer. You get the video's metadata and subtitle excerpts, and the current date/time. Work fast (<= 4 tool calls; searches can run in parallel).
1. Work out what the video is: kind (interview | gameplay | esports | anime | music | vlog | news | review | haul | other), the topic, and the NAMED people / game titles / anime titles - ONLY as stated in the title, channel, description, tags or subtitles. Never infer a person from looks.
2. Use web_search (and fetch_url on a promising result if snippets lack the facts) to find 2-4 TIMELY hooks for a casual chat about it, anchored on TODAY's date: current events around the people/game/topic (e.g. a tournament in progress, a match played yesterday and its result, a release, a comeback, an anniversary). Facts must come from the search results; give the source URL. If nothing timely is found, return fewer hooks (or none) - never invent.
3. Call submit_pack once. All text Korean, short, casual-polite 해요체 for "offer"; "hook" is a plain fact line.`;

async function research(id, meta, subs) {
  let pack = null; const tools = [];
  const timed = (name, fn) => async (_i, p) => { const s = Date.now(); try { return await fn(p); } finally { tools.push(`${name}:${Date.now() - s}ms`); } };
  const T = (name, description, parameters, fn) => ({ name, label: name, description, parameters, execute: timed(name, fn) });
  const agent = new Agent({
    initialState: {
      systemPrompt: RESEARCH_SYSTEM, model: summaryModel, messages: [],
      tools: [
        T('web_search', 'Web search (title, url, snippet).', Type.Object({ query: Type.String() }), async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify(await webSearch(query)) }], details: {} })),
        T('fetch_url', 'Fetch a web page as plain text (first ~3500 chars).', Type.Object({ url: Type.String() }), async ({ url }) => { try { return { content: [{ type: 'text', text: await fetchPageText(url) }], details: {} }; } catch (e) { return { content: [{ type: 'text', text: `fetch failed: ${e.message}` }], details: {} }; } }),
        T('get_time', 'Current wall-clock time (Asia/Seoul).', Type.Object({}), async () => ({ content: [{ type: 'text', text: kstFull() }], details: {} })),
        {
          name: 'submit_pack', label: 'submit_pack', description: 'Final answer. Call exactly once.',
          parameters: Type.Object({
            kind: Type.String(), topic: Type.String({ description: 'one Korean line: what the video is about' }),
            people: Type.Array(Type.Object({ name: Type.String(), role: Type.String(), basis: Type.String({ description: 'title | description | subtitle | tags' }) })),
            titles: Type.Array(Type.String({ description: 'game / anime / show / song titles named in the metadata' })),
            hooks: Type.Array(Type.Object({ hook: Type.String(), offer: Type.String({ description: 'one yes/no question offering to look it up, e.g. 어제 경기 결과라도 찾아볼까요?' }), query: Type.String({ description: 'Korean web search query that would fetch the details if the viewer says yes' }), source: Type.String({ description: 'source URL' }) })),
          }),
          execute: async (_i, p) => { pack = p; return { content: [{ type: 'text', text: 'ok' }], details: {}, terminate: true }; },
        },
      ],
    },
    getApiKey: () => config.apiKey, onPayload: summaryPayload,
  });
  const subSample = subs.length ? subs.filter((_, i) => i % Math.max(1, Math.ceil(subs.length / 60)) === 0).map((s) => `[${vpos(s.t)}] ${s.text}`).join('\n').slice(0, 3500) : '(자막 없음)';
  const prompt = `현재: ${kstFull()}\n\n제목: ${meta.title}\n채널: ${meta.channel}\n업로드: ${meta.uploadDate}\n태그: ${meta.tags.join(', ')}\n챕터: ${meta.chapters.map((c) => `${vpos(c.t)} ${c.title}`).join(' | ') || '없음'}\n설명:\n${meta.description.slice(0, 1500)}\n\n자막 발췌:\n${subSample}`;
  const timer = setTimeout(() => agent.abort?.(), RESEARCH_MS);
  try { await agent.prompt(prompt); } finally { clearTimeout(timer); }
  return { pack, tools, error: agent.state.errorMessage };
}

async function build(id) {
  const t0 = Date.now();
  let base = await getPack(id);
  if (!base?.meta) {
    const { meta, subs, subLang } = await fetchMetaAndSubs(id);
    base = { id, status: 'meta', builtAt: Date.now(), meta, subLang, subs };
    await save(base);
    log(`${id} meta ready in ${Date.now() - t0}ms: "${meta.title}" subs=${subs.length}(${subLang})`);
  }
  const ts = Date.now();
  const r = await research(id, base.meta, base.subs);
  if (r.pack) {
    await save({ ...base, status: 'ready', builtAt: Date.now(), about: { kind: r.pack.kind, topic: r.pack.topic, people: r.pack.people, titles: r.pack.titles }, hooks: (r.pack.hooks || []).slice(0, 4), builtOn: kstFull(), researchMs: Date.now() - ts, tools: r.tools });
    log(`${id} ready: research ${Date.now() - ts}ms tools=[${r.tools.join(',')}] hooks=${r.pack.hooks?.length || 0}`);
  } else {
    await save({ ...base, builtAt: Date.now(), researchError: r.error || 'no pack submitted' });
    log(`${id} research failed: ${r.error || 'no pack'}`);
  }
}

// ---- prompt block --------------------------------------------------------------------------------
export function contentBlock(pack, videoTime) {
  if (!pack?.meta) return '(영상 정보를 아직 준비 중이에요. 화면과 제목만 참고하세요.)';
  const m = pack.meta, L = [];
  L.push(`제목: ${m.title} | 채널: ${m.channel || '?'} | 업로드: ${m.uploadDate || '?'}${m.tags?.length ? ` | 태그: ${m.tags.slice(0, 10).join(', ')}` : ''}`);
  if (pack.about) {
    L.push(`종류: ${pack.about.kind} | 내용: ${pack.about.topic}`);
    if (pack.about.people?.length) L.push(`등장인물(메타데이터 근거): ${pack.about.people.map((p) => `${p.name}(${p.role}, 근거: ${p.basis})`).join(', ')}`);
    if (pack.about.titles?.length) L.push(`작품/게임: ${pack.about.titles.join(', ')}`);
  } else L.push(`설명: ${m.description.slice(0, 400).replace(/\s+/g, ' ')}`);
  const ch = (m.chapters || []).filter((c) => c.t <= videoTime).pop(); if (ch) L.push(`현재 챕터: ${ch.title}`);
  if (pack.hooks?.length) L.push('시의성 있는 화제 (출처 확인된 것만, 검색 오퍼에 쓸 수 있음):\n' + pack.hooks.map((h, i) => `  ${i + 1}. ${h.hook} -> 오퍼: "${h.offer}" (검색어: ${h.query})`).join('\n'));
  const vt = Number(videoTime) || 0;
  const near = (pack.subs || []).filter((s) => s.t >= vt - 20 && s.t <= vt + 20);
  if (near.length) L.push(`자막 (현재 ±20초):\n` + near.slice(0, 24).map((s) => `  [${vpos(s.t)}] ${s.text}`).join('\n'));
  return L.join('\n');
}
