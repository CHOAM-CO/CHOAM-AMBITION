// Voice chat: viewer text (browser STT) -> addressed? -> chat reply (Haiku, one call) or tool agent (Sonnet) with Danawa / web search.
import { completeSimple, Type } from '@mariozechner/pi-ai';
import { Agent } from '@mariozechner/pi-agent-core';
import { config } from './config.mjs';
import * as store from './store.mjs';
import * as yt from './youtube.mjs';
import { visionModel, summaryModel, visionPayload, summaryPayload, parseJson, textOf, normLabel } from './ai.mjs';

const log = (...a) => console.log(new Date().toISOString(), '[chat]', ...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const decode = (t) => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const won = (n) => `${Number(n).toLocaleString('en-US')}원`;

async function fetchText(url, ms = 8000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export async function danawaSearch(query) {
  const searchUrl = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(query)}`;
  try {
    const html = await fetchText(searchUrl);
    const chunks = html.split(/<li[^>]*class="[^"]*prod_item[^"]*"/).slice(1);
    const out = [];
    for (const c of chunks) {
      const pc = /id="min_price_(\d+)"\s+value="(\d+)"/.exec(c);
      const nm = /<p class="prod_name">([\s\S]*?)<\/p>/.exec(c);
      if (!pc || !nm) continue;
      out.push({ name: decode(nm[1]).slice(0, 120), price: won(pc[2]), url: `https://prod.danawa.com/info/?pcode=${pc[1]}`, source: 'danawa' });
      if (out.length >= 5) break;
    }
    if (out.length) return { results: out, searchUrl };
  } catch (e) { log('danawa failed', e.message); }
  return { results: [{ name: `다나와 검색: ${query}`, url: searchUrl, source: 'danawa' }], searchUrl, note: 'parsing failed; only the search URL is available' };
}

export async function webSearch(query) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const html = await fetchText(searchUrl);
    const out = [];
    for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      let u = m[1].replace(/&amp;/g, '&');
      const g = /[?&]uddg=([^&]+)/.exec(u); if (g) u = decodeURIComponent(g[1]);
      if (u.startsWith('//')) u = 'https:' + u;
      if (!/^https?:\/\//.test(u)) continue;
      out.push({ name: decode(m[2]).slice(0, 120), url: u, source: 'web' });
      if (out.length >= 5) break;
    }
    if (out.length) return { results: out };
  } catch (e) { log('web search failed', e.message); }
  return { results: [{ name: `웹 검색: ${query}`, url: `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`, source: 'naver' }], note: 'search results unavailable; only the search URL' };
}

const GATE_SYSTEM = `You are the voice of a friendly shopping/video assistant that watches a video together with the viewer. The viewer speaks; you receive speech-to-text. The microphone also picks up the VIDEO'S OWN AUDIO (narration, vlogger talk, music lyrics), so first decide whether the text is the viewer addressing the assistant.
addressed=true: a question or request to the assistant (찾아줘, 알려줘, 이거 뭐야, 얼마야...), a reaction/comment to the assistant about what is on screen, or a follow-up in the ongoing conversation.
addressed=false: sounds like the video's narration or presenter talk (greetings to 여러분/구독자, describing their own purchases, "저는/제가 ... 했는데"), song lyrics, fragments, or unrelated noise.
needsTools=true when answering needs a live lookup: product model name + price, where to buy, anything requiring the web or a price comparison.
Answer with ONE JSON object only: {"addressed": bool, "needsTools": bool, "reply": string|null}
reply (only when addressed and not needsTools): natural Korean polite speech (해요체), 1-3 short sentences, spoken aloud by TTS: no markdown, no URLs, no emoji, no lists. You may look at the attached frame (full frame, and a crop around the viewer's gaze ring - never mention the ring). Never identify real people by face. Otherwise null.`;

