# NUNCHI web

정적 프런트엔드 (ES 모듈, 빌드 없음). 아무 정적 서버로 `index.html`을 열면 돼. 전체 설명, 기능, API, URL 파라미터는 루트 `README.md` 참고.

- `?mock=1` API 가짜, `?gaze=mouse` 마우스 시선, `?debug=1` HUD와 디버그 키, `?tracker=webgazer` 예전 트래커.
- 모든 로컬 import는 `?v=rNN`. 푸시할 때 전부 같이 올려야 해.
- `js/eyetheia.js`와 `/media/models/`의 ONNX는 EyeTheia 파생이라 GPL-3.0.
