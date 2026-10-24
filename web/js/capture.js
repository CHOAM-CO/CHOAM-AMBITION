// Frame grab + square crop around the gaze point.
import { CONFIG } from './events.js?v=r5';

let display = null; // {stream, video} for YouTube

export async function startDisplayCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' }, preferCurrentTab: true, selfBrowserSurface: 'include', audio: false,
  });
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  display = { stream, video };
  stream.getVideoTracks()[0].addEventListener('ended', () => { display = null; });
}
export const hasDisplayCapture = () => !!display;

const raf = () => new Promise((r) => requestAnimationFrame(r));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// gx, gy: gaze point in source-pixel coords; a red ring is drawn there so the vision model sees it
function encode(src, sx, sy, sw, sh, gx, gy) {
  const out = Math.round(Math.min(sw, sh, CONFIG.maxCropPx));
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, out);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  ctx.strokeStyle = CONFIG.ringColor;
  ctx.lineWidth = Math.max(3, c.width * 0.012);
  ctx.beginPath();
  ctx.arc((gx - sx) / sw * c.width, (gy - sy) / sh * c.height, c.width * 0.09, 0, Math.PI * 2);
  ctx.stroke();
  return c.toDataURL('image/jpeg', CONFIG.jpegQuality);
}

/** @returns {{image:string, gaze:{x:number,y:number}}} gaze normalized 0-1 within the video rect */
export async function grab(player, gx, gy) {
  const rect = player.contentRect();
  const nx = clamp((gx - rect.left) / rect.width, 0, 1);
  const ny = clamp((gy - rect.top) / rect.height, 0, 1);
  const gaze = { x: +nx.toFixed(4), y: +ny.toFixed(4) };

  if (player.kind === 'mp4') {
    const v = player.el, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw) throw new Error('video not ready');
    const side = CONFIG.cropRatio * Math.min(vw, vh);
    const sx = clamp(nx * vw - side / 2, 0, vw - side), sy = clamp(ny * vh - side / 2, 0, vh - side);
    return { image: encode(v, sx, sy, side, side, nx * vw, ny * vh), gaze };
  }

  if (!display) throw new Error('화면 공유가 꺼져 있어요');
  document.body.classList.add('grabbing'); // hide gaze dot so it is not in the crop
  await raf(); await raf(); await new Promise((r) => setTimeout(r, 60));
  try {
    const dv = display.video, kx = dv.videoWidth / innerWidth, ky = dv.videoHeight / innerHeight;
    const sideCss = CONFIG.cropRatio * Math.min(rect.width, rect.height);
    const cx = clamp(gx, rect.left + sideCss / 2, rect.left + rect.width - sideCss / 2);
    const cy = clamp(gy, rect.top + sideCss / 2, rect.top + rect.height - sideCss / 2);
    return { image: encode(dv, (cx - sideCss / 2) * kx, (cy - sideCss / 2) * ky, sideCss * kx, sideCss * ky, gx * kx, gy * ky), gaze };
  } finally {
    document.body.classList.remove('grabbing');
  }
}
