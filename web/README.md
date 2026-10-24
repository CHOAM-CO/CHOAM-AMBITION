# NUNCHI web

Static frontend (ES modules, no build step). For the product overview, architecture and API, see the [root README](../README.md) ([한국어](../README.ko.md)).

## Run locally

```bash
cd web
python3 -m http.server 8123     # any static server works
```

- UI only, no server: `http://localhost:8123/?mock=1&gaze=mouse`
- Full stack: Caddy serves `web/` and proxies `/api` to the Node API in `server/` (`../deploy/Caddyfile`). Webcam and mic only work on `localhost` or https.

## URL parameters

| Parameter | Effect |
|---|---|
| `?mock=1` | Fake API responses (`js/mock.js`, `mock/sample.mp4`) |
| `?gaze=mouse` | Mouse as gaze |
| `?tracker=webgazer` | WebGazer (default is EyeTheia) |
| `?calib=click` | Click calibration (default is automatic, eyes only) |
| `?model=baseline`, `?margin=px`, `?models=<url>` | EyeTheia model, crop margin, model location |
| `?stt=vad\|webspeech\|off` | Speech input mode |
| `?debug=1` | HUD (gaze, state, expression scores), text input, debug keys |

## Keys

Always active outside text inputs: `Y` nod, `N` shake (closes the article reader if open), `U` thumb up, `D` thumb down, `P` palm, `I` pointing, `V` victory, `F` fist, `M` mic mute.
With `?debug=1`, `1` `2` `3` simulate smile, surprise, frown.

Tune values live from the console with `window.AMBITION_CONFIG` (defined as `CONFIG` in `js/events.js`: gaze, gestures, expressions, call, dwell).

## Notes

- Every local import carries `?v=rNN`. Bump it when you push so browsers drop their cache.
- Deploy: push to `main` and the box pulls within a minute (`../deploy/README.md`).
- `js/eyetheia.js` and the ONNX files under `/media/models/` derive from EyeTheia, so they are GPL-3.0.
