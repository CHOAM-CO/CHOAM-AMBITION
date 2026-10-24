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
  bubbleTtlMs: 45000,

  // head gestures (from WebGazer facemesh landmarks), only while a bubble asks a question
  gesture: {
    noseIdx: 1, eyeLIdx: 33, eyeRIdx: 263, // facemesh: nose tip, outer eye corners
    baselineMs: 2000,           // rolling-median baseline, frozen while the bubble is open
    graceMs: 600,               // ignore motion this long after the bubble opens
    windowMs: 1500,             // a gesture must complete within this window
    minReversals: 2,            // direction reversals needed (down-up-down = 2)
    pitchAmp: 0.05,             // nod: reversal hysteresis / min swing, in inter-ocular distances
    yawAmp: 0.06,               // shake: same, for yaw
    dominance: 1.2,             // winning axis swing (relative to its amp) must beat the other by this factor
    cooldownMs: 1200,
  },

  // EyeTheia tracker (default; ?tracker=webgazer for the old path; ?model=baseline, ?margin=px, ?models=<base url>)
  eyetheia: {
    modelBase: '/media/models/',
    // live-tunable (window.AMBITION_CONFIG.eyetheia.smoothing). One Euro runs in the source; the median + EMA + dead-zone in the main loop.
    smoothing: { minCutoff: 0.4, beta: 0.005, window: 6, alpha: 0.2, deadzonePx: 25 },
  },

  // hand gestures (MediaPipe GestureRecognizer): Thumb_Up=yes, Thumb_Down=no, Open_Palm=pause/resume, Pointing_Up=capture here, Victory=next video
  hands: { fps: 10, minScore: 0.6, holdMs: 600, cooldownMs: 1500 },

  // voice chat
  voice: { duckLevel: 0.15, minChars: 2 }, // duck the video to 15% while either side talks; ignore finals of <= minChars
  // call mode (VAD + ASR + streamed TTS)
  call: { positiveThreshold: 0.6, negativeThreshold: 0.4, redemptionMs: 800, minSpeechMs: 250, preSpeechPadMs: 300, idleMs: 45000, speakDialogs: true },

  // gaze-dwell buttons (home cards, watch/summary controls)
  dwell: { ms: 1500, marginPx: 24, lockMs: 1000 },
  nextVideoAutoMs: 15000,       // summary: auto-advance to the next video

  // eyes-only calibration (default); ?calib=click uses click calibration
  autoCalib: { waitMs: 700, collectMs: 1000, tickMs: 50 },

  // per-axis bias map from the accuracy check: x' = a*x + b, y' = c*y + d (applied to webcam gaze before smoothing)
  correction: { active: false, a: 1, b: 0, c: 1, d: 0, minScale: 0.6, maxScale: 1.6 },
};

if (typeof window !== 'undefined') window.AMBITION_CONFIG = CONFIG; // tweak live from the console

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** median of the last `window` samples -> EMA -> dead-zone for the displayed point.
 *  `cfg` is read on every push ({window, alpha, deadzonePx}), so it is live-tunable.
 *  .x/.y = smoothed signal (events + dwell read this); .shownX/.shownY = what the dot draws. */
export class GazeSmoother {
  constructor() { this.reset(); }
  reset() { this.win = []; this.x = this.y = this.shownX = this.shownY = null; }
  push(raw, cfg) {
    this.win.push(raw);
    while (this.win.length > Math.max(1, cfg.window)) this.win.shift();
    const med = (k) => { const v = this.win.map((p) => p[k]).sort((m, n) => m - n); return v[v.length >> 1]; };
    const mx = med('x'), my = med('y');
    if (this.x == null) { this.x = mx; this.y = my; this.shownX = mx; this.shownY = my; return this; }
    this.x += cfg.alpha * (mx - this.x); this.y += cfg.alpha * (my - this.y);
    const dz = cfg.deadzonePx || 0, d = dist(this.x, this.y, this.shownX, this.shownY);
    if (d > dz) { // trail the smoothed point at the dead-zone edge instead of snapping
      this.shownX = this.x + (this.shownX - this.x) * (dz / d);
      this.shownY = this.y + (this.shownY - this.y) * (dz / d);
    }
    return this;
  }
}

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
