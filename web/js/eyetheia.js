// EyeTheia gaze source: MediaPipe FaceLandmarker -> face/eye crops + 25x25 face grid -> iTracker ONNX on
// onnxruntime-web (WebGPU, WASM fallback) -> ridge calibration on [hidden128, raw xy] -> One Euro filter.
//
// Credit: ported from the in-browser EyeTheia viewer by Eunho Jung (branch eyetracker, eyetheia/static/app.js),
// which itself ports EyeTheia (https://github.com/patherstevenson/EyeTheia, GPL-3.0) and the iTracker model
// (Krafka et al., "Eye Tracking for Everyone"). This file and the ONNX models derived from EyeTheia are
// therefore GPL-3.0 as well.
import { CONFIG } from './events.js?v=r18';
import { loadOrt } from './ort.js?v=r18';

const ORT_SRC = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.webgpu.min.js';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
const MP_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const S = 224, GRID = 25;

// MediaPipe FaceMesh indices used by EyeTheia
const LEFT_EYE = [33, 133, 159, 160, 158, 144];
const RIGHT_EYE = [362, 263, 386, 387, 385, 373];
const FACE_OVAL = Array.from({ length: 338 - 10 }, (_, i) => i + 10);
// per model: crop margin px (mpiiface trained with 0, live EyeTheia uses 20); model output -> viewport 0..1
const MODELS = {
  mpiiface: { margin: 0, toNorm: ([x, y]) => [x, y] },
  baseline: { margin: 20, toNorm: ([x, y]) => [(25 + x) / 50, (25 - y) / 50] }, // cm from centre, GAZE_RANGE_CM = 25
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('script load failed: ' + src));
  document.head.appendChild(s);
});

// ---------- One Euro filter (EyeTheia: mincutoff 1.5, beta 0.02, pixel space) ----------
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.02, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.x = this.dx = this.t = null; }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(x, t) {
    if (this.t == null) { this.x = x; this.dx = 0; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (x - this.x);
    return this.x;
  }
}

// ---------- ridge calibration on [hidden(128), raw xy] with leave-one-point-out lambda selection ----------
function solve(A, b) {
  const n = A.length;
  A = A.map((r) => r.slice()); b = b.slice();
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; if (!f) continue; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}

function gram(Z, Y, idx) { // Z^T Z and Z^T Y over rows idx
  const D = Z[0].length, A = Array.from({ length: D }, () => new Float64Array(D)), B = [new Float64Array(D), new Float64Array(D)];
  for (const i of idx) { const z = Z[i]; for (let r = 0; r < D; r++) { const zr = z[r]; if (!zr) continue; B[0][r] += zr * Y[i][0]; B[1][r] += zr * Y[i][1]; for (let c = 0; c < D; c++) A[r][c] += zr * z[c]; } }
  return { A, B };
}

function ridge(G, lambda) {
  const D = G.A.length;
  const A = Array.from({ length: D }, (_, r) => Array.from(G.A[r], (v, c) => v + (r === c && r > 0 ? lambda : 0)));
  return [solve(A, Array.from(G.B[0])), solve(A, Array.from(G.B[1]))];
}

function fitCalibration(X, Y, groups, cols) {
  const sel = (x) => cols.map((j) => x[j]);
  const Xs = X.map(sel), d = cols.length, n = Xs.length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of Xs) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  for (const x of Xs) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = Xs.map((x) => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]);
  const all = gram(Z, Y, Z.keys());
  const byG = new Map();
  groups.forEach((g, i) => { if (!byG.has(g)) byG.set(g, []); byG.get(g).push(i); });
  const G = [...byG.entries()].map(([, idx]) => ({ idx, ...gram(Z, Y, idx) }));
  let best = null;
  for (const lambda of [0.1, 1, 10, 100, 1000, 10000]) {
    let err = 0;
    for (const g of G) { // leave one calibration point out
      const fold = { A: all.A.map((r, i) => r.map((v, j) => v - g.A[i][j])), B: all.B.map((r, k) => r.map((v, j) => v - g.B[k][j])) };
      const W = ridge(fold, lambda);
      for (const i of g.idx) {
        const p = W.map((w) => w.reduce((s, wi, k) => s + wi * Z[i][k], 0));
        err += Math.hypot((p[0] - Y[i][0]) * innerWidth, (p[1] - Y[i][1]) * innerHeight);
      }
    }
    err /= n;
    if (!best || err < best.err) best = { lambda, err };
  }
  return { cols, mu, sd, W: ridge(all, best.lambda), ...best };
}

function predict(c, x) {
  const z = [1, ...c.cols.map((j, k) => (x[j] - c.mu[k]) / c.sd[k])];
  return c.W.map((w) => w.reduce((s, wi, k) => s + wi * z[k], 0));
}

