---
name: face-capture-guidance
description: >
  In face detector section, build an in-browser face-capture UI with live framing guidance: a webcam view
  inside a circular guide with real-time status chips for Lighting, head pose
  ("Look Straight"), and Face Position ("Come Closer" / "Move Back" / "Center
  Face"), auto-capturing a photo once all checks pass. Uses MediaPipe Tasks
  Vision (FaceLandmarker), installed via npm with self-hosted wasm + model (no
  CDN). Framework-agnostic; all detection runs client-side. Use this when the
  user wants a selfie/ID-style capture screen, face framing guidance, "position
  your face in the circle" flow, or a photo-capture step gated on good lighting
  and a centered, front-facing face.
---

# Face Capture with Live Guidance

## What this builds

A camera screen that guides the user to take a well-framed face photo. Over the
live webcam feed it shows three status chips that update every frame:

- **Lighting** — Good / Ok / Too Dark / Too Bright
- **Look Straight** — Good / Almost / Look Straight (head pose)
- **Face Position** — Good / Come Closer / Move Back / Center Face

A circular guide overlays the face. When all three checks pass for a short,
stable streak, it auto-captures a photo and returns it as a data URL (or `Blob`)
ready to upload.

All face detection is **client-side** (WASM/GPU in the browser). No server is
needed for detection — the server only receives the final captured image, if you
choose to upload it. **No CDN is used** — the library, its wasm runtime, and the
model file are all installed and served from your own project.

## Library choice (do not substitute)

Use **`@mediapipe/tasks-vision`** — Google's MediaPipe Tasks Vision package.
Use the **`FaceLandmarker`** task because it provides both:

1. 478 face landmarks → used for the face bounding box (size + centering).
2. `facialTransformationMatrixes` (a 4×4 pose matrix) → used for head pose
   (yaw / pitch / roll), which powers the "Look Straight" check.

Do **not** use `face-api.js` (unmaintained, no head-pose matrix) or
`tfjs face-landmarks-detection` (heavier wrapper around the same model). If only
centering + size is needed and head pose is not required, `FaceDetector` from the
same package is a lighter alternative — but the reference below uses
`FaceLandmarker` to support all three checks.

## Install (npm) and self-host the assets — no CDN - if already not installed

1. Install the package:

   ```
   npm i @mediapipe/tasks-vision
   ```

2. Copy the wasm runtime into a static/public folder your app serves. The files
   ship inside the package:

   ```
   cp -r node_modules/@mediapipe/tasks-vision/wasm  public/vendor/mediapipe/wasm
   ```

   (Adjust `public/` to your framework's static dir — e.g. `static/`, `dist/`,
   `assets/`. Automate this as a `postinstall` or build step so it stays in sync.)

3. Obtain the model file **once** and place it in your static folder. Download
   `face_landmarker.task` from the official MediaPipe model releases (Google's
   MediaPipe "Face Landmarker" model card / model index) on a build machine with
   internet, then commit or bundle it:

   ```
   public/models/face_landmarker.task
   ```

4. In code, import from the npm package and point `FilesetResolver` and
   `modelAssetPath` at those **local** paths (see reference). Nothing loads from a
   CDN at runtime.

If your app uses a bundler (Vite/webpack/etc.), importing `@mediapipe/tasks-vision`
resolves from `node_modules`; only the wasm folder and the `.task` model must be
served as static assets from your own origin.

## Hard requirements

- The page **must be served over HTTPS or `localhost`**. Browsers block
  `navigator.mediaDevices.getUserMedia` on plain `http://` origins.
- The wasm folder and `face_landmarker.task` must be reachable as static files on
  your own origin (no external network needed at runtime — good for air-gapped
  deployments).
- Request camera permission; handle denial gracefully with a visible message.

## The three checks (logic)

Compute all of these once per frame from a single
`landmarker.detectForVideo(video, timestamp)` result. If `faceLandmarks` is
empty, show a "No Face" / "Position your face in the circle" state.

### 1. Lighting
Sample brightness of **only the face region** (not the whole frame, so a dark
background doesn't cause a false negative). Draw the face bounding-box area of
the video into a tiny offscreen canvas, average the luminance
(`0.2126*R + 0.7152*G + 0.0722*B`), and threshold:

- `90–190` → **Good** (green)
- `55–215` → **Ok** (amber) — acceptable
- `< 55` → **Too Dark** (red)
- `> 215` → **Too Bright** (red)

### 2. Look Straight (head pose)
Enable `outputFacialTransformationMatrixes: true`. Decompose the 4×4
(column-major) matrix into yaw/pitch/roll degrees and take the worst absolute
angle:

- `≤ 9°` → **Good** (green)
- `≤ 16°` → **Almost** (amber)
- else → **Look Straight** (red)

### 3. Face Position (size + centering)
Build the face bounding box from the min/max of the landmark coordinates
(normalized 0–1). `w` is box width as a fraction of frame width; `cx/cy` is the
box center:

- `w < 0.42` → **Come Closer** (red)
- `w > 0.66` → **Move Back** (red)
- `|cx − 0.5| > 0.10` or `|cy − 0.46| > 0.10` → **Center Face** (amber)
- else → **Good** (green)

(The `0.46` vertical target matches the circle being slightly above center;
adjust to your guide's position.)

### Capture
Keep a counter of consecutive "all three good" frames. After ~12 frames, capture:
draw the current video frame to a canvas (un-mirror it first so the saved image
matches real orientation), export via `toDataURL('image/jpeg', 0.92)` or
`canvas.toBlob(...)`, and hand it to the app (show a preview + "Retake", and/or
POST it to the server).

## Tuning

All thresholds live in one `CFG` object so they can be tuned per design:
- `sizeGoodMin/Max` — how close "Come Closer / Move Back" trigger, relative to
  your circle size.
- `centerTol` — how strict centering is.
- `poseGood/poseOk` — head-pose strictness.
- `light*` — brightness bands.
- `captureHold` — frames of stability before auto-capture.

## Important caveat — this is framing, NOT liveness

These checks verify that a face is well-lit, centered, and front-facing. They do
**not** perform liveness / anti-spoofing — a printed photo or a face on a phone
screen held to the camera can pass. If this capture feeds identity verification,
add a dedicated liveness layer (e.g. a blink/head-turn active challenge using the
same landmarks and blendshapes, or a dedicated anti-spoofing SDK). State this
limitation to the user if the context is identity/KYC.

## Reference implementation

Framework-agnostic. The example imports from the npm package and loads the wasm +
model from local static paths. For React/Vue/Svelte, move the loop into a
component and manage `captured`/streak in state; the detection logic is identical.
For a server-rendered template (EJS/Handlebars/etc.), paste the markup + styles
into the view and put the script in a bundled/served module.

> Adjust the two local paths to match where you copied the assets:
> `LOCAL_WASM_PATH` and `LOCAL_MODEL_PATH`.

```html
<div class="frame">
  <video id="video" autoplay muted playsinline></video>
  <canvas class="overlay" id="overlay"></canvas>
  <div class="chips">
    <div class="chip warn" id="chip-light"><div class="label">Lighting</div><div class="value" id="val-light">…</div></div>
    <div class="chip warn" id="chip-pose"><div class="label">Look Straight</div><div class="value" id="val-pose">…</div></div>
    <div class="chip warn" id="chip-pos"><div class="label">Face Position</div><div class="value" id="val-pos">…</div></div>
  </div>
  <div class="hint" id="hint"></div>
  <div class="loading" id="loading">Loading model…</div>
  <div class="shot" id="shot"><img id="shot-img" alt="capture" /><button class="retake" id="retake">Retake</button></div>
</div>

<style>
  :root { --good:#16a34a; --warn:#d9a400; --bad:#dc2626; }
  * { box-sizing: border-box; }
  .frame { position:relative; width:380px; max-width:96vw; aspect-ratio:3/4;
    background:#000; border-radius:14px; overflow:hidden; }
  video, .overlay { position:absolute; inset:0; width:100%; height:100%; }
  video { object-fit:cover; transform:scaleX(-1); } /* mirror like a selfie */
  .overlay { pointer-events:none; }
  .chips { position:absolute; top:12px; left:12px; right:12px; display:flex; gap:8px; z-index:3; }
  .chip { flex:1; border-radius:10px; padding:8px 6px; text-align:center; color:#fff;
    line-height:1.15; background:var(--warn); transition:background .25s ease; }
  .chip.good { background:var(--good); } .chip.warn { background:var(--warn); } .chip.bad { background:var(--bad); }
  .chip .label { font-size:12px; font-weight:600; opacity:.95; }
  .chip .value { font-size:13px; font-weight:800; margin-top:2px; }
  .hint { position:absolute; bottom:40px; left:0; right:0; text-align:center; color:#fff;
    font-size:14px; font-weight:700; z-index:3; text-shadow:0 1px 4px rgba(0,0,0,.8); }
  .shot { position:absolute; inset:0; z-index:6; display:none; }
  .shot img { width:100%; height:100%; object-fit:cover; }
  .retake { position:absolute; bottom:16px; left:50%; transform:translateX(-50%); z-index:7;
    padding:10px 18px; border:0; border-radius:999px; background:#fff; color:#111; font-weight:700; cursor:pointer; }
  .loading { position:absolute; inset:0; display:grid; place-items:center; z-index:4; color:#ccc; background:#000; }
</style>

<script type="module">
// npm import — resolved from node_modules by your bundler (no CDN)
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Self-hosted asset paths (served from your own origin) — adjust to your setup
const LOCAL_WASM_PATH  = "/vendor/mediapipe/wasm";
const LOCAL_MODEL_PATH = "/models/face_landmarker.task";

const CFG = {
  lightGoodMin:90, lightGoodMax:190, lightOkMin:55, lightOkMax:215,
  poseGood:9, poseOk:16,
  sizeGoodMin:0.42, sizeGoodMax:0.66, centerTol:0.10,
  captureHold:12,
};

const video   = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx    = overlay.getContext("2d");
const loading = document.getElementById("loading");
const hintEl  = document.getElementById("hint");
const chips = {
  light:{ box:document.getElementById("chip-light"), val:document.getElementById("val-light") },
  pose: { box:document.getElementById("chip-pose"),  val:document.getElementById("val-pose")  },
  pos:  { box:document.getElementById("chip-pos"),   val:document.getElementById("val-pos")   },
};
function setChip(c, state, text){ c.box.classList.remove("good","warn","bad"); c.box.classList.add(state); c.val.textContent = text; }

const sample = document.createElement("canvas"); sample.width=80; sample.height=80;
const sctx = sample.getContext("2d", { willReadFrequently:true });

let landmarker, lastVideoTime=-1, goodStreak=0, captured=false;

async function init(){
  const fileset = await FilesetResolver.forVisionTasks(LOCAL_WASM_PATH);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions:{ modelAssetPath: LOCAL_MODEL_PATH, delegate:"GPU" },
    runningMode:"VIDEO", numFaces:1, outputFacialTransformationMatrixes:true,
  });
  const stream = await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:"user", width:{ideal:720}, height:{ideal:960} }, audio:false });
  video.srcObject = stream; await video.play();
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  loading.style.display = "none";
  requestAnimationFrame(loop);
}

function eulerFromMatrix(m){ // 4x4 column-major -> degrees
  const r00=m[0], r10=m[1], r20=m[2], r21=m[6], r22=m[10];
  const pitch=Math.atan2(r21,r22), yaw=Math.atan2(-r20,Math.hypot(r21,r22)), roll=Math.atan2(r10,r00);
  const d=180/Math.PI; return { pitch:pitch*d, yaw:yaw*d, roll:roll*d };
}
function faceBox(lm){
  let minX=1,minY=1,maxX=0,maxY=0;
  for(const p of lm){ if(p.x<minX)minX=p.x; if(p.y<minY)minY=p.y; if(p.x>maxX)maxX=p.x; if(p.y>maxY)maxY=p.y; }
  return { minX,minY,maxX,maxY, w:maxX-minX, h:maxY-minY, cx:(minX+maxX)/2, cy:(minY+maxY)/2 };
}
function brightnessOf(box){
  const sx=box.minX*video.videoWidth, sy=box.minY*video.videoHeight;
  const sw=Math.max(1,box.w*video.videoWidth), sh=Math.max(1,box.h*video.videoHeight);
  sctx.drawImage(video, sx,sy,sw,sh, 0,0, sample.width, sample.height);
  const { data } = sctx.getImageData(0,0,sample.width,sample.height);
  let sum=0; for(let i=0;i<data.length;i+=4) sum += 0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];
  return sum/(data.length/4);
}
function drawGuide(allGood){
  octx.clearRect(0,0,overlay.width,overlay.height);
  const cx=overlay.width/2, cy=overlay.height*0.46, r=overlay.width*0.36;
  octx.lineWidth=4; octx.strokeStyle = allGood ? "#16a34a" : "rgba(255,255,255,.9)";
  octx.beginPath(); octx.ellipse(cx,cy,r,r*1.18,0,0,Math.PI*2); octx.stroke();
}

function loop(){
  if(!captured && video.currentTime !== lastVideoTime){
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    if(!res.faceLandmarks || res.faceLandmarks.length===0){
      setChip(chips.light,"warn","—"); setChip(chips.pose,"bad","No Face"); setChip(chips.pos,"bad","No Face");
      hintEl.textContent = "Position your face in the circle"; drawGuide(false);
    } else {
      const lm=res.faceLandmarks[0], box=faceBox(lm);

      // Lighting
      const b=brightnessOf(box); let lightGood;
      if(b>=CFG.lightGoodMin && b<=CFG.lightGoodMax){ setChip(chips.light,"good","Good"); lightGood=true; }
      else if(b>=CFG.lightOkMin && b<=CFG.lightOkMax){ setChip(chips.light,"warn","Ok"); lightGood=true; }
      else if(b<CFG.lightOkMin){ setChip(chips.light,"bad","Too Dark"); lightGood=false; }
      else { setChip(chips.light,"bad","Too Bright"); lightGood=false; }

      // Look Straight
      let poseGood=false; const mat=res.facialTransformationMatrixes?.[0]?.data;
      if(mat){
        const {yaw,pitch,roll}=eulerFromMatrix(mat);
        const worst=Math.max(Math.abs(yaw),Math.abs(pitch),Math.abs(roll));
        if(worst<=CFG.poseGood){ setChip(chips.pose,"good","Good"); poseGood=true; }
        else if(worst<=CFG.poseOk){ setChip(chips.pose,"warn","Almost"); }
        else { setChip(chips.pose,"bad","Look Straight"); }
      }

      // Face Position
      const offX=Math.abs(box.cx-0.5), offY=Math.abs(box.cy-0.46);
      let posGood=false, posMsg="Good", posState="good";
      if(box.w<CFG.sizeGoodMin){ posMsg="Come Closer"; posState="bad"; }
      else if(box.w>CFG.sizeGoodMax){ posMsg="Move Back"; posState="bad"; }
      else if(offX>CFG.centerTol || offY>CFG.centerTol){ posMsg="Center Face"; posState="warn"; }
      else { posGood=true; }
      setChip(chips.pos, posState, posMsg);

      const allGood = lightGood && poseGood && posGood;
      drawGuide(allGood);
      hintEl.textContent = allGood ? "Hold still…" : posState==="bad" ? posMsg : !poseGood ? "Look straight at the camera" : "";
      goodStreak = allGood ? goodStreak+1 : 0;
      if(goodStreak>=CFG.captureHold) capture();
    }
  }
  if(!captured) requestAnimationFrame(loop);
}

function capture(){
  captured=true;
  const c=document.createElement("canvas"); c.width=video.videoWidth; c.height=video.videoHeight;
  const cx=c.getContext("2d"); cx.translate(c.width,0); cx.scale(-1,1); cx.drawImage(video,0,0);
  const dataUrl=c.toDataURL("image/jpeg",0.92);
  document.getElementById("shot-img").src=dataUrl;
  document.getElementById("shot").style.display="block";
  // TODO: POST dataUrl (or use c.toBlob) to your server here.
}
document.getElementById("retake").onclick=()=>{ captured=false; goodStreak=0;
  document.getElementById("shot").style.display="none"; requestAnimationFrame(loop); };

init().catch(err=>{ loading.textContent="Camera / model error: "+err.message; console.error(err); });
</script>
```

## Implementation checklist (for the agent)

1. Serve the page over HTTPS or localhost.
2. `npm i @mediapipe/tasks-vision`; copy `node_modules/@mediapipe/tasks-vision/wasm`
   into the static folder and place `face_landmarker.task` there too (no CDN).
3. Set `LOCAL_WASM_PATH` and `LOCAL_MODEL_PATH` to those served paths.
4. Add the markup, styles, and module script into the target framework.
5. Wire `capture()` to the app's upload/next-step (data URL or Blob).
6. Tune the `CFG` thresholds to the circle guide's size and position.
7. Handle camera-permission denial with a visible fallback message.
8. If used for identity verification, add a separate liveness/anti-spoofing step
   and disclose that framing checks are not liveness.