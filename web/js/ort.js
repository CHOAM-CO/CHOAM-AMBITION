// One shared loader for onnxruntime-web (EyeTheia, Silero VAD): the global `ort` must only be loaded once.
export const ORT_VER = '1.29.0';
export const ORT_SRC = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.min.js`;
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
let p = null;
export function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}
export function loadOrt() {
  if (window.ort) return Promise.resolve();
  if (!p) p = loadScript(ORT_SRC).catch((e) => { p = null; throw e; });
  return p;
}
