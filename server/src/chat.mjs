// Voice chat: viewer text (browser STT) -> addressed? -> chat reply (Haiku, one call) or tool agent (Sonnet) with Danawa / web search.
import { completeSimple, Type } from '@mariozechner/pi-ai';
import { Agent } from '@mariozechner/pi-agent-core';
import { config } from './config.mjs';
import * as store from './store.mjs';
import * as yt from './youtube.mjs';
import { nowLine, memoryBlock, kstFull } from './scene.mjs';
import { getPack, ensurePack, contentBlock } from './pack.mjs';
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

export async function fetchPageText(url, max = 3500) {
  const html = await fetchText(url, 8000);
  return decode(html.replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')).slice(0, max);
}

async function ddgSearch(query) {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const out = [];
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let u = m[1].replace(/&amp;/g, '&');
    const g = /[?&]uddg=([^&]+)/.exec(u); if (g) u = decodeURIComponent(g[1]);
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//.test(u)) continue;
    const tail = html.slice(m.index, m.index + 2500);
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(tail);
    out.push({ name: decode(m[2]).slice(0, 120), url: u, source: 'web', ...(sn ? { snippet: decode(sn[1]).slice(0, 240) } : {}) });
    if (out.length >= 5) break;
  }
  return out;
}

// Google News RSS (Korean): fresh headlines with dates (headlines usually carry scores/outcomes). Falls back to a shorter query when empty.
async function newsSearch(query) {
  const one = async (q) => {
    const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`);
    const out = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const g = (t) => { const r = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(m[1]); return r ? decode(r[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : ''; };
      const link = g('link'), title = g('title'); if (!link || !title) continue;
      const pd = g('pubDate'); const d = pd ? new Date(pd) : null;
      out.push({ name: title.slice(0, 140), url: link, source: g('source') || 'news', ...(d && !isNaN(d) ? { published: d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) + ' KST' } : {}) });
      if (out.length >= 6) break;
    }
    return out;
  };
  let r = await one(query);
  if (!r.length) { const short = query.split(/\s+/).slice(0, 3).join(' '); if (short && short !== query) r = await one(short); }
  return r;
}

export async function webSearch(query) {
  const [news, web] = await Promise.all([newsSearch(query).catch((e) => { log('news search failed', e.message); return []; }), ddgSearch(query).catch((e) => { log('web search failed', e.message); return []; })]);
  const out = [...news.slice(0, 5), ...web.slice(0, 4)];
  if (out.length) return { results: out };
  return { results: [{ name: `웹 검색: ${query}`, url: `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`, source: 'naver' }], note: 'search results unavailable; only the search URL. Try a shorter/broader query once.' };
}

const GATE_SYSTEM = `You are the voice of a friendly shopping/video assistant that watches a video together with the viewer. The viewer speaks; you receive speech-to-text. The microphone also picks up the VIDEO'S OWN AUDIO (narration, vlogger talk, music lyrics), so first decide whether the text is the viewer addressing the assistant.
addressed=true: a question or request to the assistant (찾아줘, 알려줘, 이거 뭐야, 얼마야...), a reaction/comment to the assistant about what is on screen, or a follow-up in the ongoing conversation.
If the viewer accepts the pending offer, set needsTools=true.
addressed=false: sounds like the video's narration or presenter talk (greetings to 여러분/구독자, describing their own purchases, "저는/제가 ... 했는데"), song lyrics, fragments, or unrelated noise.
needsTools=true when answering needs a live lookup: product model name + price, where to buy, anything requiring the web or a price comparison.
Answer with ONE JSON object only: {"addressed": bool, "needsTools": bool, "reply": string|null}
reply (only when addressed and not needsTools): natural Korean polite speech (해요체), 1-3 short sentences, spoken aloud by TTS: no markdown, no URLs, no emoji, no lists. You may look at the attached frame (full frame, and a crop around the viewer's gaze ring - never mention the ring). Never identify real people by face. Never guess brands or model names: name a brand/model only if its logo or text is clearly legible in the frame; otherwise describe generically (e.g. "수납함", "모니터 암"). Focus on the CONTENT of the video (who / what / why it matters), NOT on products: talk shopping, prices or links only when the viewer asks or it is clearly a product video (haul/review). People are named ONLY if the 영상 맥락 (title, description, subtitles, on-screen text) names them and what is visible fits; never from a face alone, otherwise describe generically. Name games/anime only from the context or legible on-screen text. "에이전트가 방금 시청자에게 한 제안" is an offer you made; if the viewer accepts it (응/네/좋아/찾아줘/yes) that is a lookup request for that offer's search query. Otherwise null.
The user message has "현재 시각" (Asia/Seoul wall clock), "현재 영상 위치" and a chronological "장면 메모리" (oldest to newest: scene transcripts, what the viewer looked at, their yes/no feedback), each line stamped [HH:MM:SS 실제시각 (N분 N초 전) | 영상 1분 35초]. Answer questions about earlier moments from it ("아까 그 빨간 가방 몇 분에 나왔지?", "아까 본 장면들 시간순으로 말해줘", "5분 전에 본 거 뭐였지?") and about the time ("지금 몇 시야?" -> read the exact 시 and 분 from the 현재 시각 line, e.g. 오후 1시 00분; no rounding, no hedging like 전/쯤/거의, never guess the hour or am/pm yourself). Resolve "N분 전 / 아까 / 방금 / 처음에 / 마지막으로" against the wall-clock ages in parentheses (pick the entry whose age is closest to N minutes), and "영상 N분쯤 / N분 장면" against the 영상 position. List items in chronological order. Say video positions naturally as written in the memory ("1분 35초", "20초"), never "00분 20초". Never invent entries that are not in the memory; if nothing matches, say so.`;

const AGENT_SYSTEM = `You are the voice assistant of a viewer who is watching a video; the viewer just asked you something that needs a lookup. You see the current frame (and a crop around the viewer's gaze ring; the ring is only a gaze marker, never mention it).
Work fast: ideally ONE search call then answer (each extra round trip costs seconds). You may call tools in parallel.
1. Work out WHAT they mean (the thing near the gaze ring unless they say otherwise). Identify the exact model if possible: logo, shape, text in the frame, the video title, recent labels. Say so honestly if you can only narrow it down.
2. If the viewer accepted a pending offer (see 에이전트가 방금 시청자에게 한 제안), run its search with web_search (news/results/scores/facts; fetch_url a result when snippets lack the facts) and reply with the concrete findings: who/what, score or outcome, date. Otherwise for prices of products call danawa_search with the best model-name query (Korean/English model number beats generic words). Only retry with a different query if the results are empty or clearly unrelated. web_search is for other facts and news; fetch_url reads one page. look_at_screen re-shows the images.
3. Finish with answer(): reply = 1-3 short natural Korean polite sentences (해요체) for TTS: say the product name and the lowest price you found; NO markdown, NO URLs, NO emoji. items = the best 1-5 results copied from the tool results (name, price, url, source exactly as returned). Never invent prices or URLs. If nothing reliable was found, say so and give the search link item.
The user message has "현재 시각" (Asia/Seoul wall clock), "현재 영상 위치" and a chronological "장면 메모리" (oldest to newest: scene transcripts, what the viewer looked at, their yes/no feedback), each line stamped [HH:MM:SS 실제시각 (N분 N초 전) | 영상 1분 35초]. Answer questions about earlier moments from it ("아까 그 빨간 가방 몇 분에 나왔지?", "아까 본 장면들 시간순으로 말해줘", "5분 전에 본 거 뭐였지?") and about the time ("지금 몇 시야?" -> read the exact 시 and 분 from the 현재 시각 line, e.g. 오후 1시 00분; no rounding, no hedging like 전/쯤/거의, never guess the hour or am/pm yourself). Resolve "N분 전 / 아까 / 방금 / 처음에 / 마지막으로" against the wall-clock ages in parentheses (pick the entry whose age is closest to N minutes), and "영상 N분쯤 / N분 장면" against the 영상 position. List items in chronological order. Say video positions naturally as written in the memory ("1분 35초", "20초"), never "00분 20초". Never invent entries that are not in the memory; if nothing matches, say so. get_time returns the wall clock.`;

const b64 = (buf) => buf.toString('base64');
const img = (buf) => ({ type: 'image', data: b64(buf), mimeType: 'image/jpeg' });

function historyText(chat) {
  const h = (chat || []).slice(-20);
  return h.length ? h.map((t) => `${t.role === 'user' ? '시청자' : '어시스턴트'}: ${t.text}`).join('\n') : '(없음)';
}

// Frames + textual context shared by /api/chat and /api/voice/turn.
export async function buildContext(session, body, trigger = 'user', framesPromise = null) {
  const t0 = Date.now();
  let frames = { full: null, crop: null };
  try { frames = await (framesPromise || yt.grabFrames({ youtubeId: body.youtubeId, videoUrl: body.videoUrl || session.videoUrl }, body.videoTime, body.gaze)); }
  catch (e) { log('frame grab failed:', e.message); }
  const fresh = (await store.getSession(session.id)) || session; // scenes may have landed since the caller read the session
  const allCaps = await store.getCaptures(fresh);
  const caps = allCaps.slice(-6);
  const recent = caps.filter((c) => c.item).map((c) => `${c.item.label} (${c.item.category})`);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  const ytId = body.youtubeId || yt.parseYtInput(session.videoUrl);
  let pack = null; if (ytId) { pack = await getPack(ytId); if (!pack || pack.status !== 'ready') ensurePack(ytId); }
  const offer = fresh.pendingOffer && Date.now() - fresh.pendingOffer.at < 5 * 60000 ? fresh.pendingOffer : null;
  const ctx = `${nowLine(body.videoTime)}\n영상 맥락 (메타데이터/자막/조사 결과 - 사람은 여기에 이름이 있을 때만 이름으로 부르세요):\n${ytId ? contentBlock(pack, body.videoTime) : '(영상 메타데이터 없음)'}\n${offer ? `에이전트가 방금 시청자에게 한 제안 (아직 답 없음): "${offer.say}" (검색어: ${offer.query || '?'})\n` : ''}영상 제목: ${body.videoTitle || session.videoTitle || '(알 수 없음)'}\n재생 시각: ${Math.round(Number(body.videoTime) || 0)}초\n최근 시선이 머문 것들: ${recent.length ? recent.join(', ') : '(없음)'}\n장면 메모리 (오래된 것 → 최신, 실제시각은 한국 시간):\n${memoryBlock(fresh, allCaps)}\n최근 대화:\n${historyText(session.chat)}\n\n${trigger === 'user' ? `시청자 발화: "${text}"` : ''}`;
  const images = [frames.full, frames.crop].filter(Boolean).map(img);
  const note = images.length ? (frames.crop ? '첫 이미지는 현재 전체 프레임, 두 번째는 시선 주변 확대 크롭이에요.' : '이미지는 현재 전체 프레임이에요.') : '(프레임을 가져오지 못했어요)';
  return { frames, images, note, ctx, text, tFrame: Date.now() - t0 };
}

export async function recordTurn(session, body, text, reply, items) {
  await store.withSession(session.id, async () => {
    const s = await store.getSession(session.id);
    const at = new Date().toISOString();
    s.chat = [...(s.chat || []), ...(text ? [{ role: 'user', text, at, videoTime: Number(body.videoTime) || 0 }] : []), { role: 'assistant', text: reply, items, at }].slice(-50);
    await store.saveSession(s);
  });
}

// Sonnet tool agent (danawa_search / web_search / look_at_screen). onTool(name) fires before each tool runs.
export async function runSearchAgent({ session, body, ctx, note, images, frames, onTool }) {
  const ta = Date.now();
  const tools = []; const seen = new Set(); let answer = null; let items = []; let captureId;
  const track = (r) => { for (const x of r.results || []) seen.add(x.url); if (r.searchUrl) seen.add(r.searchUrl); return r; };
  const timed = (name, fn) => async (_id, params) => { onTool?.(name); const s = Date.now(); const out = await fn(params); tools.push(`${name}:${Date.now() - s}ms`); return out; };
  const tool = (name, description, parameters, fn) => ({ name, label: name, description, parameters, execute: timed(name, fn) });
  const agent = new Agent({
    initialState: {
      systemPrompt: AGENT_SYSTEM, model: summaryModel, messages: [],
      tools: [
        tool('danawa_search', 'Search Danawa (Korean price comparison). Returns up to 5 products with lowest price and product URL.', Type.Object({ query: Type.String() }),
          async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify(track(await danawaSearch(query))) }], details: {} })),
        tool('web_search', 'General web search. Returns up to 5 titles + urls.', Type.Object({ query: Type.String() }),
          async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify(track(await webSearch(query))) }], details: {} })),
        tool('fetch_url', 'Fetch one web page as plain text (first ~3500 chars).', Type.Object({ url: Type.String() }),
          async ({ url }) => { try { return { content: [{ type: 'text', text: await fetchPageText(url) }], details: {} }; } catch (e) { return { content: [{ type: 'text', text: `fetch failed: ${e.message}` }], details: {} }; } }),
        tool('get_time', 'Current wall-clock time (Asia/Seoul).', Type.Object({}), async () => ({ content: [{ type: 'text', text: kstFull() }], details: {} })),
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
  let reply;
  if (answer) {
    reply = answer.reply;
    items = (answer.items || []).filter((i) => i && /^https?:\/\//.test(i.url) && seen.has(i.url)).slice(0, 5).map((i) => ({ name: i.name, ...(i.price ? { price: i.price } : {}), url: i.url, source: i.source }));
    if ((items.length || answer.focus) && (frames.crop || frames.full)) {
      // keep what the viewer asked about for the summary: stored as a strong-interest capture
      try {
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
      } catch (e) { log('capture store failed', e.message); captureId = undefined; }
    }
  } else {
    reply = agent.state.errorMessage ? '지금은 찾아보기 어렵네요. 잠시 후에 다시 말씀해 주세요.' : '잘 못 찾았어요. 다시 한 번 말씀해 주시겠어요?';
  }
  return { reply, items, captureId, tools, agentMs: Date.now() - ta };
}

export async function handleChat(body, { HttpError }) {
  const t0 = Date.now();
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  if (!text) throw new HttpError(400, 'text required');
  const { frames, images, note, ctx, tFrame } = await buildContext(session, body);
  if (session.pendingOffer) store.withSession(session.id, async () => { const s = await store.getSession(session.id); if (s?.pendingOffer) { delete s.pendingOffer; await store.saveSession(s); } }).catch(() => {});

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
    ({ reply, items, captureId, tools, agentMs } = await runSearchAgent({ session, body, ctx, note, images, frames }));
  }
  await recordTurn(session, body, text, reply, items);
  log(`${mode} "${text.slice(0, 40)}" frame=${tFrame}ms gate=${gateMs}ms agent=${agentMs}ms tools=[${tools.join(',')}] items=${items.length} total=${Date.now() - t0}ms`);
  return { reply, speak: true, ignored: false, items, ...(captureId ? { captureId } : {}) };
}
