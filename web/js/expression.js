// Facial expressions from MediaPipe FaceLandmarker blendshapes (EyeTheia source, same model, no extra inference).
// Each kind is a 0..1 score; it must stay >= its threshold for holdMs, then fires once, then sleeps cooldownMs.
// All thresholds are guesses: CONFIG.expression (live-tunable via window.AMBITION_CONFIG), live scores in ?debug=1.
import { CONFIG } from './events.js?v=r24';

const avg = (b, ...k) => k.reduce((s, n) => s + (b[n] || 0), 0) / k.length;

export const KINDS = ['웃음', '놀람', '찡그림'];

export function scoreOf(b) {
  return {
    웃음: avg(b, 'mouthSmileLeft', 'mouthSmileRight'),
    놀람: avg(b, 'browInnerUp', 'eyeWideLeft', 'eyeWideRight', 'jawOpen'),
    찡그림: (avg(b, 'browDownLeft', 'browDownRight') + Math.max(avg(b, 'mouthFrownLeft', 'mouthFrownRight'), avg(b, 'noseSneerLeft', 'noseSneerRight'))) / 2,
  };
}

// fake blendshapes for the debug keys 1/2/3
export const SIM = {
  웃음: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9 },
  놀람: { browInnerUp: 0.9, eyeWideLeft: 0.9, eyeWideRight: 0.9, jawOpen: 0.9 },
  찡그림: { browDownLeft: 0.9, browDownRight: 0.9, mouthFrownLeft: 0.9, mouthFrownRight: 0.9 },
};

export class ExpressionDetector {
  /** @param {(kind:string)=>void} onFire  @param {()=>boolean} canFire  false while a question is open or anyone talks */
  constructor(onFire, canFire) {
    this.onFire = onFire; this.canFire = canFire;
    this.label = null; this.since = 0; this.fired = new Map(); this.lastAny = -1e9;
    this.cur = ''; this.scores = null;
  }

  update(now, b) {
    const c = CONFIG.expression;
    if (!b) { this.cur = ''; this.scores = null; this.label = null; return; }
    const sc = this.scores = scoreOf(b);
    let best = null, ratio = 1;
    for (const k of KINDS) { const r = sc[k] / c.threshold[k]; if (r >= ratio) { best = k; ratio = r; } }
    this.cur = best || '';
    if (!best) { this.label = null; return; }
    if (best !== this.label) { this.label = best; this.since = now; }
    if (!this.canFire()) { this.since = now; return; } // blocked: the hold starts over once it is allowed
    if (now - this.since < c.holdMs[best] || now - (this.fired.get(best) || -1e9) < c.cooldownMs || now - this.lastAny < c.minGapMs) return;
    this.fired.set(best, now); this.lastAny = now;
    this.label = null; // must relax and show again to fire again
    this.onFire(best);
  }

  debug() {
    const s = this.scores;
    return s ? KINDS.map((k) => `${k} ${s[k].toFixed(2)}/${CONFIG.expression.threshold[k]}`).join('  ') + `  cur=${this.cur || '-'}` : 'expr: no face';
  }
}
