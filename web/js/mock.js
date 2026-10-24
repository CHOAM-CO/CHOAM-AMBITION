// Local fake backend for ?mock=1. Mimics latency and the response shapes of the API contract.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THINGS = [
  { label: '빨간 스니커즈', category: 'product', description: '화면 왼쪽 인물이 신은 빨간 운동화', query: '빨간 스니커즈 레트로 러닝화' },
  { label: '빈티지 필름 카메라', category: 'product', description: '테이블 위에 놓인 오래된 필름 카메라', query: '빈티지 35mm 필름 카메라' },
  { label: '미니멀 스탠드 조명', category: 'product', description: '배경에 보이는 얇은 금속 스탠드', query: '미니멀 스탠드 조명 무드등' },
  { label: '제주 성산일출봉', category: 'place', description: '제주도 동쪽 끝의 화산 분화구 명소', query: '제주 성산일출봉 여행' },
  { label: '"SALE 50% OFF" 문구', category: 'text', description: '"전 품목 50% 할인"이라는 뜻이에요. 매장 세일 안내 문구예요.', query: 'SALE 50% OFF 뜻' },
  { label: '캔버스 토트백', category: 'product', description: '어깨에 멘 베이지색 가방', query: '캔버스 토트백 베이지' },
];

const mkLinks = (q) => [{ title: `${q} - 쇼핑 검색`, url: 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(q) }];
const ALTS = [
  [{ label: '갈색 구두', say: '아 이거 아닌가요...? 그럼 옆에 갈색 구두요?', links: mkLinks('갈색 가죽 구두') },
   { label: '검은 양말', say: '음, 그럼 혹시 검은 양말이요?', links: mkLinks('검은 양말') }],
  [{ label: '나무 책상', say: '그럼 뒤에 있는 나무 책상이요?', links: mkLinks('원목 책상') }],
];
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#445"/><circle cx="80" cy="80" r="34" fill="none" stroke="#f44" stroke-width="5"/></svg>');
const store = { n: 0, caps: [] };

export async function mockApi(method, path, body) {
  if (path === '/api/health') return { ok: true };

  if (path === '/api/videos') {
    await sleep(150);
    const yt = (id, title, cached) => ({ id: 'yt-' + id, title, source: 'youtube', youtubeId: id, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, cached, duration: 212 });
    return { videos: [
      { id: 'sample', title: '샘플 영상 (mock, 20초)', source: 'mp4', url: 'mock/sample.mp4', cached: true, duration: 20 },
      yt('dQw4w9WgXcQ', '패션 브이로그 (mock)', true),
      yt('jNQXAC9IVRw', '인테리어 투어 (mock)', true),
      yt('9bZkp7q19f0', '아직 준비 중인 영상 (mock)', false),
    ] };
  }

  if (path === '/api/session') {
    await sleep(100);
    return { sessionId: 'mock-' + Math.random().toString(36).slice(2, 8) };
  }

  if (path === '/api/capture') {
    await sleep(1200 + Math.random() * 1200);
    const i = store.n++;
    const t = THINGS[i % THINGS.length];
    const speak = i % 2 === 0;
    const alts = ALTS[i % ALTS.length];
    const links = [
      { title: `${t.label} - 검색 결과`, url: 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(t.query) },
      { title: `${t.label} - 이미지`, url: 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(t.query) },
    ];
    const img = body.image || PLACEHOLDER;
    const rec = { captureId: 'c' + (i + 1), imageUrl: img, videoTime: body.videoTime, label: t.label, links };
    store.caps.push(rec);
    return {
      captureId: rec.captureId,
      imageUrl: img,
      item: { label: t.label, category: t.category, description: t.description },
      speak,
      say: speak ? `방금 ${t.label} 보신 거 맞죠? 더 알아볼까요?` : null,
      query: t.query,
      links,
      alternatives: alts,
    };
  }

  if (path === '/api/feedback') return { ok: true };

  if (path === '/api/summary') {
    await sleep(900);
    const recs = store.caps.map((c) => ({
      captureId: c.captureId,
      imageUrl: c.imageUrl,
      videoTime: c.videoTime,
      label: c.label,
      reason: `${Math.round(c.videoTime)}초 지점에서 오래 시선이 머물렀어요.`,
      links: c.links,
    }));
    return { say: recs.length ? `영상 보시는 동안 눈에 들어온 ${recs.length}가지를 모아봤어요.` : '이번엔 눈여겨본 장면이 없었어요.', recommendations: recs };
  }

  throw new Error('mock: unknown ' + method + ' ' + path);
}
