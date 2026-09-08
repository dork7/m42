/*
 * Standalone guided face capture — vanilla JS port of the m42 PhotoScreen flow.
 *
 * Same five checks as the app (lighting, head pose, face position, glasses,
 * mask/occlusion), same tunables (CFG), auto-capture after a hold, preview +
 * retake.
 *
 * Runs straight from file:// — open index.html in a browser, no server needed.
 * getUserMedia works on file:// (a secure context) in Chrome, Safari and
 * Firefox. MediaPipe (runtime + WASM + model) is pulled from a CDN, so the page
 * needs an internet connection but no build step and no local assets.
 *
 * index.html loads the ESM runtime from the CDN in an inline module and hands it
 * to us on window.__mpVision, then injects this file as a classic script (an
 * external `<script type="module">` is CORS-blocked on file://, a classic one
 * isn't).
 */
;(function () {
const { FaceLandmarker, FilesetResolver } = window.__mpVision

// jsdelivr serves these with `Access-Control-Allow-Origin: *`, so a file:// page
// (null origin) can fetch them; the model bucket is CORS-enabled too.
const MP_VERSION = '1.0.1'
const WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// ---------------------------------------------------------------------------
// Tunables — copied verbatim from src/lib/faceGuide.ts (CFG)
// ---------------------------------------------------------------------------
const CFG = {
  // Lighting: mean luma (0–255) of the face region.
  lightGoodMin: 100,
  lightGoodMax: 150,
  lightOkMin: 55,
  lightOkMax: 222,

  // Head pose: |angle| in degrees from the 4x4 transform matrix.
  poseYawGood: 14,
  poseYawOk: 22,
  posePitchGood: 18,
  posePitchOk: 28,
  poseRollGood: 12,
  poseRollOk: 20,

  // Face position, in VISIBLE-frame fractions.
  sizeGoodMin: 0.44,
  sizeGoodMax: 0.64,
  centerTolX: 0.12,
  centerTolY: 0.12,
  centerTargetY: 0.5,

  captureHold: 16, // consecutive all-good detections before capture

  // Glasses heuristics.
  glassEyeDarkRatio: 0.62,
  glassGlareFrac: 0.1,
  glassBridgeDarkRatio: 0.6,
  glassBridgeContrast: 30,
  glassTempleDarkRatio: 0.55,
  glassSoftSignalsToTrip: 2,
  sunglassLumRatio: 0.45,

  // Mask heuristics.
  maskBrightDelta: 24,
  maskBlueShiftMin: 0.015,
  maskRedDropMin: 0.022,
  maskColorDelta: 20,
  maskLipRednessRatio: 0.88,

  // Partial-occlusion heuristics.
  occlusionMinFaceW: 0.14,
  occlusionColorDelta: 38,
  occlusionFlatMax: 15,
  occlusionStdRatio: 0.5,
  occlusionLumDelta: 28,
  occlusionStdRatioLoose: 0.72,

  coverageMinSkinLum: 40,
  coverageConfirmFrames: 3,

  sharpnessMin: 5,
}

// Aspect ratio the preview is shown at (object-cover in a 3:4 box).
const DISPLAY_ASPECT = 3 / 4

// MediaPipe canonical 478-point face-mesh indices, grouped into sampling regions.
const COVERAGE_REGIONS = {
  eyeBand: [33, 263, 70, 300, 145, 374, 168],
  noseBridge: [168, 6, 197, 195, 8],
  rightTemple: [33, 234, 127, 116],
  leftTemple: [263, 454, 356, 345],
  rightCheek: [50, 101, 205, 207, 187],
  leftCheek: [280, 330, 425, 427, 411],
  forehead: [10, 151, 9, 107, 336],
  lowerFace: [2, 164, 0, 13, 14, 17, 18, 200, 199, 152, 212, 432],
  lips: [13, 14, 0, 17, 61, 291],
}

// ---------------------------------------------------------------------------
// Detection setup
// ---------------------------------------------------------------------------
let videoLandmarker = null
let initPromise = null

async function createLandmarker(delegate) {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFacialTransformationMatrixes: true,
  })
}

