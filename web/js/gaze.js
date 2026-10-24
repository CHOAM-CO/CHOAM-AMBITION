import { CONFIG } from './events.js?v=r7';
// Gaze sources: WebGazer (webcam) or mouse. Exposes latest raw point in client px.
const WEBGAZER_SRC = 'https://cdn.jsdelivr.net/npm/webgazer@3.4.0/dist/webgazer.min.js';

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

export class MouseSource {
  constructor() { this.mode = 'mouse'; this.p = null; }
  async start() {
    addEventListener('mousemove', (e) => { this.p = { x: e.clientX, y: e.clientY, t: performance.now() }; }, { passive: true });
  }
  latest() { return this.p ? { ...this.p, t: performance.now() } : null; }
  onStatus() {}
}

export class WebGazerSource {
  constructor() { this.mode = 'webcam'; this.p = null; }

  async start(onStatus = () => {}) {
    onStatus('카메라 권한 요청 중…');
    const probe = await navigator.mediaDevices.getUserMedia({ video: true }); // throws if denied
    probe.getTracks().forEach((t) => t.stop());
    onStatus('시선 추적 모델 불러오는 중… (처음엔 몇 초 걸려요)');
    if (!window.webgazer) await loadScript(WEBGAZER_SRC);
    const wg = window.webgazer;
    this.wg = wg;
    if (wg.saveDataAcrossSessions) wg.saveDataAcrossSessions(false);
    wg.setRegression('ridge')
      .setGazeListener((d) => { if (d) this.p = { x: d.x, y: d.y, t: performance.now() }; });
    if (wg.applyKalmanFilter) wg.applyKalmanFilter(true);
    await wg.begin();
    for (let i = 0; i < 300 && !(wg.isReady && wg.isReady()); i++) await new Promise((r) => setTimeout(r, 100));
    wg.showVideoPreview(true).showPredictionPoints(false);
    if (wg.showFaceOverlay) wg.showFaceOverlay(false);
    if (wg.showFaceFeedbackBox) wg.showFaceFeedbackBox(false);
    document.body.classList.add('cam-on');
  }

  latest() { return this.p && performance.now() - this.p.t < 600 ? this.p : null; }

  /** facemesh landmarks (468) from WebGazer's tracker, or null */
  positions() { try { return this.wg.getTracker().getPositions(); } catch { return null; } }

  clear() { if (this.wg && this.wg.clearData) this.wg.clearData(); }

  freeze() { // stop learning from mouse after calibration
    if (this.wg && this.wg.removeMouseEventListeners) this.wg.removeMouseEventListeners();
  }
}

const med = (a) => { const s = [...a].sort((m, n) => m - n); return s[s.length >> 1]; };

/** least-squares v' = k*v + o mapping measured -> target; k clamped, offset-only when < 3 points */
export function fitAxis(meas, tgt) {
  const n = meas.length, mm = meas.reduce((a, b) => a + b, 0) / n, mt = tgt.reduce((a, b) => a + b, 0) / n;
  let k = 1;
  if (n >= 3) {
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (meas[i] - mm) * (tgt[i] - mt); sxx += (meas[i] - mm) ** 2; }
    if (sxx > 0) k = Math.max(CONFIG.correction.minScale, Math.min(CONFIG.correction.maxScale, sxy / sxx));
  }
  return { k, o: mt - k * mm };
}

