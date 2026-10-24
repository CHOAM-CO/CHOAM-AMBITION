# NUNCHI web

정적 프런트엔드 (ES 모듈, 빌드 없음). 제품 소개, 아키텍처, API는 [루트 README](../README.md) 참고.

## 로컬 실행

```bash
cd web
python3 -m http.server 8123     # 아무 정적 서버면 됨
```

- 서버 없이 UI만: `http://localhost:8123/?mock=1&gaze=mouse`
- 풀 스택: Caddy가 `web/`을 서빙하고 `/api`를 Node API (`server/`)로 프록시 (`../deploy/Caddyfile`). 웹캠과 마이크는 `localhost` 또는 https에서만 허용됨.

## URL 파라미터

| 파라미터 | 효과 |
|---|---|
| `?mock=1` | API 없이 가짜 응답 (`js/mock.js`, `mock/sample.mp4`) |
| `?gaze=mouse` | 마우스를 시선으로 사용 |
| `?tracker=webgazer` | WebGazer (기본은 EyeTheia) |
| `?calib=click` | 클릭 보정 (기본은 눈만으로 자동 보정) |
| `?model=baseline`, `?margin=px`, `?models=<url>` | EyeTheia 모델 선택, crop 여백, 모델 위치 |
| `?stt=vad\|webspeech\|off` | 음성 입력 방식 |
| `?debug=1` | HUD (시선, 상태, 표정 점수), 입력창, 디버그 키 |

## 키

입력창 밖에서 항상 동작: `Y` 끄덕, `N` 도리도리 (기사 리더가 열려 있으면 닫기), `U` 엄지 위, `D` 엄지 아래, `P` 손바닥, `I` 검지, `V` 브이, `F` 주먹, `M` 마이크 끔/켬.
`?debug=1`일 때 `1` `2` `3` = 웃음, 놀람, 찡그림 시뮬레이션.

런타임 튜닝은 콘솔의 `window.AMBITION_CONFIG` (정의는 `js/events.js`의 `CONFIG`: 시선, 제스처, 표정, 통화, dwell).

## 메모

- 모든 로컬 import에 `?v=rNN`이 붙어 있음. 푸시할 때 올려야 브라우저 캐시가 갱신됨.
- 배포: `main`에 푸시하면 박스가 1분 안에 pull (`../deploy/README.md`).
- `js/eyetheia.js`와 `/media/models/`의 ONNX는 EyeTheia 파생이라 GPL-3.0.