function initFaceDetection() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        videoLandmarker = await createLandmarker('GPU')
      } catch {
        videoLandmarker = await createLandmarker('CPU')
      }
    })()
  }
  return initPromise
}

const EMPTY_RESULT = {
  faceLandmarks: [],
  faceBlendshapes: [],
  facialTransformationMatrixes: [],
}

function detectFaceInVideo(video, timestamp) {
  if (!videoLandmarker || video.videoWidth === 0 || video.videoHeight === 0) {
    return EMPTY_RESULT
  }
  try {
    return videoLandmarker.detectForVideo(video, timestamp)
  } catch {
    return EMPTY_RESULT
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function faceBoxFromLandmarks(landmarks) {
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX,
    h: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

// Remap a face box from full-camera-frame coords into what's actually visible
// on screen (object-cover crop inside a DISPLAY_ASPECT box).
function toDisplayBox(box, sourceW, sourceH, displayAspect = DISPLAY_ASPECT) {
  let { minX, minY, maxX, maxY } = box
  const sourceAspect = sourceW / sourceH

  if (sourceAspect > displayAspect) {
    const visible = displayAspect / sourceAspect
    const off = (1 - visible) / 2
    minX = (minX - off) / visible
    maxX = (maxX - off) / visible
  } else if (sourceAspect < displayAspect) {
    const visible = sourceAspect / displayAspect
    const off = (1 - visible) / 2
    minY = (minY - off) / visible
    maxY = (maxY - off) / visible
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX,
    h: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

// 4x4 column-major transform matrix -> yaw/pitch/roll in degrees.
function eulerFromMatrix(m) {
  const r00 = m[0]
  const r10 = m[1]
  const r20 = m[2]
  const r21 = m[6]
  const r22 = m[10]
  const d = 180 / Math.PI
  return {
    pitch: Math.atan2(r21, r22) * d,
    yaw: Math.atan2(-r20, Math.hypot(r21, r22)) * d,
    roll: Math.atan2(r10, r00) * d,
  }
}

// ---------------------------------------------------------------------------
// Pixel sampling
// ---------------------------------------------------------------------------
function createSampleCanvasCtx() {
  const canvas = document.createElement('canvas')
  canvas.width = 80
  canvas.height = 80
  return canvas.getContext('2d', { willReadFrequently: true })
}

function sampleFaceBrightness(source, sourceW, sourceH, box, sampleCtx) {
  const { canvas } = sampleCtx
  const sx = Math.max(0, box.minX * sourceW)
  const sy = Math.max(0, box.minY * sourceH)
  const sw = Math.max(1, box.w * sourceW)
  const sh = Math.max(1, box.h * sourceH)
  sampleCtx.clearRect(0, 0, canvas.width, canvas.height)
  sampleCtx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  const { data } = sampleCtx.getImageData(0, 0, canvas.width, canvas.height)
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  return sum / (data.length / 4)
}

function sampleFaceSharpness(source, sourceW, sourceH, box, sampleCtx) {
  const { canvas } = sampleCtx
  const w = canvas.width
  const h = canvas.height
  const sx = Math.max(0, box.minX * sourceW)
  const sy = Math.max(0, box.minY * sourceH)
  const sw = Math.max(1, box.w * sourceW)
  const sh = Math.max(1, box.h * sourceH)
  sampleCtx.clearRect(0, 0, w, h)
  sampleCtx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h)
  const { data } = sampleCtx.getImageData(0, 0, w, h)

  const lumAt = (i) =>
    0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]

  let sum = 0
  let count = 0
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = (y * w + x) * 4
      const gx = lumAt(i + 4) - lumAt(i - 4)
      const gy = lumAt(i + w * 4) - lumAt(i - w * 4)
      sum += Math.abs(gx) + Math.abs(gy)
      count += 1
    }
  }
  return count ? sum / count : 0
}

function statsFromImageData(data) {
  const n = data.length / 4
  let sumL = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  const lums = new Float64Array(n)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    lums[j] = l
    sumL += l
    sumR += data[i]
    sumG += data[i + 1]
    sumB += data[i + 2]
  }
  const meanL = sumL / n
  let variance = 0
  let bright = 0
  for (let j = 0; j < n; j += 1) {
    variance += (lums[j] - meanL) ** 2
    if (lums[j] > 235) bright += 1
  }
  return {
    lum: meanL,
    stdDev: Math.sqrt(variance / n),
    r: sumR / n,
    g: sumG / n,
    b: sumB / n,
    brightFrac: bright / n,
  }
}

