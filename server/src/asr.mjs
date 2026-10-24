import { config } from './config.mjs';

const err = (status, msg) => Object.assign(new Error(msg), { status });

// STT: wav/raw audio buffer -> local Qwen3-ASR service on the box. Returns the ASR JSON ({text, lang, ...}).
export async function transcribe(audio, { lang = 'auto', context = '', contentType = 'application/octet-stream' } = {}) {
  lang = ['auto', 'ko', 'en'].includes(lang) ? lang : 'auto';
  const ctx = String(context || '').slice(0, 500); // hotword bias for Qwen3-ASR's system prompt
  let r;
  try {
    r = await fetch(`${config.asrUrl}/transcribe?lang=${lang}${ctx ? `&context=${encodeURIComponent(ctx)}` : ''}`, { method: 'POST', body: audio, headers: { 'content-type': contentType }, signal: AbortSignal.timeout(30000) });
  } catch (e) { throw err(502, `asr unavailable: ${e.message}`); }
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { throw err(502, `asr bad response (${r.status})`); }
  if (!r.ok) throw err(502, `asr error ${r.status}: ${String(j.error || txt).slice(0, 200)}`);
  return j;
}
