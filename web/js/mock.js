// Local fake backend for ?mock=1. Mimics latency and the response shapes of the API contract.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THINGS = [
  { label: '빨간 스니커즈', category: 'fashion', description: '화면 왼쪽 인물이 신은 빨간 운동화', query: '빨간 스니커즈 레트로 러닝화' },
  { label: '빈티지 필름 카메라', category: 'gadget', description: '테이블 위에 놓인 오래된 필름 카메라', query: '빈티지 35mm 필름 카메라' },
  { label: '미니멀 스탠드 조명', category: 'interior', description: '배경에 보이는 얇은 금속 스탠드', query: '미니멀 스탠드 조명 무드등' },
  { label: '캔버스 토트백', category: 'fashion', description: '어깨에 멘 베이지색 가방', query: '캔버스 토트백 베이지' },
];

const store = { n: 0, caps: [] };

export async function mockApi(method, path, body) {
  if (path === '/api/health') return { ok: true };

  if (path === '/api/videos') {
    await sleep(150);
    return { videos: [{ id: 'sample', title: '샘플 영상 (mock, 20초)', url: 'mock/sample.mp4' }] };
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
    const links = [
      { title: `${t.label} - 쇼핑 검색`, url: 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(t.query) },
      { title: `${t.label} - 비슷한 이미지`, url: 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(t.query) },
    ];
    const rec = { captureId: 'c' + (i + 1), imageUrl: body.image, videoTime: body.videoTime, label: t.label, links };
    store.caps.push(rec);
    return {
      captureId: rec.captureId,
      imageUrl: body.image,
      item: { label: t.label, category: t.category, description: t.description },
      speak,
      say: speak ? `방금 ${t.label} 눈여겨 보신 것 같은데, 찾아볼까요?` : null,
      query: t.query,
      links,
    };
  }

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