function sampleNormRect(source, sourceW, sourceH, nx, ny, nw, nh, sampleCtx) {
  const sx = Math.min(sourceW - 1, Math.max(0, nx * sourceW))
  const sy = Math.min(sourceH - 1, Math.max(0, ny * sourceH))
  const sw = Math.min(sourceW - sx, Math.max(1, nw * sourceW))
  const sh = Math.min(sourceH - sy, Math.max(1, nh * sourceH))
  if (sw < 4 || sh < 4) return null
  const { canvas } = sampleCtx
  sampleCtx.clearRect(0, 0, canvas.width, canvas.height)
  sampleCtx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return statsFromImageData(
    sampleCtx.getImageData(0, 0, canvas.width, canvas.height).data,
  )
}

function sampleRegionStats(source, sourceW, sourceH, landmarks, indices, sampleCtx) {
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const i of indices) {
    const p = landmarks[i]
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const padX = Math.max(0.006, (maxX - minX) * 0.15)
  const padY = Math.max(0.006, (maxY - minY) * 0.15)
  const sx = Math.max(0, (minX - padX) * sourceW)
  const sy = Math.max(0, (minY - padY) * sourceH)
  const sw = Math.max(1, (maxX - minX + padX * 2) * sourceW)
  const sh = Math.max(1, (maxY - minY + padY * 2) * sourceH)
  if (sw < 2 || sh < 2) return null

  const { canvas } = sampleCtx
  sampleCtx.clearRect(0, 0, canvas.width, canvas.height)
  sampleCtx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return statsFromImageData(
    sampleCtx.getImageData(0, 0, canvas.width, canvas.height).data,
  )
}

function chromaticity(c) {
  const sum = c.r + c.g + c.b + 1
  return { r: c.r / sum, b: c.b / sum }
}

function rgbDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------
const UNKNOWN_COVERAGE = { level: 'warn', label: '—', ok: true, kind: 'unknown' }
const GLASSES_RESULT = { level: 'bad', label: 'Remove Glasses', ok: false, kind: 'glasses' }
const MASK_RESULT = { level: 'bad', label: 'Uncover Face', ok: false, kind: 'mask' }
const OCCLUSION_RESULT = { level: 'bad', label: 'Uncover Face', ok: false, kind: 'occluded' }
const CLEAR_RESULT = { level: 'good', label: 'Good', ok: true, kind: 'clear' }

