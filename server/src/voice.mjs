// "Call mode": streaming NDJSON voice turns. One Haiku stream decides (IGNORE/SEARCH/SAY/SKIP) and speaks;
// SEARCH hands over to the Sonnet tool agent from chat.mjs.
import { streamSimple } from '@mariozechner/pi-ai';
import { config } from './config.mjs';
import * as store from './store.mjs';
import { visionModel, visionPayload } from './ai.mjs';
import { buildContext, runSearchAgent, recordTurn } from './chat.mjs';

const log = (...a) => console.log(new Date().toISOString(), '[voice]', ...a);
const IDLE_MIN_GAP_MS = 40000;
const FILLERS = ['잠깐만요, 찾아볼게요.', '네, 바로 찾아볼게요.', '잠시만요, 한번 찾아볼게요.'];

const VOICE_SYSTEM = `You are the voice on a PHONE CALL with a viewer who is watching a video; you watch it together (you receive the current frame and a crop around their gaze ring - never mention the ring). Persona: warm, casual-polite Korean (해요체), like a friendly friend on the phone. Everything you write is spoken aloud by TTS.
The viewer's speech arrives as speech-to-text and may include the VIDEO'S OWN AUDIO (narration, presenter talk, lyrics) picked up by the mic.
OUTPUT FORMAT: the very first line is exactly ONE tag, nothing else on that line:
[IGNORE]  - the text is not addressed to you (video narration/presenter talk like greetings to 여러분/구독자, lyrics, fragments, noise)
[SEARCH]  - addressed, and answering needs a live lookup (product model + price, where to buy, price comparison, web facts). Write nothing after the tag.
[SAY]     - addressed, you can answer directly (chat, reactions, what's on screen). Put the spoken reply on the following lines.
[SKIP]    - (only when the viewer said nothing) there is nothing worth saying.
After [SAY]: 1-2 SHORT sentences, each ending with . ? or !, no markdown, no lists, no emoji, never read out URLs or long numbers, never identify real people by face. Never guess brands or model names: name a brand/model only if its logo or text is clearly legible in the frame; otherwise describe generically (e.g. "수납함", "모니터 암"). You may end with a brief friendly follow-up question. Be concrete about what is on screen when relevant.
When the viewer said nothing (idle / follow-up): either [SKIP], or [SAY] one short natural comment or question about what is on screen right now (or a gentle follow-up to your own last line). Don't repeat what you already said in the recent conversation.`;

