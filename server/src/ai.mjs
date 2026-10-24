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

const textOf = (msg) => (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model output: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

const VISION_SYSTEM = `You analyse a small crop taken from a video frame where a viewer's gaze rested.
Look at the object at the CENTER of the crop (ignore peripheral clutter). Answer with ONE JSON object only, no prose:
{
 "label": short Korean noun phrase for the object incl. colour/material, e.g. "갈색 가죽 토트백" (null if nothing identifiable),
 "category": Korean category word, e.g. "가방", "신발", "시계", "의류", "가전", "음식", "기타",
 "description": one Korean sentence describing what you see,
 "isProduct": true only if it is a clear, individually buyable consumer product (bag, shoes, watch, clothing, gadget...). false for people, scenery, food being eaten, furniture built into the scene, text, blur,
 "confidence": 0..1 that label/isProduct are right,
 "query": short Korean shopping search query, 2-4 words, generic type + one key attribute (colour/material); add brand/model only if clearly readable; null if not a product,
 "say": natural Korean polite speech (해요체), ONE sentence, offering to look it up, e.g. "방금 그 갈색 가죽 토트백 눈여겨 보신 것 같은데, 찾아볼까요?"; null if not a product
}`;

export async function analyzeCrop(jpegBuf) {
  const context = {
    systemPrompt: VISION_SYSTEM,
    messages: [{
      role: 'user', timestamp: Date.now(),
      content: [
        { type: 'image', data: jpegBuf.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: 'Return the JSON for the object at the center of this crop.' },
      ],
    }],
  };
  const res = await completeSimple(visionModel, context, { apiKey: config.apiKey, maxTokens: 400, onPayload: visionPayload });
  if (res.stopReason === 'error') throw new Error(res.errorMessage || 'vision call failed');
  const j = parseJson(textOf(res));
  return {
    label: j.label ? String(j.label) : null,
    category: j.category ? String(j.category) : null,
    description: j.description ? String(j.description) : null,
    isProduct: j.isProduct === true,
    confidence: Number.isFinite(+j.confidence) ? +j.confidence : 0,
    query: j.query ? String(j.query) : null,
    say: j.say ? String(j.say) : null,
    usage: res.usage,
  };
}

export const shopLinks = (q) => q ? [
  { title: '쿠팡에서 검색', url: `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}` },
  { title: '네이버 쇼핑에서 검색', url: `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}` },
] : [];

// ---- Summary agent -------------------------------------------------------------------------
const normLabel = (s) => (s || '').toLowerCase().replace(/\s+/g, '');

function aggregate(captures) {
  const groups = new Map();
  for (const c of captures) {
    if (!c.item || !c.isProduct) continue;
    const key = normLabel(c.item.label);
    const g = groups.get(key) || { label: c.item.label, category: c.item.category, query: c.query, captureCount: 0, totalDwellMs: 0, maxDwellMs: 0, bestCaptureId: c.captureId, firstVideoTime: c.videoTime, lastVideoTime: c.videoTime, captureIds: [] };
    g.captureCount++; g.totalDwellMs += c.dwellMs || 0;
    if ((c.dwellMs || 0) >= g.maxDwellMs) { g.maxDwellMs = c.dwellMs || 0; g.bestCaptureId = c.captureId; }
    g.firstVideoTime = Math.min(g.firstVideoTime, c.videoTime); g.lastVideoTime = Math.max(g.lastVideoTime, c.videoTime);
    g.captureIds.push(c.captureId);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.totalDwellMs - a.totalDwellMs);
}

export async function summarize(session, captures) {
  const byId = new Map(captures.map((c) => [c.captureId, c]));
  const groups = aggregate(captures);
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
        content: [{ type: 'text', text: JSON.stringify(captures.map((c) => ({
          captureId: c.captureId, videoTime: c.videoTime, kind: c.kind, dwellMs: c.dwellMs,
          label: c.item?.label ?? null, isProduct: !!c.isProduct, category: c.item?.category ?? null, query: c.query,
        }))) }],
        details: {},
      }),
    },
    {
      name: 'aggregate_by_label', label: 'Aggregate by label',
      description: 'Group product captures by object label: capture count (repeat looks), total/max dwell ms, best capture id. Sorted by total dwell.',
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
Use the tools to review the session's captures, weigh longer dwell and repeated looks at the same product (same label across captures) as stronger interest, ignore non-products and near-duplicates, then call submit_recommendations once with the top 3-5 distinct products. Each reason is one natural Korean polite sentence mentioning the evidence (e.g. 몇 초 동안 / 여러 번 다시 봤어요). Use the capture with the longest dwell as captureId.`,
      model: summaryModel, tools, messages: [],
    },
    getApiKey: () => config.apiKey,
    onPayload: summaryPayload,
  });
  await agent.prompt(`Session "${session.videoTitle || session.videoUrl}" has ${captures.length} captures. Review them and submit the recommendations.`);
  const err = agent.state.errorMessage;

  // Validate agent output against real captures; fall back to dwell ranking if the agent failed.
  let recs = [];
  if (submitted) {
    for (const r of submitted.recommendations || []) {
      const c = byId.get(r.captureId);
      if (c && !recs.some((x) => x.captureId === c.captureId)) recs.push({ ...link(c), label: r.label || c.item?.label, reason: r.reason });
    }
  }
  if (!recs.length) {
    recs = groups.slice(0, 5).map((g) => {
      const c = byId.get(g.bestCaptureId);
      return { ...link(c), reason: `${Math.round(g.totalDwellMs / 1000)}초 동안 ${g.captureCount}번 보셨어요.` };
    });
    return { say: '눈여겨보신 상품들을 정리해 봤어요.', recommendations: recs, fallback: true, error: err || 'agent returned nothing' };
  }
  return { say: submitted.say || '눈여겨보신 상품들을 정리해 봤어요.', recommendations: recs.slice(0, 5) };
}