const AGENT_SYSTEM = `You are the voice assistant of a viewer who is watching a video; the viewer just asked you something that needs a lookup. You see the current frame (and a crop around the viewer's gaze ring; the ring is only a gaze marker, never mention it).
Work fast: ideally ONE search call then answer (each extra round trip costs seconds). You may call tools in parallel.
1. Work out WHAT they mean (the thing near the gaze ring unless they say otherwise). Identify the exact model if possible: logo, shape, text in the frame, the video title, recent labels. Say so honestly if you can only narrow it down.
2. For prices of products call danawa_search with the best model-name query (Korean/English model number beats generic words). Only retry with a different query if the results are empty or clearly unrelated. web_search is for other facts. look_at_screen re-shows the images.
3. Finish with answer(): reply = 1-3 short natural Korean polite sentences (해요체) for TTS: say the product name and the lowest price you found; NO markdown, NO URLs, NO emoji. items = the best 1-5 results copied from the tool results (name, price, url, source exactly as returned). Never invent prices or URLs. If nothing reliable was found, say so and give the search link item.`;

const b64 = (buf) => buf.toString('base64');
const img = (buf) => ({ type: 'image', data: b64(buf), mimeType: 'image/jpeg' });

function historyText(chat) {
  const h = (chat || []).slice(-20);
  return h.length ? h.map((t) => `${t.role === 'user' ? '시청자' : '어시스턴트'}: ${t.text}`).join('\n') : '(없음)';
}

