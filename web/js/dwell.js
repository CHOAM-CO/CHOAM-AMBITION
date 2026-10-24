// Generic gaze-dwell button: any element registered here fills a ring while the gaze rests on it,
// then fires onActivate. Only items of the active group respond. Click also activates (mouse fallback).
import { CONFIG } from './events.js?v=r24';

export class Dwell {
  constructor() { this.items = []; this.group = null; this.last = performance.now(); }

  register(el, onActivate, { group, ms = CONFIG.dwell.ms, enabled = () => true } = {}) {
    el.classList.add('dwell');
    const it = { el, onActivate, group, ms, enabled, p: 0, lockUntil: 0 };
    this.items.push(it);
    el.addEventListener('click', () => { if (it.group === this.group && it.enabled()) onActivate(); });
    return it;
  }

  /** drop all items of a group (e.g. before re-rendering the card grid) */
  clear(group) {
    this.items = this.items.filter((it) => {
      if (it.group !== group) return true;
      it.el.style.removeProperty('--dp'); it.el.classList.remove('hot');
      return false;
    });
  }

  setGroup(group) {
    this.group = group;
    const now = performance.now();
    for (const it of this.items) { it.p = 0; it.lockUntil = now + CONFIG.dwell.lockMs; }
  }

  /** g: smoothed gaze {x,y} in client px, or null */
  update(g, now) {
    const dt = Math.min(100, now - this.last); this.last = now;
    const m = CONFIG.dwell.marginPx;
    for (const it of [...this.items]) {
      const live = it.group === this.group && it.el.isConnected && it.el.getClientRects().length > 0 && it.enabled();
      let inside = false;
      if (live && g) {
        const r = it.el.getBoundingClientRect();
        inside = g.x >= r.left - m && g.x <= r.right + m && g.y >= r.top - m && g.y <= r.bottom + m;
      }
      if (!live || now < it.lockUntil) it.p = 0;
      else if (inside) it.p += dt;
      else it.p = Math.max(0, it.p - dt * 2);
      it.el.style.setProperty('--dp', (it.p / it.ms) * 360 + 'deg');
      it.el.classList.toggle('hot', live && inside && it.p > 0);
      if (live && inside && it.p >= it.ms) {
        it.p = 0; it.lockUntil = now + CONFIG.dwell.lockMs;
        try { it.onActivate(); } catch (e) { console.error(e); }
      }
    }
  }
}