function evaluateCoverage(landmarks, source, sourceW, sourceH, sampleCtx) {
  const stat = (indices) =>
    sampleRegionStats(source, sourceW, sourceH, landmarks, indices, sampleCtx)

  const rightCheek = stat(COVERAGE_REGIONS.rightCheek)
  const leftCheek = stat(COVERAGE_REGIONS.leftCheek)
  const forehead = stat(COVERAGE_REGIONS.forehead)
  const cheeks = [rightCheek, leftCheek].filter(Boolean)
  const skinRefs = [...cheeks, forehead].filter(Boolean)
  if (cheeks.length === 0 || skinRefs.length === 0 || !forehead) {
    return UNKNOWN_COVERAGE
  }

  const skinLum = skinRefs.reduce((s, x) => s + x.lum, 0) / skinRefs.length
  if (skinLum < CFG.coverageMinSkinLum) return UNKNOWN_COVERAGE

  const cheekLum = cheeks.reduce((s, x) => s + x.lum, 0) / cheeks.length
  const cheekRGB = {
    r: cheeks.reduce((s, x) => s + x.r, 0) / cheeks.length,
    g: cheeks.reduce((s, x) => s + x.g, 0) / cheeks.length,
    b: cheeks.reduce((s, x) => s + x.b, 0) / cheeks.length,
  }

  const eyeBand = stat(COVERAGE_REGIONS.eyeBand)
  const noseBridge = stat(COVERAGE_REGIONS.noseBridge)
  const rTemple = stat(COVERAGE_REGIONS.rightTemple)
  const lTemple = stat(COVERAGE_REGIONS.leftTemple)
  const templeMinLum = Math.min(
    rTemple?.lum ?? Infinity,
    lTemple?.lum ?? Infinity,
  )

  const sigTinted = !!eyeBand && eyeBand.lum < skinLum * CFG.sunglassLumRatio
  const softGlass = [
    !!eyeBand && eyeBand.lum < skinLum * CFG.glassEyeDarkRatio,
    !!eyeBand && eyeBand.brightFrac > CFG.glassGlareFrac,
    !!noseBridge && noseBridge.lum < cheekLum * CFG.glassBridgeDarkRatio,
    !!noseBridge &&
      noseBridge.stdDev > Math.max(CFG.glassBridgeContrast, forehead.stdDev * 2),
    templeMinLum < cheekLum * CFG.glassTempleDarkRatio,
  ]
  const softGlassCount = softGlass.filter(Boolean).length
  const glasses = sigTinted || softGlassCount >= CFG.glassSoftSignalsToTrip

  const lowerFace = stat(COVERAGE_REGIONS.lowerFace)
  const lips = stat(COVERAGE_REGIONS.lips)

  const maskColor = lowerFace ? rgbDistance(lowerFace, cheekRGB) : 0
  const lowerChroma = lowerFace ? chromaticity(lowerFace) : null
  const cheekChroma = chromaticity(cheekRGB)
  const blueShift = lowerChroma ? lowerChroma.b - cheekChroma.b : 0
  const redDrop = lowerChroma ? cheekChroma.r - lowerChroma.r : 0

  const sigBrighter = !!lowerFace && lowerFace.lum > cheekLum + CFG.maskBrightDelta
  const sigUnskinlike =
    blueShift > CFG.maskBlueShiftMin || redDrop > CFG.maskRedDropMin
  const notBeard = sigBrighter || sigUnskinlike

  const sigColourBreak = maskColor > CFG.maskColorDelta
  const cheekRedness = cheekRGB.r / (cheekRGB.g + 1)
  const lipRedness = lips ? lips.r / (lips.g + 1) : Infinity
  const sigLipsHidden =
    !!lips && lipRedness < cheekRedness * CFG.maskLipRednessRatio

  const mask = !!lowerFace && notBeard && (sigColourBreak || sigLipsHidden)

  const rawBox = faceBoxFromLandmarks(landmarks)
  const bandY = rawBox.minY + rawBox.h * 0.16
  const bandH = rawBox.h * 0.54
  const halfW = rawBox.w * 0.38
  const leftHalf =
    rawBox.w >= CFG.occlusionMinFaceW
      ? sampleNormRect(source, sourceW, sourceH, rawBox.minX + rawBox.w * 0.06, bandY, halfW, bandH, sampleCtx)
      : null
  const rightHalf =
    rawBox.w >= CFG.occlusionMinFaceW
      ? sampleNormRect(source, sourceW, sourceH, rawBox.minX + rawBox.w * 0.56, bandY, halfW, bandH, sampleCtx)
      : null

  let occluded = false
  if (leftHalf && rightHalf) {
    const symColor = rgbDistance(leftHalf, rightHalf)
    const symLum = Math.abs(leftHalf.lum - rightHalf.lum)
    const lo = Math.min(leftHalf.stdDev, rightHalf.stdDev)
    const hi = Math.max(leftHalf.stdDev, rightHalf.stdDev, 1)
    const symStdRatio = lo / hi
    occluded =
      symColor > CFG.occlusionColorDelta ||
      (lo < CFG.occlusionFlatMax && symStdRatio < CFG.occlusionStdRatio) ||
      (symLum > CFG.occlusionLumDelta && symStdRatio < CFG.occlusionStdRatioLoose)
  }

  if (glasses) return GLASSES_RESULT
  if (mask) return MASK_RESULT
  if (occluded) return OCCLUSION_RESULT
  return CLEAR_RESULT
}

