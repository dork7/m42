---
name: face-capture-quality
description: >
  Build a browser-based guided face capture UI that ensures a clean, clear
  photo of a person's face — works on desktop and mobile (iOS Safari, Android
  Chrome). Checks: correct lighting, face centered and correctly sized, head
  facing forward, no face mask, no glasses. Auto-captures once all checks pass.
  Uses MediaPipe Tasks Vision (FaceLandmarker + blendshapes). No server, no
  extra libraries, no matching or recognition. Use when the user wants to
  capture a clear face photo for ID, KYC, onboarding, or any flow where skin
  visibility and photo quality matter across devices.
aliases: [face capture, selfie capture, clear face photo, face photo quality,
          mask detection, glasses detection, face framing, KYC photo capture,
          ID photo capture, face photo check]
---

# Face Capture — Quality & Clarity Checks

## What this builds

A guided face capture UI that works on both desktop (webcam) and mobile
(front-facing camera) and auto-captures a photo once all quality checks pass.
The captured JPEG is guaranteed to have:

- Correct lighting (not too dark, not too bright)
- Face fully visible and centered in frame
- Head looking straight at the camera
- No face mask
- No glasses

One library, one model, everything in the browser — desktop and mobile.

---

## The only dependency

```bash
npm i @mediapipe/tasks-vision
```

Nothing else. No CDN, no server, no extra libraries.

The package ships its own WASM binaries. The face landmark model (~6 MB) is
fetched from Google's model CDN on first initialisation and cached by the
browser. To go fully offline, download the model file to your own assets
and point `modelAssetPath` at the local path (see Initialisation below).

---

## Hard requirements

- Page must be served over **HTTPS or `localhost`** — browsers block
  `getUserMedia` on plain `http://`, including on mobile.
- Run the detection loop inside `requestAnimationFrame`, never `setInterval`.
- Use `runningMode: "VIDEO"` for the live webcam loop.
- Include the viewport meta tag — without it mobile browsers zoom in and
  break the layout:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  ```
- Add `playsinline` to the `<video>` element — iOS Safari requires it to
  prevent the video from opening full-screen:
  ```html
  <video id="video" autoplay muted playsinline></video>
  ```

---

## Initialisation

```js
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Points at the WASM binaries bundled inside node_modules
const fileset = await FilesetResolver.forVisionTasks(
  new URL("@mediapipe/tasks-vision/wasm", import.meta.url).href
);

const landmarker = await FaceLandmarker.createFromOptions(fileset, {
  baseOptions: {
    // Online (cached after first load):
    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    // Offline alternative — copy the .task file to your public assets:
    // modelAssetPath: "/assets/face_landmarker.task",
    delegate: "GPU",   // falls back to CPU automatically if GPU unavailable
  },
  runningMode: "VIDEO",
  numFaces: 1,
  outputFacialTransformationMatrixes: true,  // needed for head pose
  outputFaceBlendshapes: true,               // needed for mask detection
});
```

### Camera setup — front-facing on all devices

`facingMode: "user"` selects the front camera on mobile and the webcam on
desktop. Always request the front camera for face capture.

```js
async function startCamera(videoEl, overlayCanvas) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",       // front camera on mobile, webcam on desktop
      width:  { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  videoEl.srcObject = stream;
  await videoEl.play();

  // Match overlay canvas size to actual video dimensions
  syncCanvasSize(videoEl, overlayCanvas);
}

function syncCanvasSize(videoEl, overlayCanvas) {
  overlayCanvas.width  = videoEl.videoWidth;
  overlayCanvas.height = videoEl.videoHeight;
}
```

**Handle orientation changes on mobile** — the video dimensions flip when
the user rotates their phone:

```js
screen.orientation?.addEventListener("change", () => {
  syncCanvasSize(videoEl, overlayCanvas);
});
// Fallback for iOS (does not support screen.orientation)
window.addEventListener("resize", () => {
  syncCanvasSize(videoEl, overlayCanvas);
});
```

### Mirroring — desktop vs mobile

On desktop, mirror the live preview so it feels like a mirror (CSS
`transform: scaleX(-1)` on the `<video>`). On mobile front cameras the
browser already mirrors the preview in most cases, but the captured canvas
must always be un-mirrored so the saved image reflects real-world orientation.

```js
// Live preview — mirror on desktop, leave as-is on mobile
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
videoEl.style.transform = isMobile ? "none" : "scaleX(-1)";
```

```js
// Capture — always un-mirror the saved image
function capture(videoEl) {
  const c = document.createElement("canvas");
  c.width  = videoEl.videoWidth;
  c.height = videoEl.videoHeight;
  const ctx = c.getContext("2d");
  if (!isMobile) {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);   // undo the desktop preview mirror
  }
  ctx.drawImage(videoEl, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}
