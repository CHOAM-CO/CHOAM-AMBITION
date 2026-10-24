// Thin API client. ?mock=1 swaps every /api call for local fake responses.
import { mockApi } from './mock.js?v=r10';

export const PARAMS = new URLSearchParams(location.search);
export const MOCK = PARAMS.get('mock') === '1';

async function call(method, path, body) {
  if (MOCK) return mockApi(method, path, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!r.ok) {
      const err = new Error(`${method} ${path} -> ${r.status}`);
      err.status = r.status;
      err.body = await r.json().catch(() => null);
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => call('GET', '/api/health'),
  videos: () => call('GET', '/api/videos'),
  session: (b) => call('POST', '/api/session', b),
  capture: (b) => call('POST', '/api/capture', b),
  summary: (b) => call('POST', '/api/summary', b),
  chat: (b) => call('POST', '/api/chat', b),
  feedback: (b) => call('POST', '/api/feedback', b).catch(() => {}), // fire and forget, endpoint may 404
};
