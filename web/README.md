# NUNCHI web

Static frontend (no build). Open `index.html` via any static server; `?mock=1` fakes the API, `?gaze=mouse` uses the mouse,
`?debug=1` shows the gaze HUD, `?tracker=webgazer` uses the old WebGazer tracker (default is EyeTheia).

Credit / license: the default gaze tracker (`js/eyetheia.js` and the ONNX models served at `/media/models/`) is derived from
[EyeTheia](https://github.com/patherstevenson/EyeTheia) (GPL-3.0) and the iTracker model (Krafka et al., "Eye Tracking for
Everyone"), via Eunho Jung's in-browser port; treat this tracker code and the models as GPL-3.0.
