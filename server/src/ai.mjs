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
const visionPayload = fastPayload({ type: 'disabled' });
const summaryPayload = fastPayload({ type: 'between_tools' });

const normLabel = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
const textOf = (msg) => (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model output: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

const VISION_SYSTEM = `You analyse an image cropped from a video frame. A semi-transparent RED RING marks the viewer's estimated gaze point. The estimate is imprecise: the true gaze can be ~15-20% of the image size away from the ring.
Task: pick the SINGLE most plausible buyable product the viewer is looking at. Prefer the product nearest the ring; if the ring sits on background or a non-product, a clearly salient product nearby is allowed. Never mention or describe the ring itself, and never treat the ring as an object.
Answer with ONE JSON object only, no prose:
{
 "label": short Korean noun phrase for that product incl. colour/material, e.g. "갈색 가죽 토트백" (null if no buyable product is plausible),
 "category": Korean category word, e.g. "가방", "신발", "시계", "의류", "가전", "기타",
 "description": one Korean sentence describing the product (not the ring),
 "isProduct": true only if it is a clear, individually buyable consumer product (bag, shoes, watch, clothing, gadget...). false for people, scenery, food being eaten, built-in furniture, text, blur, or when nothing buyable is plausible,
 "confidence": 0..1 that label/isProduct are right,
 "query": short Korean shopping search query, 2-4 words, generic type + one key attribute (colour/material); add brand/model only if clearly readable; null if not a product,
 "say": natural Korean polite speech (해요체) phrased as a YES/NO QUESTION the viewer can answer with a head nod, confirming the product and offering to look it up, e.g. "방금 그 빨간 서류가방 보신 거 맞죠? 찾아볼까요?"; null if not a product,
 "alternatives": array of up to 2 OTHER plausible buyable products visible in the crop (different objects from "label"), most likely first; [] if none. Each: {"label": Korean noun phrase, "category": Korean category word, "query": short Korean shopping query (2-4 words), "say": a soft-retreat yes/no question that starts with "아 이거 아닌가요...? " and then offers this product, e.g. "아 이거 아닌가요...? 그럼 옆에 갈색 구두요?"}
}
LABEL CONSISTENCY (applies to "label" and every alternative): you may be given labels already used earlier in this session. If a product is the same object/type as one of them, reuse that label EXACTLY (character for character). Only invent a new label for a genuinely different product.`;


export async function analyzeCrop(jpegBuf, knownLabels = []) {
  const hint = knownLabels.length
    ? `Labels already used in this session: ${JSON.stringify(knownLabels)}. Reuse one exactly if it is the same object.`
    : 'No labels used yet in this session.';
  const context = {
    systemPrompt: VISION_SYSTEM,
    messages: [{
      role: 'user', timestamp: Date.now(),
      content: [
        { type: 'image', data: jpegBuf.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `${hint}\nReturn the JSON for the most plausible buyable product the viewer is looking at.` },
      ],
    }],
  };
  const res = await completeSimple(visionModel, context, { apiKey: config.apiKey, maxTokens: 700, onPayload: visionPayload });
  if (res.stopReason === 'error') throw new Error(res.errorMessage || 'vision call failed');
  const j = parseJson(textOf(res));
  let label = j.label ? String(j.label).trim() : null;
  // server-side guard: whitespace/case variants of a known label collapse to the known spelling
  const known = label && knownLabels.find((k) => normLabel(k) === normLabel(label));
  if (known) label = known;
  const isProduct = !!(label && j.isProduct === true);
  const canon = (l) => { const t = String(l).trim(); return knownLabels.find((k) => normLabel(k) === normLabel(t)) || t; };
  const seen = new Set(isProduct ? [normLabel(label)] : []);
  const alternatives = [];
  for (const a of Array.isArray(j.alternatives) ? j.alternatives : []) {
    if (!a || !a.label || !a.query) continue;
    const l = canon(a.label);
    if (seen.has(normLabel(l))) continue;
    seen.add(normLabel(l));
    alternatives.push({
      label: l, category: a.category ? String(a.category) : null, query: String(a.query),
      say: /^아 이거 아닌가요/.test(a.say || '') ? String(a.say) : `아 이거 아닌가요...? 그럼 ${l}요?`,
    });
    if (alternatives.length >= 2) break;
  }
  return {
    alternatives,
    label: isProduct ? label : null,
    category: isProduct && j.category ? String(j.category) : null,
    description: isProduct && j.description ? String(j.description) : null,
    isProduct,
    confidence: Number.isFinite(+j.confidence) ? +j.confidence : 0,
    query: isProduct && j.query ? String(j.query) : null,
    say: isProduct && j.say ? String(j.say) : null,
    usage: res.usage,
  };
}

export const shopLinks = (q) => q ? [
  { title: '쿠팡에서 검색', url: `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}` },
  { title: '네이버 쇼핑에서 검색', url: `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}` },
] : [];

// ---- Summary agent -------------------------------------------------------------------------

// Turn captures into per-product entries: the main item plus any alternative the viewer confirmed with "yes".
// Labels the viewer answered "no" are dropped; "yes" labels are flagged for boosting.
function expandEntries(captures, feedback = {}) {
  const out = [];
  for (const c of captures) {
    const cands = [];
    if (c.item && c.isProduct) cands.push({ label: c.item.label, category: c.item.category, query: c.query });
    for (const a of c.alternatives || []) if (feedback[normLabel(a.label)]?.answer === 'yes') cands.push({ label: a.label, category: a.category, query: a.query });
    for (const k of cands) {
      const ans = feedback[normLabel(k.label)]?.answer || null;
      if (ans === 'no') continue;
      out.push({ captureId: c.captureId, imageUrl: c.imageUrl, videoTime: c.videoTime, kind: c.kind, dwellMs: c.dwellMs,
        item: { label: k.label, category: k.category }, isProduct: true, query: k.query, answer: ans });
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
    label: c.item?.label ?? null, links: shopLinks(c.query),
  });
  if (!groups.length) {
    return { say: '아직 눈여겨보신 상품이 없어요. 영상을 더 보시면서 관심 가는 물건을 쳐다봐 주세요.', recommendations: [] };
  }

  let submitted = null;
  const tools = [
    {
      name: 'list_captures', label: 'List captures',
      description: 'List every gaze capture of this viewing session (chronological) with identified object, dwell time in ms and video time in seconds.',
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
      name: 'aggregate_by_label', label: 'Aggregate by label',
      description: 'Group product captures by object label: capture count (repeat looks), total/max dwell ms, best capture id, userAnswer ("yes" = viewer confirmed by nodding). Sorted with viewer-confirmed products first, then by total dwell. Products the viewer rejected are already removed.',
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
      systemPrompt: `You are a shopping assistant reviewing what a viewer's eyes lingered on while watching a video.
Use the tools to review the session's captures, weigh longer dwell and repeated looks at the same product (same label across captures) as stronger interest, ignore non-products and near-duplicates, then call submit_recommendations once with the top 3-5 distinct products. Each reason is one natural Korean polite sentence mentioning the evidence (e.g. 몇 초 동안 / 여러 번 다시 봤어요). Products with userAnswer \"yes\" were explicitly confirmed by the viewer (nod): rank them above unconfirmed ones. Products the viewer rejected are already excluded. Use the capture with the longest dwell as captureId.`,
      model: summaryModel, tools, messages: [],
    },
    getApiKey: () => config.apiKey,
    onPayload: summaryPayload,
  });
  await agent.prompt(`Session "${session.videoTitle || session.videoUrl}" has ${captures.length} captures. Review them and submit the recommendations.`);
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
      return { ...link(c), reason: g.userAnswer === 'yes' ? '고개를 끄덕이며 맞다고 하셨던 상품이에요.' : `${Math.round(g.totalDwellMs / 1000)}초 동안 ${g.captureCount}번 보셨어요.` };
    });
    return { say: '눈여겨보신 상품들을 정리해 봤어요.', recommendations: recs, fallback: true, error: err || 'agent returned nothing' };
  }
  return { say: submitted.say || '눈여겨보신 상품들을 정리해 봤어요.', recommendations: recs.slice(0, 5) };
}