```

### Per-frame detection

```js
const result      = landmarker.detectForVideo(videoEl, performance.now());
const landmarks   = result.faceLandmarks?.[0];       // 478 points [{x,y,z}]
const matrix      = result.facialTransformationMatrixes?.[0]?.data;
const blendshapes = result.faceBlendshapes;
```

If `landmarks` is empty/undefined: no face detected — show "Position your
face in the circle" and reset the capture streak.

### Performance on low-end mobile

MediaPipe's WASM + GPU delegate runs at 20–30 fps on mid-range phones
(2020+). On older or low-end devices it may drop to 10–15 fps. The
`requestAnimationFrame` loop self-throttles to the device's actual frame
rate — no extra throttling needed. If you observe jank, reduce video
resolution to `640×480` in `getUserMedia`.

---

## The five checks

Run all five every frame. All must pass simultaneously for `captureHold`
consecutive frames before auto-capture fires.

### 1 — Lighting

Sample brightness of the **face region only** (not the whole frame — a dark
background would cause false negatives).

```js
const sample = document.createElement("canvas");
sample.width = 80; sample.height = 80;
const sctx = sample.getContext("2d", { willReadFrequently: true });

function brightness(lm, videoEl) {
  const box = faceBox(lm);
  sctx.drawImage(
    videoEl,
    box.minX * videoEl.videoWidth,
    box.minY * videoEl.videoHeight,
    box.w    * videoEl.videoWidth,
    box.h    * videoEl.videoHeight,
    0, 0, 80, 80
  );
  const { data } = sctx.getImageData(0, 0, 80, 80);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
  return sum / (data.length / 4);
}
```

| Brightness | State | User message |
|---|---|---|
| 90 – 190 | ✅ Good | — |
| 55 – 215 | 🟡 Ok | — (still capturable) |
| < 55 | ❌ Fail | "Too dark — find better lighting" |
| > 215 | ❌ Fail | "Too bright — avoid direct light" |

Consider 90–215 as the passing range (Good + Ok both allow capture).

### 2 — Head pose (look straight)

Decompose the 4×4 column-major pose matrix into yaw / pitch / roll:

```js
function eulerFromMatrix(m) {
  const r00=m[0], r10=m[1], r20=m[2], r21=m[6], r22=m[10];
  const d = 180 / Math.PI;
  return {
    pitch: Math.atan2(r21, r22) * d,
    yaw:   Math.atan2(-r20, Math.hypot(r21, r22)) * d,
    roll:  Math.atan2(r10, r00) * d,
  };
}

const { yaw, pitch, roll } = eulerFromMatrix(matrix);
const worst = Math.max(Math.abs(yaw), Math.abs(pitch), Math.abs(roll));
```

| worst | State | User message |
|---|---|---|
| ≤ 9° | ✅ Good | — |
| ≤ 16° | 🟡 Almost | "Almost — look straight ahead" |
| > 16° | ❌ Fail | "Look straight at the camera" |

### 3 — Face position (size + centering)

```js
function faceBox(lm) {
  let minX=1, minY=1, maxX=0, maxY=0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;  if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;  if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY,
           w: maxX-minX, h: maxY-minY,
           cx: (minX+maxX)/2, cy: (minY+maxY)/2 };
}

const box  = faceBox(landmarks);
const offX = Math.abs(box.cx - 0.5);
const offY = Math.abs(box.cy - 0.46);  // 0.46 = slightly above center
```

| Condition | User message |
|---|---|
| `box.w < 0.42` | "Move closer" |
| `box.w > 0.66` | "Move back" |
| `offX > 0.10` or `offY > 0.10` | "Center your face" |
| else | ✅ Pass |

### 4 — No face mask

A mask suppresses mouth and lip blendshape activity to near zero.

```js
function blendshapeScore(blendshapes, name) {
  return blendshapes?.[0]?.categories
    .find(c => c.categoryName.toLowerCase() === name.toLowerCase())
    ?.score ?? 0;
}

const mouthActivity =
    blendshapeScore(blendshapes, "mouthOpen")
  + blendshapeScore(blendshapes, "mouthSmileLeft")  * 0.5
  + blendshapeScore(blendshapes, "mouthSmileRight") * 0.5
  + blendshapeScore(blendshapes, "mouthFunnel");

const lmCoverage = landmarks.filter(p => Math.abs(p.z) < 0.3).length / landmarks.length;