function evaluateLight(brightness) {
  if (brightness >= CFG.lightGoodMin && brightness <= CFG.lightGoodMax) {
    return { level: 'good', label: 'Good', ok: true }
  }
  if (brightness >= CFG.lightOkMin && brightness <= CFG.lightOkMax) {
    return { level: 'warn', label: 'Ok', ok: true }
  }
  if (brightness < CFG.lightOkMin) {
    return { level: 'bad', label: 'Too Dark', ok: false }
  }
  return { level: 'bad', label: 'Too Bright', ok: false }
}

function evaluatePose(matrix) {
  if (!matrix) return { level: 'bad', label: 'Look Straight', ok: false }
  const { yaw, pitch, roll } = eulerFromMatrix(matrix)
  const ay = Math.abs(yaw)
  const ap = Math.abs(pitch)
  const ar = Math.abs(roll)

  if (ay <= CFG.poseYawGood && ap <= CFG.posePitchGood && ar <= CFG.poseRollGood) {
    return { level: 'good', label: 'Good', ok: true }
  }
  if (ay <= CFG.poseYawOk && ap <= CFG.posePitchOk && ar <= CFG.poseRollOk) {
    return { level: 'warn', label: 'Almost', ok: false }
  }
  return { level: 'bad', label: 'Look Straight', ok: false }
}

function evaluatePosition(box) {
  if (box.w < CFG.sizeGoodMin) {
    return { check: { level: 'bad', label: 'Come Closer' }, ok: false, status: 'too_far' }
  }
  if (box.w > CFG.sizeGoodMax) {
    return { check: { level: 'bad', label: 'Move Back' }, ok: false, status: 'too_close' }
  }
  const offX = Math.abs(box.cx - 0.5)
  const offY = Math.abs(box.cy - CFG.centerTargetY)
  if (offX > CFG.centerTolX || offY > CFG.centerTolY) {
    return { check: { level: 'warn', label: 'Center Face' }, ok: false, status: 'off_center' }
  }
  return { check: { level: 'good', label: 'Good' }, ok: true, status: 'valid' }
}

const POSITION_MESSAGES = {
  no_face: 'Position your face in the frame',
  covered: 'Uncover your face',
  blurry: 'Photo looks blurry — hold steady and retake',
  too_far: 'Move a little closer',
  too_close: 'Move back a little',
  off_center: 'Center your face in the frame',
  valid: 'Looks good',
}

const COVERAGE_MESSAGES = {
  clear: '',
  glasses: 'Take off your glasses',
  mask: 'Take off your face mask',
  occluded: 'Keep your whole face visible',
  unknown: 'Uncover your face',
}

const NO_FACE = {
  faceFound: false,
  light: { level: 'warn', label: '—' },
  pose: { level: 'bad', label: 'No Face' },
  position: { level: 'bad', label: 'No Face' },
  coverage: { level: 'bad', label: 'No Face' },
  status: 'no_face',
  allGood: false,
  message: 'Position your face in the frame',
}

