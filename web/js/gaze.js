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

  clear() { if (this.wg && this.wg.clearData) this.wg.clearData(); }

  freeze() { // stop learning from mouse after calibration
    if (this.wg && this.wg.removeMouseEventListeners) this.wg.removeMouseEventListeners();
  }
}

/** Runs the 9-point calibration + accuracy check. Resolves when the user accepts. */
export async function runCalibration(root, source, getGaze) {
  const CLICKS = 5;
  const pts = [[10, 10], [50, 10], [90, 10], [10, 50], [50, 50], [90, 50], [10, 90], [50, 90], [90, 90]];
  for (;;) {
    source.clear && source.clear();
    root.hidden = false;
    root.innerHTML = '<p class="calib-msg">화면의 점을 눈으로 보면서 각 점을 5번씩 클릭해 주세요</p><div class="calib-field"></div>';
    const field = root.querySelector('.calib-field');
    await new Promise((resolve) => {
      let left = pts.length;
      pts.forEach(([px, py]) => {
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
    source.freeze && source.freeze();

    // accuracy check
    root.innerHTML = '<p class="calib-msg">정확도 확인 중이에요. 나타나는 점을 계속 봐 주세요</p><div class="calib-field"></div>';
    const f2 = root.querySelector('.calib-field');
    const checks = [[50, 50], [25, 25], [75, 25], [25, 75], [75, 75]];
    const errs = [];
    for (const [px, py] of checks) {
      const d = document.createElement('div');
      d.className = 'calib-pt check'; d.style.left = px + '%'; d.style.top = py + '%'; f2.appendChild(d);
      const tx = innerWidth * px / 100, ty = innerHeight * py / 100;
      const ds = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 1800) {
        await new Promise((r) => setTimeout(r, 33));
        const g = getGaze();
        if (g && performance.now() - t0 > 700) ds.push(Math.hypot(g.x - tx, g.y - ty));
      }
      d.remove();
      if (ds.length) { ds.sort((a, b) => a - b); errs.push(ds[Math.floor(ds.length / 2)]); }
    }
    const err = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
    const score = isNaN(err) ? 0 : Math.max(0, Math.round(100 - (err / (innerHeight * 0.35)) * 100));
    const verdict = score >= 70 ? '좋아요' : score >= 45 ? '쓸 만해요' : '낮아요, 다시 보정을 추천해요';
    root.innerHTML = `<div class="calib-result"><h2>정확도 ${score}%</h2><p>${isNaN(err) ? '얼굴이 인식되지 않았어요' : `평균 오차 약 ${Math.round(err)}px · ${verdict}`}</p>
      <div class="row"><button class="btn" id="cal-redo">다시 보정</button><button class="btn primary" id="cal-go">이대로 시작</button></div></div>`;
    const choice = await new Promise((res) => {
      root.querySelector('#cal-redo').onclick = () => res('redo');
      root.querySelector('#cal-go').onclick = () => res('go');
    });
    if (choice === 'go') break;
    source.wg && source.wg.addMouseEventListeners && source.wg.addMouseEventListeners();
  }
  root.hidden = true; root.innerHTML = '';
}
