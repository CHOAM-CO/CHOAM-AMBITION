// Head nod / shake from WebGazer's facemesh landmarks (no extra model).
// pitch/yaw proxies = nose tip offset from the eye-corner midpoint, divided by inter-ocular distance.
import { CONFIG } from './events.js?v=r22';

const xy = (q) => (q ? (Array.isArray(q) ? { x: q[0], y: q[1] } : { x: q.x, y: q.y }) : null);
const median = (a) => { const s = [...a].sort((m, n) => m - n); return s[s.length >> 1]; };

/** count direction reversals with hysteresis `amp`; also peak-to-peak swing in units of amp */
function analyze(vals, amp) {
  let dir = 0, ext = vals[0], rev = 0, min = Infinity, max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
    if (dir === 0) { if (v - ext > amp) { dir = 1; ext = v; } else if (ext - v > amp) { dir = -1; ext = v; } }
    else if (dir === 1) { if (v > ext) ext = v; else if (ext - v > amp) { dir = -1; ext = v; rev++; } }
    else { if (v < ext) ext = v; else if (v - ext > amp) { dir = 1; ext = v; rev++; } }
  }
  return { rev, score: (max - min) / amp };
}

export class HeadGestures {
  /** @param {()=>any[]|null} getPositions  @param {(g:'nod'|'shake')=>void} onGesture */
  constructor(getPositions, onGesture) {
    this.getPositions = getPositions; this.onGesture = onGesture;
    this.base = []; this.win = []; this.listening = false; this.openT = 0; this.lastFire = 0;
  }

  setListening(on, now) {
    if (on && !this.listening) { this.openT = now; this.win = []; }
    this.listening = on;
  }

  update(now) {
    const c = CONFIG.gesture;
    let pos = null;
    try { pos = this.getPositions(); } catch {}
    if (!pos || pos.length < 300) return;
    const n = xy(pos[c.noseIdx]), a = xy(pos[c.eyeLIdx]), b = xy(pos[c.eyeRIdx]);
    if (!n || !a || !b) return;
    const iod = Math.hypot(a.x - b.x, a.y - b.y);
    if (!iod) return;
    const yaw = (n.x - (a.x + b.x) / 2) / iod, pitch = (n.y - (a.y + b.y) / 2) / iod;

    if (!this.listening) {
      this.base.push({ t: now, yaw, pitch });
      while (this.base.length && now - this.base[0].t > c.baselineMs) this.base.shift();
      return;
    }
    if (now - this.openT < c.graceMs || now - this.lastFire < c.cooldownMs || this.base.length < 10) return;
    const by = median(this.base.map((s) => s.yaw)), bp = median(this.base.map((s) => s.pitch));
    this.win.push({ t: now, yaw: yaw - by, pitch: pitch - bp });
    while (this.win.length && now - this.win[0].t > c.windowMs) this.win.shift();
    if (this.win.length < 8) return;
    const P = analyze(this.win.map((s) => s.pitch), c.pitchAmp), Y = analyze(this.win.map((s) => s.yaw), c.yawAmp);
    let g = null;
    if (P.rev >= c.minReversals && (Y.rev < c.minReversals || P.score > Y.score * c.dominance)) g = 'nod';
    else if (Y.rev >= c.minReversals && (P.rev < c.minReversals || Y.score > P.score * c.dominance)) g = 'shake';
    if (g) { this.lastFire = now; this.win = []; this.onGesture(g); }
  }
}