export async function handleChat(body, { HttpError }) {
  const t0 = Date.now();
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  if (!text) throw new HttpError(400, 'text required');

  // frames (never fatal)
  let frames = { full: null, crop: null };
  try { frames = await yt.grabFrames({ youtubeId: body.youtubeId, videoUrl: body.videoUrl || session.videoUrl }, body.videoTime, body.gaze); }
  catch (e) { log('frame grab failed:', e.message); }
  const tFrame = Date.now() - t0;

  const caps = (await store.getCaptures(session)).slice(-6);
  const recent = caps.filter((c) => c.item).map((c) => `${c.item.label} (${c.item.category})`);
  const ctx = `영상 제목: ${body.videoTitle || session.videoTitle || '(알 수 없음)'}\n재생 시각: ${Math.round(Number(body.videoTime) || 0)}초\n최근 시선이 머문 것들: ${recent.length ? recent.join(', ') : '(없음)'}\n최근 대화:\n${historyText(session.chat)}\n\n시청자 발화: "${text}"`;
  const images = [frames.full, frames.crop].filter(Boolean).map(img);
  const note = images.length ? (frames.crop ? '첫 이미지는 현재 전체 프레임, 두 번째는 시선 주변 확대 크롭이에요.' : '이미지는 현재 전체 프레임이에요.') : '(프레임을 가져오지 못했어요)';

  // 1) gate + chat reply in one cheap call
  const tg = Date.now();
  const res = await completeSimple(visionModel, {
    systemPrompt: GATE_SYSTEM,
    messages: [{ role: 'user', timestamp: Date.now(), content: [...images, { type: 'text', text: `${note}\n${ctx}` }] }],
  }, { apiKey: config.apiKey, maxTokens: 500, onPayload: visionPayload });
  if (res.stopReason === 'error') throw new HttpError(502, res.errorMessage || 'chat model failed');
  const g = parseJson(textOf(res));
  const gateMs = Date.now() - tg;
  if (!g.addressed) {
    log(`ignored "${text.slice(0, 40)}" frame=${tFrame}ms gate=${gateMs}ms total=${Date.now() - t0}ms`);
    return { reply: '', speak: false, ignored: true, items: [] };
  }

  let reply, items = [], captureId, mode = 'chat', agentMs = 0, tools = [];
  if (!g.needsTools && g.reply) {
    reply = String(g.reply);
  } else {
    mode = 'agent';
    const ta = Date.now();
    const seen = new Set(); let answer = null;
    const track = (r) => { for (const x of r.results || []) seen.add(x.url); if (r.searchUrl) seen.add(r.searchUrl); return r; };
    const timed = (name, fn) => async (_id, params) => { const s = Date.now(); const out = await fn(params); tools.push(`${name}:${Date.now() - s}ms`); return out; };
    const tool = (name, description, parameters, fn) => ({ name, label: name, description, parameters, execute: timed(name, fn) });
    const agent = new Agent({
      initialState: {
        systemPrompt: AGENT_SYSTEM, model: summaryModel, messages: [],
        tools: [
          tool('danawa_search', 'Search Danawa (Korean price comparison). Returns up to 5 products with lowest price and product URL.', Type.Object({ query: Type.String() }),
            async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify(track(await danawaSearch(query))) }], details: {} })),
          tool('web_search', 'General web search. Returns up to 5 titles + urls.', Type.Object({ query: Type.String() }),
            async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify(track(await webSearch(query))) }], details: {} })),
          tool('look_at_screen', 'Returns the current video frame and the gaze crop again.', Type.Object({}),
            async () => ({ content: [{ type: 'text', text: 'Current frame and gaze crop:' }, ...images], details: {} })),
          {
            name: 'answer', label: 'answer', description: 'Final spoken answer + result items. Call exactly once.',
            parameters: Type.Object({
              reply: Type.String({ description: '1-3 short Korean polite sentences, no markdown/URLs/emoji' }),
              focus: Type.Optional(Type.String({ description: 'Short Korean label of the product/thing the viewer meant' })),
              items: Type.Array(Type.Object({ name: Type.String(), price: Type.Optional(Type.String()), url: Type.String(), source: Type.String() })),
            }),
            execute: async (_id, p) => { answer = p; return { content: [{ type: 'text', text: 'ok' }], details: {}, terminate: true }; },
          },
        ],
      },
      getApiKey: () => config.apiKey,
      onPayload: summaryPayload,
    });
    await agent.prompt(`${note}\n${ctx}`, images);
    agentMs = Date.now() - ta;
    if (answer) {
      reply = answer.reply;
      items = (answer.items || []).filter((i) => i && /^https?:\/\//.test(i.url) && seen.has(i.url)).slice(0, 5).map((i) => ({ name: i.name, ...(i.price ? { price: i.price } : {}), url: i.url, source: i.source }));
      if (items.length || answer.focus) {
        // keep what the viewer asked about for the summary: stored as a strong-interest capture
        try {
          if (frames.crop || frames.full) {
            captureId = store.newId('c');
            const jpeg = frames.crop || frames.full;
            const label = answer.focus || items[0]?.name;
            const meta = {
              captureId, sessionId: session.id, videoUrl: body.videoUrl || session.videoUrl, videoTime: Number(body.videoTime) || 0,
              capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), kind: 'chat', dwellMs: 4000,
              gaze: { x: Number(body.gaze?.x) || 0, y: Number(body.gaze?.y) || 0 }, imageUrl: `/api/img/${session.id}/${captureId}.jpg`,
              bytes: jpeg.length, alternatives: [], item: label ? { label, category: 'product', description: reply } : null,
              clear: !!label, confidence: 0.9, query: label || null, chat: true, speak: false, say: null,
            };
            await store.saveCapture(meta, jpeg);
            await store.withSession(session.id, async () => {
              const s = await store.getSession(session.id);
              s.captureIds.push(captureId);
              if (label && !(s.labels || (s.labels = [])).some((x) => normLabel(x) === normLabel(label))) s.labels.push(label);
              await store.saveSession(s);
            });
          }
        } catch (e) { log('capture store failed', e.message); captureId = undefined; }
      }
    } else {
      reply = agent.state.errorMessage ? '지금은 찾아보기 어렵네요. 잠시 후에 다시 말씀해 주세요.' : '잘 못 찾았어요. 다시 한 번 말씀해 주시겠어요?';
    }
  }

  await store.withSession(session.id, async () => {
    const s = await store.getSession(session.id);
    const at = new Date().toISOString();
    s.chat = [...(s.chat || []), { role: 'user', text, at, videoTime: Number(body.videoTime) || 0 }, { role: 'assistant', text: reply, items, at }].slice(-50);
    await store.saveSession(s);
  });
  log(`${mode} "${text.slice(0, 40)}" frame=${tFrame}ms gate=${gateMs}ms agent=${agentMs}ms tools=[${tools.join(',')}] items=${items.length} total=${Date.now() - t0}ms`);
  return { reply, speak: true, ignored: false, items, ...(captureId ? { captureId } : {}) };
}
