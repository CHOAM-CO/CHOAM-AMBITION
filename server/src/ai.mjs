// Agent layer on pi (pi-ai for model calls, pi-agent-core for the summary agent loop).
import { completeSimple, getModel, Type } from '@mariozechner/pi-ai';
import { Agent } from '@mariozechner/pi-agent-core';
import { config } from './config.mjs';

// pi-ai's generated registry predates the 5.5 models, so unknown ids get a custom model object
// (same shape as the registry entries). reasoning:false => pi sends no `thinking` param itself;
// the payload hook below sets it explicitly (Sonnet 5.5 400s on thinking:disabled).
function resolveModel(id, name, cost) {
  try { const m = getModel('anthropic', id); if (m) return m; } catch { /* not in registry */ }
  return {
    id, name, api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com',
    reasoning: false, input: ['text', 'image'], cost, contextWindow: 1000000, maxTokens: 128000,
  };
}
export const visionModel = resolveModel(config.visionModel, 'Claude Haiku 5.5', { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
export const summaryModel = resolveModel(config.summaryModel, 'Claude Sonnet 5.5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });

// Fast, no-thinking settings. `between_tools` = thinking off for Sonnet 5.5 (allowed at effort <= high).
const fastPayload = (thinking) => (payload) => ({
  ...payload,
  thinking,
  output_config: { ...(payload.output_config || {}), effort: 'low' },
});
export const visionPayload = fastPayload({ type: 'disabled' });
export const summaryPayload = fastPayload({ type: 'between_tools' });

export const normLabel = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
export const textOf = (msg) => (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
export function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model output: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

export const CATEGORIES = ['person', 'product', 'object', 'game', 'animation', 'place', 'food', 'animal', 'text', 'scene', 'other'];

const VISION_SYSTEM = `You help a casual video-watching companion decide what to say about the CONTENT the viewer is looking at. You get the full frame (first image, when present), a crop around the viewer's gaze (semi-transparent RED RING = estimated gaze, imprecise: true gaze can be ~15-20% of the image size away) and a "영상 맥락" block (video metadata, subtitles near now, research with timely hooks) plus today's time.
Task: classify what the viewer is attending to and write ONE short spoken line.
Answer with ONE JSON object only, no prose:
{
 "label": short Korean noun phrase for the thing (null if nothing clear),
 "category": exactly one of "person" | "product" | "object" | "game" | "animation" | "place" | "food" | "animal" | "text" | "scene" | "other",
   person = a human on screen; game = video-game footage/UI (esports included); animation = anime/cartoon/CGI; product = ONLY when this is clearly a shopping/haul/review video and the item is the subject; object = any other item; scene = general setting/moment,
 "description": one Korean sentence about what is happening there (for category "text": the Korean meaning of the text),
 "clear": true when you can say something interesting about the CONTENT (a person on screen whose identity/role the context gives, a game/anime title, a notable moment). false for blur/empty background, and false for plain objects/products when this is NOT a product video,
 "confidence": 0..1,
 "query": short Korean web search query for the offer in "say" (e.g. "T1 어제 경기 결과", "페이커 최근 인터뷰"); null if clear is false,
 "say": natural Korean 해요체, spoken aloud, at most 3 short sentences = (1) one observation about the content ("지금 페이커 선수 인터뷰 보고 계시네요."), (2) ONE timely hook taken from the 영상 맥락 research hooks if any fit ("찾아보니까 지금 월즈 중이라 어제 티원 경기가 있었어요!"), (3) ONE yes/no offer question answerable with a nod ("어제 경기 결과라도 찾아볼까요?"). Without a fitting hook, make the offer about the content (more about the person/game/story). Never mention the ring. null if clear is false,
 "alternatives": array of up to 2 OTHER plausible content things in view, most likely first; [] if none. Each: {"label","category","description","query","say": a soft-retreat yes/no question starting with "아 이거 아닌가요...? " and then offering this thing}
}
IDENTITY RULES: name a person ONLY if the 영상 맥락 (title, channel, description, tags, subtitles, research people list) names them AND what is visible fits (e.g. the title says it is a Faker interview and an interviewee is on screen -> "페이커 선수"), or the name is legible on screen. Never identify anyone from their face alone; when the context does not name them, describe generically ("인터뷰하는 남성", "베이지 재킷의 해설자"). Name a game/anime/show title only from the context or legible on-screen text. Name a brand/model only if the logo/text is legible. Talk shopping only for product videos.
LABEL CONSISTENCY (applies to "label" and every alternative): you may be given labels already used earlier in this session. If a thing is the same as one of them, reuse that label EXACTLY. Only invent a new label for a genuinely different thing.`;

const normCat = (c) => { const x = String(c || '').toLowerCase().trim(); return CATEGORIES.includes(x) ? x : 'other'; };

export async function analyzeCrop(jpegBuf, knownLabels = [], { contentCtx = '', fullJpeg = null } = {}) {
  const hint = knownLabels.length
    ? `Labels already used in this session: ${JSON.stringify(knownLabels)}. Reuse one exactly if it is the same thing.`
    : 'No labels used yet in this session.';
  const context = {
    systemPrompt: VISION_SYSTEM,
    messages: [{
      role: 'user', timestamp: Date.now(),
      content: [
        ...(fullJpeg ? [{ type: 'image', data: fullJpeg.toString('base64'), mimeType: 'image/jpeg' }] : []),
        { type: 'image', data: jpegBuf.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `${contentCtx ? contentCtx + '\n\n' : ''}${hint}\n${fullJpeg ? '첫 이미지는 전체 프레임, 두 번째는 시선 주변 크롭이에요.' : '이미지는 시선 주변 크롭이에요.'} Return the JSON for what the viewer is most plausibly attending to.` },
      ],
    }],
  };
  const res = await completeSimple(visionModel, context, { apiKey: config.apiKey, maxTokens: 800, onPayload: visionPayload });
  if (res.stopReason === 'error') throw new Error(res.errorMessage || 'vision call failed');
  const j = parseJson(textOf(res));
  const canon = (l) => { const t = String(l).trim(); return knownLabels.find((k) => normLabel(k) === normLabel(t)) || t; };
  const label = j.label ? canon(j.label) : null;
  const clear = !!(label && j.clear === true);
  const seen = new Set(clear ? [normLabel(label)] : []);
  const alternatives = [];
  for (const a of Array.isArray(j.alternatives) ? j.alternatives : []) {
    if (!a || !a.label || !a.query) continue;
    const l = canon(a.label);
    if (seen.has(normLabel(l))) continue;
    seen.add(normLabel(l));
    alternatives.push({
      label: l, category: normCat(a.category), description: a.description ? String(a.description) : null, query: String(a.query),
      say: /^아 이거 아닌가요/.test(a.say || '') ? String(a.say) : `아 이거 아닌가요...? 그럼 ${l}요?`,
    });
    if (alternatives.length >= 2) break;
  }
  return {
    alternatives,
    label: clear ? label : null,
    category: clear ? normCat(j.category) : null,
    description: clear && j.description ? String(j.description) : null,
    clear,
    confidence: Number.isFinite(+j.confidence) ? +j.confidence : 0,
    query: clear && j.query ? String(j.query) : null,
    say: clear && j.say ? String(j.say) : null,
    usage: res.usage,
  };
}

const enc = encodeURIComponent;
// Links by category (query null -> none).
export function linksFor(q, category) {
  if (!q) return [];
  switch (category) {
    case 'product': return [
      { title: '쿠팡에서 검색', url: `https://www.coupang.com/np/search?q=${enc(q)}` },
      { title: '네이버 쇼핑에서 검색', url: `https://search.shopping.naver.com/search/all?query=${enc(q)}` }];
    case 'place': return [
      { title: '네이버 지도에서 검색', url: `https://map.naver.com/p/search/${enc(q)}` },
      { title: '구글 지도에서 검색', url: `https://www.google.com/maps/search/${enc(q)}` }];
    case 'food': return [
      { title: '유튜브에서 레시피 검색', url: `https://www.youtube.com/results?search_query=${enc(q + ' 레시피')}` },
      { title: '네이버에서 맛집 검색', url: `https://search.naver.com/search.naver?query=${enc(q + ' 맛집')}` }];
    default: return [
      { title: '네이버에서 검색', url: `https://search.naver.com/search.naver?query=${enc(q)}` },
      { title: '유튜브에서 검색', url: `https://www.youtube.com/results?search_query=${enc(q)}` }];
  }
}

// ---- Summary agent -------------------------------------------------------------------------

// Turn captures into per-product entries: the main item plus any alternative the viewer confirmed with "yes".
// Labels the viewer answered "no" are dropped; "yes" labels are flagged for boosting.
function expandEntries(captures, feedback = {}) {
  const out = [];
  for (const c of captures) {
    const cands = [];
    if (c.item && (c.clear ?? c.isProduct)) cands.push({ label: c.item.label, category: c.item.category, query: c.query, description: c.item.description });
    for (const a of c.alternatives || []) if (feedback[normLabel(a.label)]?.answer === 'yes') cands.push({ label: a.label, category: a.category, query: a.query, description: a.description });
    for (const k of cands) {
      const ans = feedback[normLabel(k.label)]?.answer || null;
      if (ans === 'no') continue;
      out.push({ captureId: c.captureId, imageUrl: c.imageUrl, videoTime: c.videoTime, kind: c.kind, dwellMs: c.dwellMs,
        item: { label: k.label, category: k.category, description: k.description }, clear: true, query: k.query, answer: ans });
    }
  }
  return out;
}

function aggregate(entries) {
  const groups = new Map();
  for (const c of entries) {
    const key = normLabel(c.item.label);
    const g = groups.get(key) || { label: c.item.label, category: c.item.category, query: c.query, userAnswer: null, captureCount: 0, totalDwellMs: 0, maxDwellMs: 0, bestCaptureId: c.captureId, firstVideoTime: c.videoTime, lastVideoTime: c.videoTime, captureIds: [] };
    if (c.answer === 'yes') g.userAnswer = 'yes';
    g.captureCount++; g.totalDwellMs += c.dwellMs || 0;
    if ((c.dwellMs || 0) >= g.maxDwellMs) { g.maxDwellMs = c.dwellMs || 0; g.bestCaptureId = c.captureId; }
    g.firstVideoTime = Math.min(g.firstVideoTime, c.videoTime); g.lastVideoTime = Math.max(g.lastVideoTime, c.videoTime);
    g.captureIds.push(c.captureId);
    groups.set(key, g);
  }
  // confirmed-by-nod products first, then by total dwell
  return [...groups.values()].sort((a, b) => (b.userAnswer === 'yes') - (a.userAnswer === 'yes') || b.totalDwellMs - a.totalDwellMs);
}

export async function summarize(session, captures) {
  const entries = expandEntries(captures, session.feedback || {});
  const lookup = (id, label) => entries.find((e) => e.captureId === id && normLabel(e.item.label) === normLabel(label)) || entries.find((e) => e.captureId === id);
  const groups = aggregate(entries);
  const link = (c) => ({
    captureId: c.captureId, imageUrl: c.imageUrl, videoTime: c.videoTime,
    label: c.item?.label ?? null, category: c.item?.category ?? null, links: linksFor(c.query, c.item?.category),
  });
  if (!groups.length) {
    return { say: '아직 관심 있어 보였던 것이 없어요. 영상을 더 보시면서 관심 가는 곳을 쳐다봐 주세요.', recommendations: [] };
  }

  let submitted = null;
  const tools = [
    {
      name: 'list_captures', label: 'List captures',
      description: 'List every gaze capture of this viewing session (chronological) with what the viewer attended to (label + category), dwell time in ms and video time in seconds.',
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: 'text', text: JSON.stringify(entries.map((c) => ({
          captureId: c.captureId, videoTime: c.videoTime, kind: c.kind, dwellMs: c.dwellMs,
          label: c.item.label, category: c.item.category, query: c.query, userAnswer: c.answer,
        }))) }],
        details: {},
      }),
    },
    {
      name: 'list_chat', label: 'List chat',
      description: 'The conversation the viewer had with the assistant while watching (what they asked about, e.g. product price lookups). Things they asked about are strong interest signals.',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: JSON.stringify((session.chat || []).slice(-30).map((t) => ({ role: t.role, text: t.text, items: t.items?.map((i) => i.name) }))) }], details: {} }),
    },
    {
      name: 'aggregate_by_label', label: 'Aggregate by label',
      description: 'Group captures by label (any category: product, place, food, animal, text, person, scene, other): capture count (repeat looks), total/max dwell ms, best capture id, userAnswer ("yes" = viewer confirmed by nodding). Sorted with viewer-confirmed products first, then by total dwell. Products the viewer rejected are already removed.',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(groups) }], details: {} }),
    },
    {
      name: 'submit_recommendations', label: 'Submit recommendations',
      description: 'Final answer. Call exactly once with the top 3-5 products (fewer only if fewer distinct products exist).',
      parameters: Type.Object({
        say: Type.String({ description: 'Korean polite (해요체) 1-2 sentence wrap-up addressed to the viewer.' }),
        recommendations: Type.Array(Type.Object({
          captureId: Type.String({ description: 'the best capture id for this product' }),
          label: Type.String(),
          reason: Type.String({ description: 'ONE Korean polite sentence: why this product (dwell, repeated looks)' }),
        })),
      }),
      execute: async (_id, params) => { submitted = params; return { content: [{ type: 'text', text: 'ok' }], details: {}, terminate: true }; },
    },
  ];

  const agent = new Agent({
    initialState: {
      systemPrompt: `You are an assistant reviewing what a viewer's eyes lingered on while watching a video (\"관심 있어 보였던 것들\"): products, places, food, animals, text, people's outfits, scenes - any category.
Use the tools to review the session's captures (and list_chat if the viewer talked to the assistant: explicit questions about a thing count as strong interest), weigh longer dwell and repeated looks at the same product (same label across captures) as stronger interest, ignore near-duplicates, then call submit_recommendations once with the top 3-5 distinct things across categories. Each reason is one natural Korean polite sentence mentioning the evidence (e.g. 몇 초 동안 / 여러 번 다시 봤어요). Products with userAnswer \"yes\" were explicitly confirmed by the viewer (nod): rank them above unconfirmed ones. Products the viewer rejected are already excluded. Use the capture with the longest dwell as captureId.`,
      model: summaryModel, tools, messages: [],
    },
    getApiKey: () => config.apiKey,
    onPayload: summaryPayload,
  });
  await agent.prompt(`Session "${session.videoTitle || session.videoUrl}" has ${captures.length} captures. Review them and submit the 3-5 most interesting things to the viewer.`);
  const err = agent.state.errorMessage;

  // Validate agent output against real entries; fall back to confirmed-then-dwell ranking if the agent failed.
  const rejected = (l) => (session.feedback || {})[normLabel(l)]?.answer === 'no';
  let recs = [];
  if (submitted) {
    for (const r of submitted.recommendations || []) {
      const c = lookup(r.captureId, r.label);
      if (c && !rejected(c.item.label) && !recs.some((x) => normLabel(x.label) === normLabel(c.item.label))) recs.push({ ...link(c), reason: r.reason });
    }
  }
  if (!recs.length) {
    recs = groups.slice(0, 5).map((g) => {
      const c = lookup(g.bestCaptureId, g.label);
      return { ...link(c), reason: g.userAnswer === 'yes' ? '고개를 끄덕이며 맞다고 하셨던 것이에요.' : `${Math.round(g.totalDwellMs / 1000)}초 동안 ${g.captureCount}번 보셨어요.` };
    });
    return { say: '관심 있어 보였던 것들을 정리해 봤어요.', recommendations: recs, fallback: true, error: err || 'agent returned nothing' };
  }
  return { say: submitted.say || '관심 있어 보였던 것들을 정리해 봤어요.', recommendations: recs.slice(0, 5) };
}
