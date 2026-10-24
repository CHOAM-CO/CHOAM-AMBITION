# NUNCHI — 눈치 있는 AI

NUNCHI는 영상을 같이 보는 AI 시청 동행이야. 웹캠으로 시선, 표정, 고개와 손동작을 읽고 마이크로 말을 듣고, 지금 화면에서 무엇을 보고 있는지 알아서 먼저 말을 걸어. 오래 바라본 장면은 캡처해서 무슨 영상인지 맥락과 함께 이해하고, 관련 영상이나 기사를 제안해. 엄지나 끄덕임, 목소리 "응"으로 받으면 바로 틀어주거나 앱 안에서 기사를 보여줘. 본 장면은 시간순 기억으로 쌓여서 "아까 내가 웃었던 장면 뭐였지?" 같은 질문에도 답해.

Live: https://ambition.choam.studio (도메인과 repo 이름은 AMBITION 그대로)

## 기능 (구현된 것)

- **시선 추적**: 브라우저 안 EyeTheia (MediaPipe FaceLandmarker + iTracker ONNX, onnxruntime-web WebGPU/WASM) + 눈 보정 + One Euro 필터. 보조로 WebGazer (`?tracker=webgazer`), 마우스 (`?gaze=mouse`).
- **시선 캡처**: 한 곳을 오래 보는 fixation과 큰 시선 이동 saccade를 감지해 프레임을 캡처하고, 시선 주변 crop까지 에이전트에 보냄. dwell로 버튼과 홈 카드를 선택.
- **장면 기억**: saccade마다 전체 프레임을 Haiku가 전사 (물건/인물/특징/요약). 실제 시각과 영상 위치가 붙은 시간순 타임라인으로 에이전트 컨텍스트에 들어가서 시간 감각이 있음. 표정이 감지된 장면은 `(이때 시청자(사용자)의 표정이 웃음으로 감지됨)`으로 같이 저장.
- **콘텐츠 우선 에이전트**: 영상마다 컨텍스트 팩 (yt-dlp 메타/자막 + Sonnet 웹 조사)을 만들어 두고, 장면 질문에 YES를 받으면 youtube_search/웹 검색으로 구체적인 영상이나 기사 하나를 offer → YES → play (영상은 플레이어로 열고, 기사는 `/api/article` 리더). 가격 조회만 상품 카드(items)로 나옴.
- **음성 통화**: Silero VAD (`@ricky0123/vad-web`) → Qwen3-ASR (ko/en) → 에이전트 → 한국어 Pocket-TTS. `/api/voice/talk` 한 번의 왕복으로 ASR, 응답, 문장별 TTS 오디오까지 NDJSON 스트림. 말하는 중 끼어들기와 에코 필터 지원. `?stt=webspeech`는 브라우저 음성 인식 대체.
- **고개 제스처**: 질문이 열려 있을 때 끄덕임/도리도리 (FaceLandmarker 랜드마크).
- **손동작** (MediaPipe GestureRecognizer): 엄지 위/아래 = 응/아니, 손바닥 = 멈춤/재생, 검지 = 이거 (지금 시선 지점 캡처), 브이 = 다음 영상, 주먹 (700ms 유지) = 마이크 끔/켬. 마이크가 꺼지면 VAD가 멈추고 모든 요청에 `micMuted:true`가 붙어 에이전트가 제스처로 답하게 묻는다.
- **표정**: FaceLandmarker blendshape로 웃음, 놀람, 찡그림을 유지시간과 쿨다운으로 감지해 한마디 반응하고 장면 기억에 기록. 임계값은 `CONFIG.expression`.
- **화면**: Chzzk 스타일 시청 화면. 영상 위 danmaku, 상단 중앙 yes/no 질문 줄, 오른쪽 채팅 컬럼, 에이전트 상태 칩.
- **내 영상 추가**: YouTube 주소를 붙여 넣으면 서버가 캐시하고 임베드로 바로 재생. 캐시되면 시선 캡처 동작.

## 구조

```
브라우저 (web/, 정적 ES 모듈, 빌드 없음)
   │  https
Cloudflare tunnel → Caddy (:8787, web/ 정적 서빙 + /api 리버스 프록시 + /media)
                        └─ Node API (server/, 127.0.0.1:8788)
                              ├─ Claude (비전/에이전트/요약), 웹 검색
                              ├─ Qwen3-ASR 서비스 (127.0.0.1:8790)
                              ├─ Pocket-TTS 워커 풀 (server/tts)
                              └─ yt-dlp / ffmpeg (영상 캐시, 프레임 추출)
```