const hasMask = mouthActivity < CFG.maskMouthThresh && lmCoverage < 0.88;
```

If `hasMask` is true → "Remove face mask".

### 5 — No glasses

Glasses frames create a Z-depth discontinuity in the eye-orbit landmarks.
Measure the Z-variance across both eye orbits:

```js
function zVariance(lm, indices) {
  const vals = indices.map(i => lm[i]?.z ?? 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
}

const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263];
const eyeVar = (zVariance(landmarks, EYE_L) + zVariance(landmarks, EYE_R)) / 2;

const hasGlasses = eyeVar > CFG.glassEyeVarThresh;
```

If `hasGlasses` is true → "Remove glasses".

---

## Auto-capture

Count consecutive frames where all five checks pass. After `CFG.captureHold`
frames, call `capture()` (defined in the Initialisation section above):

```js
let streak = 0;

function tick() {
  // ... run all five checks, set allPass = true/false
  streak = allPass ? streak + 1 : 0;
  if (streak >= CFG.captureHold) {
    const dataUrl = capture(videoEl);
    // hand dataUrl (or use c.toBlob) to the rest of your app
  }
  requestAnimationFrame(tick);
}
```

`captureHold: 12` = ~400 ms at 30 fps, ~800 ms at 15 fps (low-end mobile).
Both feel natural to the user.

---

## Tunable configuration

```js
const CFG = {
  // Lighting
  lightMin:          55,     // minimum brightness to allow capture
  lightMax:          215,    // maximum brightness to allow capture

  // Head pose
  poseGood:          9,      // max degrees — "Good"
  poseOk:            16,     // max degrees — "Almost" (still blocks capture)

  // Face position
  sizeMin:           0.42,   // minimum face width fraction
  sizeMax:           0.66,   // maximum face width fraction
  centerTol:         0.10,   // max normalized offset from center

  // Mask detection
  maskMouthThresh:   0.055,  // mouth blendshape activity below this = masked

  // Glasses detection
  glassEyeVarThresh: 0.0018, // eye Z-variance above this = glasses

  // Capture
  captureHold:       12,     // consecutive passing frames before capture (~400ms)
};
```

---

## Check priority and user messaging

Show only the **most important** failing check at a time — don't overwhelm
the user with multiple messages. Suggested priority order:

1. No face detected → "Position your face in the circle"
2. Mask detected → "Remove face mask"
3. Glasses detected → "Remove glasses"
4. Lighting fail → "Too dark" / "Too bright"
5. Position fail → "Move closer" / "Move back" / "Center your face"
6. Pose fail → "Look straight at the camera"
7. All pass → "Hold still…" (then auto-capture)

---

## Implementation checklist

1. Serve over **HTTPS or localhost** — required on both desktop and mobile.
2. Add `<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">`.
3. Add `autoplay muted playsinline` to the `<video>` element — `playsinline`
   is required on iOS Safari.
4. Use `facingMode: "user"` in `getUserMedia` to select the front camera on
   mobile and the webcam on desktop.
5. Enable both `outputFacialTransformationMatrixes` and `outputFaceBlendshapes`
   in the landmarker options — both are required.
6. Run detection in `requestAnimationFrame`, not `setInterval`.
7. Sync the overlay canvas size to `videoEl.videoWidth/Height` after `play()`,
   and again on `resize` / `screen.orientation change` (mobile rotation).
8. Mirror the live preview on desktop only (`scaleX(-1)` CSS on `<video>`);
   leave it as-is on mobile.
9. Un-mirror the canvas on capture for desktop only (see capture function).
10. Show a circular guide overlay sized relative to `min(vw, vh)` so it
    fits both portrait mobile and landscape desktop.
11. Display a single status message at a time (see priority order above).
12. Reset streak to 0 the moment any check fails.
13. Handle camera permission denial with a clear fallback message — on mobile
    this often means the user must go to browser settings to re-enable.
14. Optionally show a preview + "Retake" button after capture — especially
    important on mobile where retaking is common.

---

## Key landmark indices

| Region | Indices |
|---|---|
| Left eye orbit | 33, 7, 163, 144, 145, 153, 154, 155, 133 |
| Right eye orbit | 362, 382, 381, 380, 374, 373, 390, 249, 263 |
| Mouth | 13, 14, 17, 18, 87, 178, 88, 95 |
| Nose tip | 1, 2, 4, 5, 195, 197 |

---

## Key blendshape names used

| Name | Used for |
|---|---|
| `mouthOpen` | Mask detection |
| `mouthSmileLeft` / `mouthSmileRight` | Mask detection |
| `mouthFunnel` | Mask detection |