function evaluateFace(result, brightness, coverage = UNKNOWN_COVERAGE, frame, sharpness = null) {
  const landmarks = result.faceLandmarks?.[0]
  if (!landmarks || landmarks.length === 0) return NO_FACE

  const rawBox = faceBoxFromLandmarks(landmarks)
  const box =
    frame && frame.w > 0 && frame.h > 0
      ? toDisplayBox(rawBox, frame.w, frame.h)
      : rawBox
  const matrix = result.facialTransformationMatrixes?.[0]?.data ?? null

  const light =
    brightness === null
      ? { level: 'warn', label: 'Ok', ok: true }
      : evaluateLight(brightness)
  const pose = evaluatePose(matrix ? Array.from(matrix) : null)
  const position = evaluatePosition(box)

  const blurry = sharpness !== null && sharpness < CFG.sharpnessMin
  const allGood = light.ok && pose.ok && position.ok && coverage.ok && !blurry

  let message
  if (allGood) {
    message = 'Hold still…'
  } else if (!coverage.ok) {
    message = COVERAGE_MESSAGES[coverage.kind] || POSITION_MESSAGES.covered
  } else if (blurry) {
    message = POSITION_MESSAGES.blurry
  } else if (!position.ok && position.status !== 'valid') {
    message = POSITION_MESSAGES[position.status]
  } else if (!pose.ok) {
    message = 'Look straight at the camera'
  } else {
    message = light.label === 'Too Dark' ? 'Find brighter light' : 'Reduce the glare'
  }

  const status = allGood
    ? 'valid'
    : !coverage.ok
      ? 'covered'
      : blurry
        ? 'blurry'
        : position.status

  return {
    faceFound: true,
    light: { level: light.level, label: light.label },
    pose: { level: pose.level, label: pose.label },
    position: position.check,
    coverage: { level: coverage.level, label: coverage.label },
    status,
    allGood,
    message,
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id)

const els = {
  choose: $('screen-choose'),
  camera: $('screen-camera'),
  preview: $('screen-preview'),
  startBtn: $('start-btn'),
  video: $('video'),
  captureCanvas: $('capture-canvas'),
  guide: $('guide'),
  message: $('message'),
  takeBtn: $('take-btn'),
  cancelBtn: $('cancel-btn'),
  chips: {
    light: $('chip-light'),
    pose: $('chip-pose'),
    position: $('chip-position'),
    coverage: $('chip-coverage'),
  },
  photo: $('photo'),
  previewMessage: $('preview-message'),
  retakeBtn: $('retake-btn'),
  cameraError: $('camera-error'),
  autoCapture: $('opt-autocapture'),
  guideShape: $('opt-guideshape'),
  coverageEnabled: $('opt-coverage'),
}

const state = {
  mode: 'choose',
  stream: null,
  raf: null,
  lastDetect: 0,
  captured: false,
  goodStreak: 0,
  sampleCtx: createSampleCanvasCtx(),
  // debounced coverage flip
  coverageStable: UNKNOWN_COVERAGE,
  coveragePending: { ok: UNKNOWN_COVERAGE.ok, count: 0 },
  lastSignature: '',
}

function opt(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

let autoCapture = opt('photoAutoCapture', '0') === '1'
let guideShape = opt('photoGuideShape', 'rectangle') === 'oval' ? 'oval' : 'rectangle'
let coverageEnabled = opt('photoCoverageEnabled', '1') !== '0'

function persist(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function resetCoverage() {
  state.coverageStable = UNKNOWN_COVERAGE
  state.coveragePending = { ok: UNKNOWN_COVERAGE.ok, count: 0 }
}

// Debounce the covered / not-covered flip so a single noisy frame doesn't
// flicker the chip. A change of covering *type* while covered is adopted
// immediately.
function confirmCoverage(raw) {
  const stable = state.coverageStable
  if (raw.ok === stable.ok) {
    state.coverageStable = raw
    state.coveragePending.count = 0
    return raw
  }
  const pending = state.coveragePending
  pending.count = pending.ok === raw.ok ? pending.count + 1 : 1
  pending.ok = raw.ok
  if (pending.count >= CFG.coverageConfirmFrames) {
    state.coverageStable = raw
    pending.count = 0
  }
  return state.coverageStable
}

function setChip(el, title, check) {
  el.querySelector('.chip-title').textContent = title
  el.querySelector('.chip-label').textContent = check.label
  el.dataset.level = check.level
}

function renderChips(faceEval) {
  setChip(els.chips.light, 'Lighting', faceEval.light)
  setChip(els.chips.pose, 'Look Straight', faceEval.pose)
  setChip(els.chips.position, 'Face Position', faceEval.position)
  if (coverageEnabled) {
    els.chips.coverage.hidden = false
    els.chips.position.classList.remove('span-2')
    setChip(els.chips.coverage, 'Face Clear', faceEval.coverage)
  } else {
    els.chips.coverage.hidden = true
    els.chips.position.classList.add('span-2')
  }
}

function renderGuide(valid) {
  els.guide.dataset.shape = guideShape
  els.guide.dataset.valid = String(valid)
}

function showScreen(mode) {
  state.mode = mode
  els.choose.hidden = mode !== 'choose'
  els.camera.hidden = mode !== 'camera'
  els.preview.hidden = mode !== 'preview'
}

function resetTracking() {
  state.captured = false
  state.goodStreak = 0
  state.lastSignature = ''
  resetCoverage()
}

function stopCamera() {
  if (state.raf !== null) {
    cancelAnimationFrame(state.raf)
    state.raf = null
  }
  state.stream?.getTracks().forEach((t) => t.stop())
  state.stream = null
  els.video.srcObject = null
}

async function requestCameraStream() {
  const portrait = {
    video: {
      facingMode: 'user',
      width: { ideal: 960 },
      height: { ideal: 1280 },
      aspectRatio: { ideal: 3 / 4 },
    },
    audio: false,
  }
  try {
    return await navigator.mediaDevices.getUserMedia(portrait)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
    }
    throw err
  }
}

function captureFromVideo() {
  if (state.captured) return
  const video = els.video
  const canvas = els.captureCanvas
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return

  state.captured = true
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  // Un-mirror so the saved image matches real orientation (the live preview is
  // mirrored via CSS for a natural selfie view).
  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, w, h)
  ctx.restore()

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
  stopCamera()
  els.photo.src = dataUrl
  showScreen('preview')
  validateStill(dataUrl)
}

function tick(timestamp) {
  const video = els.video
  if (!video || video.videoWidth === 0 || state.captured) {
    if (!state.captured) state.raf = requestAnimationFrame(tick)
    return
  }

  if (timestamp - state.lastDetect >= 90) {
    state.lastDetect = timestamp

    const result = detectFaceInVideo(video, performance.now())
    const landmarks = result.faceLandmarks?.[0]
    let brightness = null
    let coverage = UNKNOWN_COVERAGE

    if (landmarks && landmarks.length > 0) {
      const box = faceBoxFromLandmarks(landmarks)
      try {
        brightness = sampleFaceBrightness(
          video,
          video.videoWidth,
          video.videoHeight,
          box,
          state.sampleCtx,
        )
      } catch {
        brightness = null
      }
      try {
        coverage = coverageEnabled
          ? confirmCoverage(
              evaluateCoverage(
                landmarks,
                video,
                video.videoWidth,
                video.videoHeight,
                state.sampleCtx,
              ),
            )
          : UNKNOWN_COVERAGE
      } catch {
        /* ignore */
      }
    } else {
      resetCoverage()
    }

    const next = evaluateFace(result, brightness, coverage, {
      w: video.videoWidth,
      h: video.videoHeight,
    })

    const signature = `${next.status}|${next.light.label}|${next.pose.label}|${next.position.label}|${next.coverage.label}`
    if (signature !== state.lastSignature) {
      state.lastSignature = signature
      renderChips(next)
      renderGuide(next.allGood)
      els.message.textContent = next.message
      els.message.dataset.ok = String(next.allGood)
      els.takeBtn.disabled = !next.allGood
      els.takeBtn.textContent = next.allGood
        ? 'Take the photo'
        : autoCapture
          ? 'Auto-capturing when ready'
          : 'Line up the checks first'
    }

    // Auto-capture (opt-in): fire once every check has held for captureHold
    // consecutive detections. Any failing check resets the streak.
    state.goodStreak = next.allGood ? state.goodStreak + 1 : 0
    if (autoCapture && state.goodStreak >= CFG.captureHold && !state.captured) {
      captureFromVideo()
      return
    }
  }

  state.raf = requestAnimationFrame(tick)
}

async function validateStill(dataUrl) {
  els.previewMessage.textContent = 'Checking your photo…'
  els.previewMessage.dataset.state = 'checking'
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('load failed'))
      i.src = dataUrl
    })
    await ensureImageLandmarker()
    const stillResult = safeDetectImage(img)
    const landmarks = stillResult.faceLandmarks?.[0]
    let brightness = null
    let sharpness = null
    let coverage = UNKNOWN_COVERAGE
    if (landmarks && landmarks.length > 0) {
      const box = faceBoxFromLandmarks(landmarks)
      brightness = sampleFaceBrightness(img, img.naturalWidth, img.naturalHeight, box, state.sampleCtx)
      sharpness = sampleFaceSharpness(img, img.naturalWidth, img.naturalHeight, box, state.sampleCtx)
      if (coverageEnabled) {
        coverage = evaluateCoverage(landmarks, img, img.naturalWidth, img.naturalHeight, state.sampleCtx)
      }
    }
    const faceEval = evaluateFace(
      stillResult,
      brightness,
      coverage,
      { w: img.naturalWidth, h: img.naturalHeight },
      sharpness,
    )
    els.previewMessage.textContent = faceEval.allGood
      ? faceEval.message
      : faceEval.faceFound
        ? `This photo isn't clear enough — ${faceEval.message}`
        : "We can't see your face clearly. Try again."
    els.previewMessage.dataset.state = faceEval.allGood ? 'ok' : 'bad'
  } catch {
    els.previewMessage.textContent = 'Could not check the photo. Retake and try again.'
    els.previewMessage.dataset.state = 'bad'
  }
}

