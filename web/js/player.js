// Player abstraction: mp4 (<video>) and YouTube (IFrame API).
// Interface: {kind, isPlaying(), time(), contentRect(), onEnded(cb), play(), pause(), title, destroy()}

export function parseYouTube(input) {
  const s = (input || '').trim();
  let m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (!m && /^[\w-]{11}$/.test(s)) m = [s, s];
  if (!m) return null;
  return { id: m[1], shorts: /\/shorts\//.test(s), url: 'https://www.youtube.com/watch?v=' + m[1] };
}

function setAspect(host, w, h) {
  host.style.setProperty('--ar', `${w} / ${h}`);
  host.style.setProperty('--arn', String(w / h));
}

export function createMp4Player(host, url) {
  host.innerHTML = '';
  setAspect(host, 16, 9);
  const v = document.createElement('video');
  v.src = url; v.controls = true; v.playsInline = true; v.preload = 'auto';
  host.appendChild(v);
  v.addEventListener('loadedmetadata', () => v.videoWidth && setAspect(host, v.videoWidth, v.videoHeight));
  let endedCb = () => {};
  v.addEventListener('ended', () => endedCb());
  return {
    kind: 'mp4', el: v,
    isPlaying: () => !v.paused && !v.ended && v.readyState >= 2,
    time: () => v.currentTime || 0,
    contentRect() { // letterbox-aware picture rect
      const r = v.getBoundingClientRect();
      if (!v.videoWidth) return r;
      const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      const w = v.videoWidth * s, h = v.videoHeight * s;
      const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
      return { left, top, width: w, height: h, right: left + w, bottom: top + h };
    },
    onEnded: (cb) => { endedCb = cb; },
    play: () => v.play().catch(() => {}),
    pause: () => v.pause(),
    title: null,
    destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); host.innerHTML = ''; },
  };
}

let ytReady;
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((res, rej) => {
    if (window.YT && window.YT.Player) return res();
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => rej(new Error('YouTube API 로드 실패'));
    document.head.appendChild(s);
  });
  return ytReady;
}

export async function createYouTubePlayer(host, yt) {
  await loadYT();
  host.innerHTML = '<div id="yt-target"></div>';
  if (yt.shorts) setAspect(host, 9, 16); else setAspect(host, 16, 9);
  let state = -1, endedCb = () => {};
  const p = await new Promise((res) => {
    const player = new YT.Player('yt-target', {
      videoId: yt.id, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, autoplay: 1, origin: location.origin },
      events: {
        onReady: () => { try { player.unMute(); player.playVideo(); } catch {} res(player); },
        onStateChange: (e) => { state = e.data; if (e.data === 0) endedCb(); },
      },
    });
  });
  let title = null;
  try { title = p.getVideoData().title || null; } catch {}
  return {
    kind: 'youtube', el: host,
    isPlaying: () => state === 1,
    time: () => { try { return p.getCurrentTime() || 0; } catch { return 0; } },
    contentRect: () => host.getBoundingClientRect(),
    onEnded: (cb) => { endedCb = cb; },
    play: () => { try { p.playVideo(); } catch {} },
    pause: () => { try { p.pauseVideo(); } catch {} },
    title,
    destroy: () => { try { p.destroy(); } catch {} host.innerHTML = ''; },
  };
}