const EMOJI = /[\p{Extended_Pictographic}️]/gu;
function cleanSentence(t) {
  return t.replace(/https?:\/\/\S+/g, '').replace(EMOJI, '').replace(/[*_#`>]+/g, '').replace(/\s+/g, ' ').trim();
}
// Pull complete sentences out of buf; returns [sentences, rest]. final=true flushes the remainder.
function splitSentences(buf, final) {
  const out = []; let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    let end = false;
    if (ch === '\n') end = true;
    else if ('.!?。！？…'.includes(ch)) {
      const prev = buf[i - 1], next = buf[i + 1];
      if (ch === '.' && /\d/.test(prev || '') && /\d/.test(next || '')) continue; // 1.5
      if (next === undefined) { if (final) end = true; else break; } // wait for more input
      else if (/[\s"')\]]/.test(next)) end = true;
      else if ('.!?。！？…'.includes(next)) continue;
    }
    if (end) { const s = cleanSentence(buf.slice(start, i + 1)); if (s) out.push(s); start = i + 1; }
  }
  let rest = buf.slice(start);
  if (final) { const s = cleanSentence(rest); if (s) out.push(s); rest = ''; }
  return [out, rest];
}

export async function handleVoiceTurn(body, req, res, { HttpError }) {
  const t0 = Date.now();
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const trigger = ['user', 'idle', 'followup'].includes(body.trigger) ? body.trigger : 'user';
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  if (trigger === 'user' && !text) throw new HttpError(400, 'text required for trigger "user"');

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  res.flushHeaders?.();
  let closed = false; res.on('close', () => { closed = true; });
  const emit = (obj) => { if (!closed && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  let ttfs = null; const spoken = [];
  const say = (t) => { if (ttfs == null) ttfs = Date.now() - t0; spoken.push(t); emit({ type: 'say', text: t }); };
  let tGate = null, mode = '', items = [], tools = [];
  const finish = (extra = {}) => { emit({ type: 'done', ms: Date.now() - t0, ...extra }); res.end(); log(`${trigger} ${mode} "${text.slice(0, 30)}" gate=${tGate ?? '-'}ms ttfs=${ttfs ?? '-'}ms total=${Date.now() - t0}ms tools=[${tools.join(',')}]`); };

  try {
    if (trigger === 'idle') {
      let limited = false;
      await store.withSession(session.id, async () => {
        const s = await store.getSession(session.id);
        if (Date.now() - (s.lastIdleAt || 0) < IDLE_MIN_GAP_MS) { limited = true; return; }
        s.lastIdleAt = Date.now(); await store.saveSession(s);
      });
      if (limited) { mode = 'idle-rate-limited'; return finish({ skipped: 'rate_limit' }); }
    }

    const { frames, images, note, ctx } = await buildContext(session, body, trigger);
    const instruction = trigger === 'user' ? '' : (trigger === 'idle' ? '\n(시청자는 말이 없어요. idle: 화면에 대해 먼저 한마디 할 만하면 [SAY], 아니면 [SKIP].)' : '\n(시청자가 방금 당신의 말에 답이 없어요. follow-up: 가볍게 이어서 한마디 하거나 [SKIP].)');
    const stream = streamSimple(visionModel, {
      systemPrompt: VOICE_SYSTEM,
      messages: [{ role: 'user', timestamp: Date.now(), content: [...images, { type: 'text', text: `${note}\n${ctx}${instruction}` }] }],
    }, { apiKey: config.apiKey, maxTokens: 300, onPayload: visionPayload });

    let buf = '', header = null, rest = '';
    const feed = (delta) => {
      if (header === 'SAY') { rest += delta; const [ss, r] = splitSentences(rest, false); rest = r; ss.forEach(say); return; }
      buf += delta;
      const m = /^\s*\[(IGNORE|SEARCH|SAY|SKIP)\]/.exec(buf);
      if (m) { header = m[1]; tGate = Date.now() - t0; if (header === 'SAY') { rest = buf.slice(m[0].length).replace(/^[\s]+/, ''); const [ss, r] = splitSentences(rest, false); rest = r; ss.forEach(say); } }
      else if (buf.length > 40) { header = 'SAY'; tGate = Date.now() - t0; rest = buf; const [ss, r] = splitSentences(rest, false); rest = r; ss.forEach(say); }
    };
    let streamErr = null;
    for await (const ev of stream) {
      if (closed) break;
      if (ev.type === 'text_delta') { feed(ev.delta); if (header && header !== 'SAY') break; }
      else if (ev.type === 'error') { streamErr = ev.error?.errorMessage || 'model error'; break; }
    }
    if (streamErr) { mode = 'error'; emit({ type: 'error', message: streamErr }); return finish(); }
    if (!header && buf.trim()) { header = 'SAY'; tGate = Date.now() - t0; rest = buf; }
    if (tGate == null) tGate = Date.now() - t0;
    mode = header || 'none';

    if (header === 'IGNORE') { emit({ type: 'ignored' }); return finish(); }
    if (header === 'SKIP' || !header) return finish();
    if (header === 'SAY') {
      const [ss] = splitSentences(rest, true); ss.forEach(say);
      if (spoken.length) await recordTurn(session, body, trigger === 'user' ? text : '', spoken.join(' '), []);
      return finish();
    }
    // SEARCH
    if (trigger !== 'user') return finish();
    say(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
    const r = await runSearchAgent({ session, body, ctx, note, images, frames, onTool: (name) => emit({ type: 'tool', name }) });
    items = r.items; tools = r.tools;
    if (items.length) emit({ type: 'items', items, ...(r.captureId ? { captureId: r.captureId } : {}) });
    const [ss] = splitSentences(r.reply, true); ss.forEach(say);
    await recordTurn(session, body, text, r.reply, items);
    return finish();
  } catch (e) {
    log('turn failed', e.stack || e.message);
    mode = mode || 'error';
    emit({ type: 'error', message: String(e.message || e).slice(0, 200) });
    if (!res.writableEnded) finish();
  }
}
