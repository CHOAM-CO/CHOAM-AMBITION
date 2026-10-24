// Gaze event detection (fixation + saccade-landing). Pure logic, no DOM.
// All tunables live in CONFIG below.

export const CONFIG = {
  // pipeline
  sampleHz: 30,                 // gaze is sampled/smoothed at this rate
  medianWindow: 8,              // webcam gaze: per-axis median of the last N samples, then EMA
  smoothingAlpha: 0.15,         // EMA factor after the median (lower = smoother, laggier)
  medianWindowMouse: 1,         // ?gaze=mouse: no median
  smoothingAlphaMouse: 0.6,     // ?gaze=mouse EMA factor

  // fixation: gaze stays within radius for >= minDurationMs -> one capture
  fixation: {
    radiusPx: 130,              // dispersion radius around running centroid
    minDurationMs: 1000,
    outlierTolerance: 3,        // consecutive out-of-radius samples before the fixation restarts
  },

  // saccade: velocity spike, then settle at the landing point
  saccade: {
    velocityPxPerS: 900,        // spike threshold (heavily smoothed gaze)
    velocityWindowMs: 100,      // velocity measured over this window
    settleRadiusPx: 90,         // must stay within this radius ...
    settleMs: 300,              // ... for this long to count as landed
    maxMoveMs: 1500,            // give up if we never settle
  },

  // capture gating
  dedupeRadiusPx: 150,          // skip a capture if close to the previous one ...
  dedupeWithinMs: 3000,         // ... and this recent (fixation right after its own saccade landing)
  minGapMs: 700,                // global cooldown between captures

  // image
  cropRatio: 0.55,              // square side = ratio * short side of the video frame (clamped inside the frame)
  ringColor: 'rgba(255, 40, 40, 0.7)', // gaze ring drawn on the crop (not filled)
  jpegQuality: 0.8,
  maxCropPx: 512,               // downscale crops larger than this

  // agent bubble
  bubbleTtlMs: 30000,
};

if (typeof window !== 'undefined') window.AMBITION_CONFIG = CONFIG; // tweak live from the console

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export class GazeEventDetector {
  /** @param {(ev:{kind:'fixation'|'saccade', x:number, y:number, dwellMs:number})=>void} onEvent */
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.lastCap = null;
    this.reset();
  }

  reset() {
    this.hist = [];
    this.fix = { n: 0, sx: 0, sy: 0, startT: 0, fired: false, out: 0 };
    this.sac = { state: 'idle', moveT: 0, n: 0, sx: 0, sy: 0, ax: 0, ay: 0, startT: 0 };
    this.fixProgress = 0;
  }

  /** feed one smoothed sample (client px). Call only while playing and gaze is inside the video. */
  push(t, x, y) {
    this.hist.push({ t, x, y });
    while (this.hist.length && t - this.hist[0].t > 600) this.hist.shift();
    this._fixation(t, x, y);
    this._saccade(t, x, y);
  }

  get sacState() { return this.sac.state; }

  _velocity(t, x, y) {
    const w = CONFIG.saccade.velocityWindowMs;
    let ref = null;
    for (const h of this.hist) { if (t - h.t <= w) { ref = h; break; } }
    if (!ref || t - ref.t < w * 0.5) return 0;
    return dist(x, y, ref.x, ref.y) / ((t - ref.t) / 1000);
  }

  _fixation(t, x, y) {
    const c = CONFIG.fixation, f = this.fix;
    if (f.n === 0) { this._fixStart(t, x, y); return; }
    const cx = f.sx / f.n, cy = f.sy / f.n;
    if (dist(x, y, cx, cy) > c.radiusPx) {
      f.out++;
      if (f.out >= c.outlierTolerance) this._fixStart(t, x, y);
      return;
    }
    f.out = 0; f.n++; f.sx += x; f.sy += y;
    const dur = t - f.startT;
    this.fixProgress = f.fired ? 1 : Math.min(1, dur / c.minDurationMs);
    if (!f.fired && dur >= c.minDurationMs) {
      f.fired = true;
      this._emit('fixation', t, f.sx / f.n, f.sy / f.n, dur);
    }
  }

  _fixStart(t, x, y) {
    this.fix = { n: 1, sx: x, sy: y, startT: t, fired: false, out: 0 };
    this.fixProgress = 0;
  }

  _saccade(t, x, y) {
    const c = CONFIG.saccade, s = this.sac;
    const v = this._velocity(t, x, y);
    if (s.state === 'idle') {
      if (v >= c.velocityPxPerS) { s.state = 'moving'; s.moveT = t; }
    } else if (s.state === 'moving') {
      if (v < c.velocityPxPerS * 0.5) this._settleStart(t, x, y);
      else if (t - s.moveT > c.maxMoveMs) s.state = 'idle';
    } else { // settling
      if (v >= c.velocityPxPerS) { s.state = 'moving'; s.moveT = t; return; }
      if (dist(x, y, s.ax, s.ay) > c.settleRadiusPx) { this._settleStart(t, x, y); return; }
      s.n++; s.sx += x; s.sy += y;
      if (t - s.startT >= c.settleMs) {
        s.state = 'idle';
        this._emit('saccade', t, s.sx / s.n, s.sy / s.n, t - s.startT);
      }
    }
  }

  _settleStart(t, x, y) {
    const s = this.sac;
    s.state = 'settling'; s.ax = x; s.ay = y; s.sx = x; s.sy = y; s.n = 1; s.startT = t;
  }

  _emit(kind, t, x, y, dwellMs) {
    const l = this.lastCap;
    if (l) {
      if (t - l.t < CONFIG.minGapMs) return;
      if (t - l.t < CONFIG.dedupeWithinMs && dist(x, y, l.x, l.y) < CONFIG.dedupeRadiusPx) return;
    }
    this.lastCap = { t, x, y };
    this.onEvent({ kind, x, y, dwellMs: Math.round(dwellMs) });
  }
}