// A separate IMAGE-mode landmarker for validating the captured still.
let imageLandmarker = null
let imageLandmarkerPromise = null
async function ensureImageLandmarker() {
  if (imageLandmarker) return imageLandmarker
  if (!imageLandmarkerPromise) {
    imageLandmarkerPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
      const make = (delegate) =>
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate },
          runningMode: 'IMAGE',
          numFaces: 1,
          outputFacialTransformationMatrixes: true,
        })
      try {
        return await make('GPU')
      } catch {
        return make('CPU')
      }
    })()
  }
  imageLandmarker = await imageLandmarkerPromise
  return imageLandmarker
}

function safeDetectImage(source) {
  try {
    return imageLandmarker ? imageLandmarker.detect(source) : EMPTY_RESULT
  } catch {
    return EMPTY_RESULT
  }
}

async function startCamera() {
  stopCamera()
  els.cameraError.hidden = true
  resetTracking()
  showScreen('camera')
  els.message.textContent = 'Loading face detection…'

  try {
    await initFaceDetection()
    ensureImageLandmarker().catch(() => {})
    const stream = await requestCameraStream()
    state.stream = stream
    els.video.srcObject = stream
    await els.video.play()
    renderGuide(false)
    state.raf = requestAnimationFrame(tick)
  } catch (err) {
    console.error(err)
    els.cameraError.textContent =
      'Camera access is unavailable. Grant permission and reload.'
    els.cameraError.hidden = false
    showScreen('choose')
  }
}

