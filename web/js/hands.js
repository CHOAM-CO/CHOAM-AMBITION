// Hand gestures: MediaPipe GestureRecognizer (canned gestures) on the same camera video, throttled (~10 fps).
// Thumb_Up / Thumb_Down fire at once; Open_Palm / Pointing_Up / Victory must be held CONFIG.hands.holdMs.
import { CONFIG } from './events.js?v=r16';

const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const INSTANT = new Set(['Thumb_Up', 'Thumb_Down']);
const HELD = new Set(['Open_Palm', 'Pointing_Up', 'Victory']); // Closed_Fist is recognized but unmapped

export class HandGestures {
  /** @param {(name:string)=>void} onGesture  name is the MediaPipe category, e.g. 'Thumb_Up' */
  constructor(onGesture) {
    this.onGesture = onGesture; this.onFeedback = null; this.rec = null; this.timer = null;
    this.label = null; this.since = 0; this.fired = new Map(); this.cur = ''; this.lastVT = -1;
  }

  async init(mod, fileset, video) {
    this.video = video;
    const make = (delegate) => mod.GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 1 });
    try { this.rec = await make('GPU'); } catch { this.rec = await make('CPU'); }
    this.timer = setInterval(() => this.tick(performance.now()), 1000 / CONFIG.hands.fps);
  }

  tick(now) {
    const c = CONFIG.hands, v = this.video;
    if (!this.rec || v.readyState < 2 || v.currentTime === this.lastVT) return;
    this.lastVT = v.currentTime;
    let name = null, score = 0;
    try {
      const r = this.rec.recognizeForVideo(v, now);
      const g = r.gestures && r.gestures[0] && r.gestures[0][0];
      if (g && g.categoryName !== 'None') { name = g.categoryName; score = g.score; }
    } catch { return; }
    this.cur = name ? `${name} ${score.toFixed(2)}` : '';
    const ok = name && score >= c.minScore;
    if (this.onFeedback) this.onFeedback(ok ? { name, score, progress: now - (this.fired.get(name) || -1e9) < c.cooldownMs ? 1 : HELD.has(name) && name === this.label ? Math.min(1, (now - this.since) / c.holdMs) : INSTANT.has(name) ? 1 : 0, mapped: INSTANT.has(name) || HELD.has(name) } : null);
    if (!name || score < c.minScore || !(INSTANT.has(name) || HELD.has(name))) { this.label = null; return; }
    if (name !== this.label) { this.label = name; this.since = now; }
    if (now - (this.fired.get(name) || -1e9) < c.cooldownMs) return;
    if (INSTANT.has(name) || now - this.since >= c.holdMs) {
      this.fired.set(name, now);
      this.label = null; // must drop and re-show to fire again
      this.onGesture(name);
    }
  }
}