/** Runs the 9-point calibration + accuracy check. Resolves when the user accepts. */
export async function runCalibration(root, source, getGaze, clickMode = false) {
  const CLICKS = 3;
  const clickPts = [[12, 14], [88, 14], [50, 50], [12, 86], [88, 86]]; // 4 corners inset + center
  const autoPts = []; // 3x3 grid, snake order (L->R, R->L, L->R); bottom row less extreme
  [15, 50, 80].forEach((y, i) => { const xs = [12, 50, 88]; (i % 2 ? xs.reverse() : xs).forEach((x) => autoPts.push([x, y])); });
  let attempt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    Object.assign(CONFIG.correction, { active: false, a: 1, b: 0, c: 1, d: 0 });
    source.clear && source.clear();
    root.hidden = false;
    const field = (root.innerHTML = clickMode
      ? '<p class="calib-msg">화면의 점을 눈으로 보면서 각 점을 3번씩 클릭해 주세요</p><div class="calib-field"></div>'
      : '<p class="calib-msg">나타나는 점을 눈으로만 따라가 주세요. 클릭은 필요 없어요</p><div class="calib-field"></div>',
      root.querySelector('.calib-field'));
    if (clickMode) {
      await new Promise((resolve) => {
        let left = clickPts.length;
        clickPts.forEach(([px, py]) => {
          const b = document.createElement('button');
          b.className = 'calib-pt'; b.style.left = px + '%'; b.style.top = py + '%'; b.textContent = CLICKS;
          let n = CLICKS;
          b.onclick = () => {
            n--; b.textContent = n; b.style.opacity = String(0.35 + 0.65 * (n / CLICKS));
            if (n <= 0) { b.remove(); if (--left === 0) resolve(); }
          };
          field.appendChild(b);
        });
      });
    } else {
      // eyes-only: train WebGazer on every tick while the viewer looks at the point (no clicks, no mouse training)
      source.wg && source.wg.removeMouseEventListeners && source.wg.removeMouseEventListeners();
      const ac = CONFIG.autoCalib;
      await sleep(1500); // let the viewer read the instruction
      for (const [px, py] of autoPts) {
        const d = document.createElement('div');
        d.className = 'calib-pt auto'; d.style.left = px + '%'; d.style.top = py + '%';
        field.appendChild(d);
        d.style.setProperty('--dur', (ac.waitMs + ac.collectMs) + 'ms');
        const x = innerWidth * px / 100, y = innerHeight * py / 100;
        await sleep(ac.waitMs);
        const t0 = performance.now();
        while (performance.now() - t0 < ac.collectMs) {
          if (source.wg) { try { source.wg.recordScreenPosition(x, y, 'click'); } catch {} } // no prediction exists before the first sample, so do not gate on latest()
          await sleep(ac.tickMs);
        }
        d.remove();
      }
    }
    source.freeze && source.freeze();

    // accuracy check
    root.innerHTML = '<p class="calib-msg">정확도 확인 중이에요. 나타나는 점을 계속 봐 주세요</p><div class="calib-field"></div><button class="btn calib-skip">건너뛰기 (보정 덜 정확)</button>';
    let skipped = false;
    root.querySelector('.calib-skip').onclick = () => { skipped = true; };
    const f2 = root.querySelector('.calib-field');
    const checks = [[50, 50], [25, 25], [75, 25], [25, 75], [75, 75]];
    const meas = []; // {tx, ty, mx, my}: target and median predicted point
    for (const [px, py] of checks) {
      if (skipped) break;
      const d = document.createElement('div');
      d.className = 'calib-pt check'; d.style.left = px + '%'; d.style.top = py + '%'; f2.appendChild(d);
      const tx = innerWidth * px / 100, ty = innerHeight * py / 100;
      const xs = [], ys = [];
      const t0 = performance.now();
      while (!skipped && performance.now() - t0 < 1800) {
        await new Promise((r) => setTimeout(r, 33));
        const g = getGaze();
        if (g && performance.now() - t0 > 700) { xs.push(g.x); ys.push(g.y); }
      }
      d.remove();
      if (xs.length) meas.push({ tx, ty, mx: med(xs), my: med(ys) });
    }
    if (skipped) break;
    const meanErr = (f) => (meas.length ? meas.reduce((t, m) => t + Math.hypot(f(m.mx, 'x') - m.tx, f(m.my, 'y') - m.ty), 0) / meas.length : NaN);
    const before = meanErr((v) => v);
    let after = before, applied = false;
    if (meas.length) {
      const fx = fitAxis(meas.map((m) => m.mx), meas.map((m) => m.tx)), fy = fitAxis(meas.map((m) => m.my), meas.map((m) => m.ty));
      Object.assign(CONFIG.correction, { active: true, a: fx.k, b: fx.o, c: fy.k, d: fy.o });
      after = meanErr((v, ax) => (ax === 'x' ? fx.k * v + fx.o : fy.k * v + fy.o));
      applied = true;
    }
    const score = isNaN(after) ? 0 : Math.max(0, Math.round(100 - (after / (innerHeight * 0.35)) * 100));
    const verdict = score >= 70 ? '좋아요' : score >= 45 ? '쓸 만해요' : '낮아요, 다시 보정을 추천해요';
    const line = isNaN(before) ? '얼굴이 인식되지 않았어요' : `${applied ? '보정 반영 · ' : ''}평균 오차 ${Math.round(before)}px → ${Math.round(after)}px · ${verdict}`;
    if (!clickMode) {
      // no buttons: show the result for 2 s, redo once if poor, then go on regardless
      attempt++;
      const redo = score < 45 && attempt === 1;
      root.innerHTML = `<div class="calib-result"><h2>정확도 ${score}%</h2><p>${line}</p><p class="muted">${redo ? '한 번 더 맞춰볼게요' : '곧 시작해요'}</p></div>`;
      await sleep(2000);
      if (redo) continue;
      break;
    }
    root.innerHTML = `<div class="calib-result"><h2>정확도 ${score}%</h2><p>${line}</p>
      <div class="row"><button class="btn" id="cal-redo">다시 보정</button><button class="btn primary" id="cal-go">이대로 시작</button></div></div>`;
    const choice = await new Promise((res) => {
      root.querySelector('#cal-redo').onclick = () => res('redo');
      root.querySelector('#cal-go').onclick = () => res('go');
    });
    if (choice === 'go') break;
    if (clickMode && source.wg && source.wg.addMouseEventListeners) source.wg.addMouseEventListeners();
  }
  root.hidden = true; root.innerHTML = '';
}