박스 (Windows, `D:\ambition`): `deploy/pull.ps1`이 1분마다 main을 pull하고, `server/`가 바뀌면 `npm ci` 후 API를 재시작해. 자세한 건 `deploy/README.md`. `web/` 모든 로컬 import에 `?v=rNN`이 붙어 있어서 푸시할 때 올려야 캐시가 갱신돼.

## URL 파라미터

| 파라미터 | 효과 |
|---|---|
| `?mock=1` | API 없이 가짜 응답 |
| `?gaze=mouse` | 마우스를 시선으로 사용 |
| `?tracker=webgazer` | WebGazer (기본은 EyeTheia) |
| `?calib=click` | 클릭 보정 (기본은 눈만으로 자동 보정) |
| `?model=baseline`, `?margin=px`, `?models=<url>` | EyeTheia 모델 선택, crop 여백, 모델 위치 |
| `?stt=vad\|webspeech\|off` | 음성 입력 방식 |
| `?debug=1` | HUD (시선, 상태, 표정 점수), 입력창, 디버그 키 |

런타임 튜닝은 콘솔의 `window.AMBITION_CONFIG` (시선, 제스처, 표정, 통화 값).

## 키보드 대용 (입력창 밖에서 항상 동작)

`Y` 끄덕, `N` 도리도리, `U` 엄지 위, `D` 엄지 아래, `P` 손바닥, `I` 검지, `V` 브이, `F` 주먹, `M` 마이크 끔/켬. `?debug=1`일 때 `1` `2` `3`은 웃음, 놀람, 찡그림 시뮬레이션.

## API (server/src/index.mjs, server/tts)

| 엔드포인트 | 용도 |
|---|---|
| `GET /api/health` | 상태 |
| `GET /api/videos` | 카탈로그 |
| `POST /api/session` | 세션 만들기 |
| `POST /api/capture` | 시선 캡처 → 분석, 질문 줄, 이월 offer |
| `POST /api/feedback` | 질문에 대한 yes/no 기록 |
| `POST /api/scene`, `GET /api/scene?sessionId=`, `GET /api/scene/img/:sid/:id.jpg` | 장면 기억 기록/조회/이미지 (`trigger`, `expression`, `gaze`, `async`) |
| `POST /api/voice/turn` | 텍스트 입력 턴, NDJSON (`say` `tool` `items` `offer` `play` `ignored` `done`). `trigger: user\|idle\|followup\|accept` |
| `POST /api/voice/talk` | 오디오 입력 한 번에: `asr` `answer` + `say` + `audio` 스트림 |
| `POST /api/asr` | 음성 → 텍스트 (Qwen3-ASR) |
| `POST /api/chat` | JSON 채팅 (offer 포함) |
| `POST /api/summary` | 영상 요약과 추천 |
| `POST /api/youtube/add`, `/remove`, `/prefetch`, `GET /api/youtube/status/:id` | 내 영상 추가/삭제/캐시 |
| `GET /api/pack/:youtubeId` | 영상 컨텍스트 팩 |
| `GET /api/article?url=` | 기사 본문 추출 |
| `POST /api/tts`, `POST /api/tts/stream`, `GET /api/tts/health` | 한국어 TTS (`server/tts/README.md`) |

서버 환경 변수는 `AMBITION_*` (`server/src/config.mjs`), API 키는 박스의 `D:\ambition\secrets\api.env`.

## 크레딧 / 라이선스

- 이 repo는 Apache-2.0 (`LICENSE`). 단 시선 추적 코드 `web/js/eyetheia.js`와 거기서 쓰는 ONNX 모델은 [EyeTheia](https://github.com/patherstevenson/EyeTheia) (GPL-3.0)와 iTracker (Krafka et al., "Eye Tracking for Everyone")에서 파생됐고 Eunho Jung의 브라우저 포트를 거쳤으므로 GPL-3.0으로 취급.
- 음성 인식: Qwen3-ASR (Apache-2.0).
- TTS: Pocket-TTS (Kyutai), 한국어 100M 모델 (seastar105), CC BY 4.0. 목소리 conditioning `sera`는 Supertonic 3 합성 프리셋 클론으로 OpenRAIL-M, repo에는 포함하지 않음.
- VAD: Silero VAD / `@ricky0123/vad-web`. 손동작과 얼굴 인식: MediaPipe Tasks (Apache-2.0). 클라이언트 추론: onnxruntime-web.