export class EyeTheiaSource {
  constructor() {
    const q = new URLSearchParams(location.search);
    this.mode = 'webcam'; this.kind = 'eyetheia';
    this.smoothing = CONFIG.eyetheia.smoothing; // main loop: lighter median/EMA than WebGazer (One Euro already filters)
    this.modelName = MODELS[q.get('model')] ? q.get('model') : 'mpiiface';
    this.margin = q.has('margin') ? +q.get('margin') : MODELS[this.modelName].margin;
    this.modelBase = q.get('models') || CONFIG.eyetheia.modelBase;
    this.ep = '?'; this.p = null; this.last = null; this.lm = null; this.lmT = 0;
    this.calib = null; this.cal = null; this.recT = 0;
    this.filt = { x: new OneEuro(), y: new OneEuro() };
    this.ms = 0; this.lmMs = 0; this.blend = null; this.blendT = 0;
    this.running = false; this.busy = false;
  }

  async start(onStatus = () => {}) {
    onStatus('카메라 권한 요청 중…');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    const v = this.video = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    await v.play();
    this.cc = {};
    for (const k of ['face', 'left', 'right']) {
      const c = document.createElement('canvas'); c.width = c.height = S;
      this.cc[k] = c.getContext('2d', { willReadFrequently: true });
    }

    onStatus('시선 모델 불러오는 중… (처음엔 30MB 정도 받아요)');
    await loadOrt();
    ort.env.wasm.wasmPaths = ORT_WASM;
    const url = `${this.modelBase}eyetheia_${this.modelName}.onnx`;
    const eps = (navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))) ? ['webgpu', 'wasm'] : ['wasm'];
    for (const ep of eps) {
      try {
        this.session = await ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        const z = new Float32Array(3 * S * S);
        await this._run(z, z, z, new Float32Array(GRID * GRID)); // warm-up (shader compile)
        this.ep = ep; break;
      } catch (e) { console.warn('EyeTheia session failed on', ep, e); this.session = null; }
    }
    if (!this.session) throw new Error('시선 모델을 불러오지 못했어요');

    onStatus('얼굴 인식 모델 불러오는 중…');
    const { FaceLandmarker, FilesetResolver, GestureRecognizer } = await import(MP_BUNDLE);
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
    const make = (delegate) => FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: MP_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true });
    try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
    // hand gestures on the same video, loaded in the background so start-up is not slowed
    import('./hands.js?v=r18').then(async (m) => {
      this.hands = new m.HandGestures((g) => this.onHand && this.onHand(g));
      this.hands.onFeedback = (f) => this.onHandFeedback && this.onHandFeedback(f);
      await this.hands.init({ GestureRecognizer }, fileset, v);
    }).catch((e) => console.warn('hand gestures unavailable', e));

    this.running = true;
    v.requestVideoFrameCallback((t) => this._step(t));
    document.body.classList.add('cam-on');
  }

  async _run(face, left, right, grid) {
    const t = (d) => new ort.Tensor('float32', d, [1, 3, S, S]);
    const o = await this.session.run({ face: t(face), left_eye: t(left), right_eye: t(right), face_grid: new ort.Tensor('float32', grid, [1, GRID * GRID]) });
    return { gaze: Array.from(o.gaze.data), feat: Array.from(o.feat.data) };
  }

  _bbox(indices, pts, W, H, m) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of indices) { const [x, y] = pts[i]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(W, x1 + m), Math.min(H, y1 + m)];
  }

  _crop(ctx, b) {
    ctx.drawImage(this.video, b[0], b[1], Math.max(1, b[2] - b[0]), Math.max(1, b[3] - b[1]), 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data, n = S * S, out = new Float32Array(3 * n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { out[i] = d[j] / 255; out[n + i] = d[j + 1] / 255; out[2 * n + i] = d[j + 2] / 255; }
    return out; // RGB CHW 0..1; BGR flip + mean subtraction are inside the ONNX graph
  }

  _grid(b, W, H) {
    const g = new Float32Array(GRID * GRID);
    const gx = Math.trunc((b[0] / W) * GRID), gy = Math.trunc((b[1] / H) * GRID);
    const gw = Math.trunc(((b[2] - b[0]) / W) * GRID), gh = Math.trunc(((b[3] - b[1]) / H) * GRID);
    for (let y = gy; y < Math.min(GRID, gy + gh); y++) for (let x = gx; x < Math.min(GRID, gx + gw); x++) g[y * GRID + x] = 1;
    return g;
  }

  async _step(now) {
    if (!this.running) return;
    this.video.requestVideoFrameCallback((t) => this._step(t));
    if (this.busy) return;
    this.busy = true;
    try {
      const v = this.video, W = v.videoWidth, H = v.videoHeight;
      const tl = performance.now();
      const r = this.landmarker.detectForVideo(v, now);
      this.lmMs = performance.now() - tl;
      if (!r.faceLandmarks || !r.faceLandmarks.length) { this.last = null; this.blend = null; return; }
      const cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories;
      if (cats) { const o = {}; for (const c of cats) o[c.categoryName] = c.score; this.blend = o; this.blendT = performance.now(); }
      const lm = r.faceLandmarks[0];
      this.lm = lm.map((p) => ({ x: p.x * W, y: p.y * H })); this.lmT = performance.now(); // for head gestures (same mesh topology)
      const pts = lm.map((p) => [Math.trunc(p.x * W), Math.trunc(p.y * H)]);
      const m = this.margin;
      const boxes = { left: this._bbox(LEFT_EYE, pts, W, H, m), right: this._bbox(RIGHT_EYE, pts, W, H, m), face: this._bbox(FACE_OVAL, pts, W, H, m) };
      const face = this._crop(this.cc.face, boxes.face), left = this._crop(this.cc.left, boxes.left), right = this._crop(this.cc.right, boxes.right);
      const t0 = performance.now();
      const out = await this._run(face, left, right, this._grid(boxes.face, W, H));
      this.ms = performance.now() - t0;
      const raw = MODELS[this.modelName].toNorm(out.gaze);
      const l = this.last = { raw, feat: out.feat, t: now, id: (this.last ? this.last.id : 0) + 1 };
      const tn = performance.now();
      let x, y;
      if (this.calib) {
        const [nx, ny] = predict(this.calib, [...l.feat, raw[0], raw[1]]);
        const sg = this.smoothing; // live-tunable
        for (const f of [this.filt.x, this.filt.y]) { f.minCutoff = sg.minCutoff; f.beta = sg.beta; }
        x = this.filt.x.filter(clamp(nx, 0, 1) * innerWidth, tn / 1000); y = this.filt.y.filter(clamp(ny, 0, 1) * innerHeight, tn / 1000);
      } else { x = clamp(raw[0], 0, 1) * innerWidth; y = clamp(raw[1], 0, 1) * innerHeight; }
      this.p = { x, y, t: tn };
    } catch (e) { console.warn('eyetheia step', e); }
    finally { this.busy = false; }
  }

  // ---- source interface (same as WebGazerSource) ----
  latest() { return this.p && performance.now() - this.p.t < 600 ? this.p : null; }
  /** blendshape scores {mouthSmileLeft: 0..1, ...} of the newest frame, null if no face / stale */
  blendshapes() { return this.blend && performance.now() - this.blendT < CONFIG.expression.staleMs ? this.blend : null; }
  positions() { return this.lm && performance.now() - this.lmT < 400 ? this.lm : null; }
  clear() { this.calib = null; this.cal = { X: [], Y: [], groups: [], gid: new Map() }; this.filt.x.reset(); this.filt.y.reset(); }
  freeze() {}

  /** calibration hook: store the newest feature vector with its on-screen target (px). One sample per camera frame. */
  record(x, y) {
    if (!this.cal) this.clear();
    const l = this.last;
    if (!l || l.id === this.recT) return;
    this.recT = l.id;
    const key = `${Math.round(x)},${Math.round(y)}`;
    if (!this.cal.gid.has(key)) this.cal.gid.set(key, this.cal.gid.size);
    this.cal.X.push([...l.feat, l.raw[0], l.raw[1]]);
    this.cal.Y.push([x / innerWidth, y / innerHeight]);
    this.cal.groups.push(this.cal.gid.get(key));
  }

  /** fit the ridge map after the last point; keeps raw output scaled to the viewport if there is too little data */
  fit() {
    const c = this.cal;
    if (!c || new Set(c.groups).size < 5) { console.warn('EyeTheia: too few calibration points with a face'); return false; }
    const d = c.X[0].length;
    const full = fitCalibration(c.X, c.Y, c.groups, [...Array(d).keys()]); // hidden features + raw output
    const affine = fitCalibration(c.X, c.Y, c.groups, [d - 2, d - 1]);    // raw output only
    this.calib = full.err <= affine.err ? { ...full, kind: 'hidden128+raw' } : { ...affine, kind: 'raw affine' };
    this.calib.n = c.X.length;
    this.filt.x.reset(); this.filt.y.reset();
    return true;
  }

  debugInfo() {
    const g = this.smoothing;
    return `eyetheia ${this.modelName} ${this.ep.toUpperCase()} ${this.ms.toFixed(0)}ms landmarker+blendshapes ${this.lmMs.toFixed(0)}ms | smooth minCutoff=${g.minCutoff} beta=${g.beta} win=${g.window} alpha=${g.alpha} dz=${g.deadzonePx}px` +
      (this.hands ? ` hand=${this.hands.cur || '-'}` : '') +
      (this.calib ? ` cv=${this.calib.err.toFixed(0)}px ${this.calib.kind} λ=${this.calib.lambda} n=${this.calib.n}` : ' (uncalibrated)');
  }
}
