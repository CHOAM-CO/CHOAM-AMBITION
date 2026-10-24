// "Call mode": streaming NDJSON voice turns. One Haiku stream decides (IGNORE/SEARCH/SAY/SKIP) and speaks;
// SEARCH hands over to the Sonnet tool agent from chat.mjs.
import { streamSimple } from '@mariozechner/pi-ai';
import { config } from './config.mjs';
import * as store from './store.mjs';
import { visionModel, visionPayload } from './ai.mjs';
import { buildContext, runSearchAgent, recordTurn } from './chat.mjs';
import * as yt from './youtube.mjs';
import { transcribe } from './asr.mjs';
import { synthWav } from '../tts/index.mjs';

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
When the viewer said nothing (idle / follow-up): either [SKIP], or [SAY] one short natural comment or question about what is on screen right now (or a gentle follow-up to your own last line). Don't repeat what you already said in the recent conversation.
The user message has "현재 시각" (Asia/Seoul wall clock), "현재 영상 위치" and a chronological "장면 메모리" (oldest to newest: scene transcripts, what the viewer looked at, their yes/no feedback), each line stamped [HH:MM:SS 실제시각 (N분 N초 전) | 영상 1분 35초]. Answer questions about earlier moments from it ("아까 그 빨간 가방 몇 분에 나왔지?", "아까 본 장면들 시간순으로 말해줘", "5분 전에 본 거 뭐였지?") and about the time ("지금 몇 시야?" -> read the exact 시 and 분 from the 현재 시각 line, e.g. 오후 1시 00분; no rounding, no hedging like 전/쯤/거의, never guess the hour or am/pm yourself). Resolve "N분 전 / 아까 / 방금 / 처음에 / 마지막으로" against the wall-clock ages in parentheses (pick the entry whose age is closest to N minutes), and "영상 N분쯤 / N분 장면" against the 영상 position. List items in chronological order. Say video positions naturally as written in the memory ("1분 35초", "20초"), never "00분 20초". Never invent entries that are not in the memory; if nothing matches, say so. Memory/time answers are [SAY], never [SEARCH].`;

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

// Shared turn core for /api/voice/turn and /api/voice/talk. Emits say/tool/items/ignored/answer via the callbacks;
// returns {mode, tGate, tools}. The caller owns the stream, `done` and the log line.
async function runTurn({ session, body, trigger, text, emit, say, isClosed, t0, hint = '', asking = false, framesPromise = null }) {
  const out = { mode: '', tGate: null, tools: [] };
  const spoken = [];
  const sayAll = (t) => { spoken.push(t); say(t); };
  const { frames, images, note, ctx } = await buildContext(session, body, trigger, framesPromise);
  const instruction = (trigger === 'user' ? '' : (trigger === 'idle' ? '\n(시청자는 말이 없어요. idle: 화면에 대해 먼저 한마디 할 만하면 [SAY], 아니면 [SKIP].)' : '\n(시청자가 방금 당신의 말에 답이 없어요. follow-up: 가볍게 이어서 한마디 하거나 [SKIP].)')) + hint;
  const stream = streamSimple(visionModel, {
    systemPrompt: VOICE_SYSTEM,
    messages: [{ role: 'user', timestamp: Date.now(), content: [...images, { type: 'text', text: `${note}\n${ctx}${instruction}` }] }],
  }, { apiKey: config.apiKey, maxTokens: 300, onPayload: visionPayload });

  let buf = '', header = null, rest = '';
  const feed = (delta) => {
    if (header === 'SAY') { rest += delta; const [ss, r] = splitSentences(rest, false); rest = r; ss.forEach(sayAll); return; }
    buf += delta;
    const m = /^\s*\[(IGNORE|SEARCH|SAY|SKIP)\]/.exec(buf);
    if (m) { header = m[1]; out.tGate = Date.now() - t0; if (header === 'SAY') { rest = buf.slice(m[0].length).replace(/^[\s]+/, ''); const [ss, r] = splitSentences(rest, false); rest = r; ss.forEach(sayAll); } }
    else if (buf.length > 40) { header = 'SAY'; out.tGate = Date.now() - t0; rest = buf; const [ss, r] = splitSentences(rest, false); rest = r; ss.forEach(sayAll); }
  };
  let streamErr = null;
  for await (const ev of stream) {
    if (isClosed()) break;
    if (ev.type === 'text_delta') { feed(ev.delta); if (header && header !== 'SAY') break; }
    else if (ev.type === 'error') { streamErr = ev.error?.errorMessage || 'model error'; break; }
  }
  if (streamErr) { out.mode = 'error'; emit({ type: 'error', message: streamErr }); return out; }
  if (!header && buf.trim()) { header = 'SAY'; out.tGate = Date.now() - t0; rest = buf; }
  if (out.tGate == null) out.tGate = Date.now() - t0;
  out.mode = header || 'none';

  if (header === 'IGNORE') { if (asking) emit({ type: 'answer', value: null }); else emit({ type: 'ignored' }); return out; }
  if (header === 'SKIP' || !header) return out;
  if (header === 'SAY') {
    const [ss] = splitSentences(rest, true); ss.forEach(sayAll);
    if (spoken.length) await recordTurn(session, body, trigger === 'user' ? text : '', spoken.join(' '), []);
    return out;
  }
  // SEARCH
  if (trigger !== 'user') return out;
  sayAll(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
  const r = await runSearchAgent({ session, body, ctx, note, images, frames, onTool: (name) => emit({ type: 'tool', name }) });
  out.tools = r.tools;
  if (r.items.length) emit({ type: 'items', items: r.items, ...(r.captureId ? { captureId: r.captureId } : {}) });
  const [ss] = splitSentences(r.reply, true); ss.forEach(sayAll);
  await recordTurn(session, body, text, r.reply, r.items);
  return out;
}

function openStream(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  res.flushHeaders?.();
  const st = { closed: false };
  res.on('close', () => { st.closed = true; });
  st.emit = (obj) => { if (!st.closed && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  return st;
}

export async function handleVoiceTurn(body, req, res, { HttpError }) {
  const t0 = Date.now();
  const session = await store.getSession(body.sessionId);
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const trigger = ['user', 'idle', 'followup'].includes(body.trigger) ? body.trigger : 'user';
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  if (trigger === 'user' && !text) throw new HttpError(400, 'text required for trigger "user"');

  const st = openStream(res); const emit = st.emit;
  let ttfs = null;
  const say = (t) => { if (ttfs == null) ttfs = Date.now() - t0; emit({ type: 'say', text: t }); };
  let r = { mode: '', tGate: null, tools: [] };
  const finish = (extra = {}) => { emit({ type: 'done', ms: Date.now() - t0, ...extra }); res.end(); log(`${trigger} ${r.mode} "${text.slice(0, 30)}" gate=${r.tGate ?? '-'}ms ttfs=${ttfs ?? '-'}ms total=${Date.now() - t0}ms tools=[${r.tools.join(',')}]`); };
  try {
    if (trigger === 'idle') {
      let limited = false;
      await store.withSession(session.id, async () => {
        const s = await store.getSession(session.id);
        if (Date.now() - (s.lastIdleAt || 0) < IDLE_MIN_GAP_MS) { limited = true; return; }
        s.lastIdleAt = Date.now(); await store.saveSession(s);
      });
      if (limited) { r.mode = 'idle-rate-limited'; return finish({ skipped: 'rate_limit' }); }
    }
    r = await runTurn({ session, body, trigger, text, emit, say, isClosed: () => st.closed, t0 });
    return finish();
  } catch (e) {
    log('turn failed', e.stack || e.message);
    r.mode = r.mode || 'error';
    emit({ type: 'error', message: String(e.message || e).slice(0, 200) });
    if (!res.writableEnded) finish();
  }
}

// ---- /api/voice/talk: audio in, ASR + turn + TTS out, one NDJSON stream -------------------------------------------
const norm = (t) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// Echo of the agent's own last line: share of the heard text's char bigrams that occur in lastAgent.
export function isEcho(heard, lastAgent) {
  const h = norm(heard), a = norm(lastAgent);
  if (h.length < 4 || !a) return false;
  if (a.includes(h)) return true;
  const grams = new Set(); for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2));
  let hit = 0; const n = h.length - 1;
  for (let i = 0; i < n; i++) if (grams.has(h.slice(i, i + 2))) hit++;
  return hit / n >= 0.7;
}
const YES_RE = /^(응+|으응|어+|네+|넹|예+|그래요?|그럼요?|좋아요?|좋죠|좋습니다|넘겨(줘|요|주세요)?|넘어가(자|요)?|스킵(해줘|해요)?|맞아요?|맞다|오케이|ok(ay)?|yes|yeah|yep|sure)$/i;
const NO_RE = /^(아니+(요|야|에요|오)?|아뇨|싫어(요)?|싫다|됐어(요)?|괜찮아요?|계속(해줘|해요|봐|볼래|볼게요?)?|그냥(둬|두세요|봐요?)?|no+|nope|nah)$/i;
export function keywordAnswer(text) {
  const words = String(text || '').trim().split(/\s+/).map(norm).filter(Boolean);
  if (!words.length || words.length > 3 || words.join('').length > 12) return undefined; // long utterance: let the model read it
  const y = words.some((w) => YES_RE.test(w)), n = words.some((w) => NO_RE.test(w));
  if (y === n) return undefined;
  return y ? 'yes' : 'no';
}

export async function handleVoiceTalk(audio, req, res, url, { HttpError }) {
  const t0 = Date.now();
  const q = (k) => url.searchParams.get(k);
  const session = await store.getSession(q('sessionId'));
  if (!session) throw new HttpError(404, 'unknown sessionId');
  const gazeP = (q('gaze') || '').split(',').map(Number);
  const gaze = gazeP.length === 2 && gazeP.every(Number.isFinite) ? { x: gazeP[0], y: gazeP[1] } : (q('gx') != null && q('gy') != null ? { x: +q('gx'), y: +q('gy') } : undefined);
  const body = {
    sessionId: session.id, trigger: 'user', videoTime: q('videoTime') != null ? Number(q('videoTime')) : undefined,
    youtubeId: q('youtubeId') || undefined, videoUrl: q('videoUrl') || undefined, videoTitle: q('videoTitle') || undefined, gaze,
  };
  const lastAgent = String(q('lastAgent') || '').slice(0, 600);
  const asking = q('asking') === '1';

  const st = openStream(res);
  const { emit } = st;
  let tAsr = null, tFirstAudio = null, text = '', mode = '';
  let r = { mode: '', tGate: null, tools: [] };
  let seq = 0, chain = Promise.resolve(), ttfs = null;
  const say = (t) => {
    if (ttfs == null) ttfs = Date.now() - t0;
    emit({ type: 'say', text: t });
    const my = seq++;
    const wav = synthWav(t).catch((e) => { log('tts failed', e.message); return null; }); // starts now, runs while the model keeps streaming
    chain = chain.then(async () => {
      const b = await wav;
      if (!b) return emit({ type: 'audio', seq: my, sentence: t, error: 'tts_failed' });
      if (tFirstAudio == null) tFirstAudio = Date.now() - t0;
      emit({ type: 'audio', seq: my, sentence: t, mime: 'audio/wav', b64: b.toString('base64') });
    });
  };
  const finish = async (extra = {}) => {
    await chain;
    emit({ type: 'done', ms: Date.now() - t0, ...extra }); res.end();
    log(`talk ${mode || r.mode} "${text.slice(0, 30)}" asr=${tAsr ?? '-'}ms gate=${r.tGate ?? '-'}ms ttfs=${ttfs ?? '-'}ms firstAudio=${tFirstAudio ?? '-'}ms total=${Date.now() - t0}ms tools=[${r.tools.join(',')}]`);
  };

  try {
    // frame grab runs while ASR runs (it needs only videoTime/gaze, not the text)
    const framesPromise = yt.grabFrames({ youtubeId: body.youtubeId, videoUrl: body.videoUrl || session.videoUrl }, body.videoTime, body.gaze).catch((e) => { log('frame grab failed:', e.message); return { full: null, crop: null }; });
    const ts = Date.now();
    const j = await transcribe(audio, { lang: q('lang') || 'auto', context: q('context') || '', contentType: req.headers['content-type'] || 'audio/wav' });
    tAsr = Date.now() - ts;
    text = String(j.text || '').trim().slice(0, 600);
    emit({ type: 'asr', text, lang: j.lang ?? null, ms: tAsr });
    if (!text) { mode = 'empty'; return await finish({ empty: true }); }
    if (lastAgent && isEcho(text, lastAgent)) { mode = 'echo'; emit({ type: 'ignored', reason: 'echo' }); return await finish(); }
    if (asking) {
      const value = keywordAnswer(text);
      if (value) { mode = 'answer-kw'; emit({ type: 'answer', value }); return await finish({ answered: true }); }
    }
    body.text = text;
    const hint = asking ? '\n(화면에 예/아니오 질문이 떠 있어요. 시청자 발화는 그 질문에 대한 답이에요. 절대 [IGNORE] 하지 말고 [SAY]로 짧게 받아 주세요.)' : '';
    r = await runTurn({ session, body, trigger: 'user', text, emit, say, isClosed: () => st.closed, t0, hint, asking, framesPromise });
    return await finish();
  } catch (e) {
    log('talk failed', e.stack || e.message);
    mode = mode || 'error';
    emit({ type: 'error', message: String(e.message || e).slice(0, 200) });
    if (!res.writableEnded) await finish();
  }
}