// --- events ---
els.startBtn.addEventListener('click', startCamera)
els.takeBtn.addEventListener('click', captureFromVideo)
els.cancelBtn.addEventListener('click', () => {
  stopCamera()
  resetTracking()
  showScreen('choose')
})
els.retakeBtn.addEventListener('click', () => {
  els.photo.removeAttribute('src')
  resetTracking()
  showScreen('choose')
})

els.autoCapture.checked = autoCapture
els.autoCapture.addEventListener('change', () => {
  autoCapture = els.autoCapture.checked
  state.goodStreak = 0
  persist('photoAutoCapture', autoCapture ? '1' : '0')
})

els.guideShape.checked = guideShape === 'oval'
els.guideShape.addEventListener('change', () => {
  guideShape = els.guideShape.checked ? 'oval' : 'rectangle'
  persist('photoGuideShape', guideShape)
  renderGuide(els.guide.dataset.valid === 'true')
})

els.coverageEnabled.checked = coverageEnabled
els.coverageEnabled.addEventListener('change', () => {
  coverageEnabled = els.coverageEnabled.checked
  resetCoverage()
  persist('photoCoverageEnabled', coverageEnabled ? '1' : '0')
})

// Warm up the model in the background so the first "Take a photo" is fast.
initFaceDetection().catch((err) => {
  console.error('Face detection failed to load', err)
  els.cameraError.textContent =
    'Face detection could not load. Check your connection and reload.'
  els.cameraError.hidden = false
})
})()
