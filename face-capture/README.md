# Face Capture (standalone)

A single-purpose port of the m42 `PhotoScreen` guided face-capture flow.
Two files, no build step, **no web server** — just open `index.html`.

```
face-capture/
├── index.html          markup + styling + the CDN bootstrap
└── face-capture.js     all logic (checks, auto-capture, validation)
```

## Run it

Double-click `index.html`, or:

```bash
open index.html
```

That's it. It needs an **internet connection** — MediaPipe (the runtime, its
WASM and the face-landmark model) loads from jsDelivr / Google's model bucket,
both of which allow cross-origin requests from a `file://` page. `getUserMedia`,
`blob:` URLs and classic `<script>` tags all work on `file://` (a secure
context) in Chrome, Safari and Firefox, so no `http://localhost` is needed. The
browser will still ask you to **allow camera access**.

### How the loading works

`index.html` runs an inline `<script type="module">` that imports the ESM
runtime from the CDN (allowed cross-origin from `file://`), stashes it on
`window.__mpVision`, then injects `face-capture.js` as a **classic** script — an
external `<script type="module" src>` would be CORS-blocked on `file://`, a
classic one isn't. `face-capture.js` then points `FilesetResolver` and
`modelAssetPath` at CDN URLs.

Pinned to `@mediapipe/tasks-vision@1.0.1` (`MP_VERSION` in `face-capture.js`).

### Offline / no-CDN

To run without the CDN, copy the assets in from the repo and repoint the paths:

```bash
mkdir -p vendor/wasm models
cp ../node_modules/@mediapipe/tasks-vision/wasm/* vendor/wasm/
cp ../public/models/face_landmarker.task models/
```

Then in `face-capture.js` set `WASM_PATH = './vendor/wasm'` and
`MODEL_PATH = './models/face_landmarker.task'`, and also swap the inline module
in `index.html` to import `./vendor/vision_bundle.mjs`
(`cp ../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs vendor/`).

That combination needs a static server — `fetch()` and ES-module imports are
blocked on `file://` — e.g. `python3 -m http.server` from this folder. (The
`float16/1` model from Google's bucket is byte-identical to
`public/models/face_landmarker.task`, SHA-256
`64184e22…e0bc9ff`.)

## What it does

Same five checks as the app, same tunables (`CFG` in `face-capture.js`, copied
verbatim from `src/lib/faceGuide.ts`):

1. **Lighting** — mean luma of the face region
2. **Head pose** — yaw/pitch/roll from the transform matrix
3. **Face position** — size + centering against the on-screen guide
4. **Glasses** — eye-band / bridge / temple darkness heuristics
5. **Mask / occlusion** — lower-face chroma shift, left/right symmetry

All must pass for `CFG.captureHold` consecutive detections, then it captures
(auto, if enabled) and re-validates the still.

## Settings (persisted in `localStorage`, same keys as the app)

- **Auto-capture when ready**
- **Oval guide** — swaps the rounded-rectangle guide for the oval one
- **Face-covering check** — toggles the glasses / mask / occlusion check
