/*
 * React port of face-capture/face-capture.js — the standalone guided face
 * capture + live skin-map controller. Same logic; mounted from FaceApp.tsx
 * against a DOM subtree carrying the same element ids.
 */
// @ts-nocheck
/* eslint-disable */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import * as SkinMetrics from './skinMetrics'

// Self-hosted MediaPipe assets (same as src/lib/faceDetection.ts).
const WASM_PATH = `${import.meta.env.BASE_URL}vendor/mediapipe/wasm`
const MODEL_PATH = `${import.meta.env.BASE_URL}models/face_landmarker.task`

export function mountFaceApp() {
const teardown = []
const addDoc = (ev, fn) => { document.addEventListener(ev, fn); teardown.push(() => document.removeEventListener(ev, fn)) }
const addWin = (ev, fn) => { window.addEventListener(ev, fn); teardown.push(() => window.removeEventListener(ev, fn)) }

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

// Shared across the VIDEO and IMAGE landmarkers so the WASM fileset (and its
// feature detection: SIMD vs no-SIMD — the latter is what runs on iOS < 16.4)
// is resolved only once.
let visionPromise = null
function getVision() {
  if (!visionPromise) {
    visionPromise = FilesetResolver.forVisionTasks(WASM_PATH).catch((e) => {
      visionPromise = null
      throw e
    })
  }
  return visionPromise
}

async function createLandmarker(delegate) {
  const vision = await getVision()
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
        // iOS Safari's WebGL2 can be flaky under memory pressure — fall back to
        // the CPU (WASM) delegate, which always works if the fileset loaded.
        videoLandmarker = await createLandmarker('CPU')
      }
    })().catch((e) => {
      // Let the next attempt retry instead of caching the rejection forever.
      initPromise = null
      throw e
    })
  }
  return initPromise
}

const EMPTY_RESULT = {
  faceLandmarks: [],
  faceBlendshapes: [],
  facialTransformationMatrixes: [],
}

let videoDetectFails = 0
function detectFaceInVideo(video, timestamp) {
  if (!videoLandmarker || video.videoWidth === 0 || video.videoHeight === 0) {
    return EMPTY_RESULT
  }
  try {
    const r = videoLandmarker.detectForVideo(video, timestamp)
    videoDetectFails = 0
    return r
  } catch {
    // A lost WebGL context (iOS memory pressure) makes every subsequent call
    // throw. After a short run of failures, drop the dead landmarker so the
    // tick loop re-initialises it.
    if (++videoDetectFails >= 5 && videoLandmarker) {
      try {
        videoLandmarker.close()
      } catch {
        /* ignore */
      }
      videoLandmarker = null
      initPromise = null
      videoDetectFails = 0
      initFaceDetection().catch(() => {})
    }
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
  overlay: $('overlay'),
  layerStrip: $('layer-strip'),
  metricSide: $('metric-side'),
  metricRail: $('metric-rail'),
  metricStripHint: $('metric-strip-hint'),
  spotCount: $('spot-count'),
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
  skinPanel: $('skin-panel'),
  skinGrid: $('skin-grid'),
  skinAgeVal: $('skin-age-val'),
  retakeBtn: $('retake-btn'),
  cameraError: $('camera-error'),
  autoCapture: $('opt-autocapture'),
  guideShape: $('opt-guideshape'),
  coverageEnabled: $('opt-coverage'),
  liveMap: $('opt-livemap'),
}

const state = {
  mode: 'camera',
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
  // live skin map
  activeMetrics: new Set(),
  mapData: null,
  lastMapAt: 0,
  lastLandmarks: null,
  overlayCtx: null,
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
let coverageEnabled = opt('photoCoverageEnabled', '0') === '1'
let liveMapEnabled = opt('photoLiveMap', '1') === '1'

// Which overlay layers are drawn. Persisted as JSON.
const DEFAULT_LAYERS = { outline: true, zones: true, spots: true, scars: true }
let overlayLayers = (() => {
  try {
    return { ...DEFAULT_LAYERS, ...JSON.parse(opt('photoOverlayLayers', '{}')) }
  } catch {
    return { ...DEFAULT_LAYERS }
  }
})()
const LAYER_DEFS = [
  { key: 'outline', label: 'Face outline', hue: '#9fb4c9' },
  { key: 'zones', label: 'Zones', hue: '#7cc9ff' },
  { key: 'spots', label: 'Spots & moles', hue: '#ffbe3c' },
  { key: 'scars', label: 'Scars', hue: '#ff465a' },
]

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

// ---------------------------------------------------------------------------
// Live skin map — overlay on the camera feed + tappable metric strip.
// SkinMetrics.analyzeMap runs a lightweight per-region pass every
// ~320 ms while a metric is selected; the overlay redraws each detection.
// ---------------------------------------------------------------------------
const METRIC_BY_KEY = {}

// Dense MediaPipe mesh-index rings that trace each skin zone — larger and more
// contoured than the sparse sampling regions in SkinMetrics.REGIONS. Order does
// not matter (zonePoly angle-sorts + trims outliers).
// A wider point set for a few zones where SkinMetrics.REGIONS is too sparse;
// the rest fall back to the region indices. All hull-ed + expanded in zonePoly.
const ZONE_INDICES = {
  forehead: [10, 151, 9, 107, 336, 66, 296, 69, 299, 68, 298, 71, 301, 21, 251, 54, 284, 63, 293],
  nose: [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 327, 45, 275, 129, 358],
}

// Zones drawn on the overlay. `core` zones show whenever the Zones layer is on;
// the rest appear only to carry an active metric's severity tint. `key` is also
// the SkinMetrics.REGIONS name used for that tint; `exp` is the outward expansion.
const FACE_ZONES = [
  { key: 'forehead', hue: '#7cc9ff', core: true, exp: 1.28 },
  { key: 'cheekR', hue: '#ffd166', core: true, exp: 1.42 },
  { key: 'cheekL', hue: '#ffd166', core: true, exp: 1.42 },
  { key: 'nose', hue: '#a0e8af', core: true, exp: 1.14 },
  { key: 'chin', hue: '#f6a5c0', core: true, exp: 1.22 },
  { key: 'underEyeR', hue: '#c9a0ff', core: true, exp: 1.18 },
  { key: 'underEyeL', hue: '#c9a0ff', core: true, exp: 1.18 },
  { key: 'nasolabialR', hue: '#ffb3a0', core: false, exp: 1.2 },
  { key: 'nasolabialL', hue: '#ffb3a0', core: false, exp: 1.2 },
  { key: 'crowsFeetR', hue: '#c9a0ff', core: false, exp: 1.2 },
  { key: 'crowsFeetL', hue: '#c9a0ff', core: false, exp: 1.2 },
]

// Convex hull (Andrew's monotone chain) — a clean, spike-free boundary for a
// zone's mesh points regardless of their order.
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

// A zone polygon: convex hull of its mesh points, gently expanded from the
// centroid so the zones read big.
function zonePoly(L, indices, expand) {
  const pts = []
  for (const i of indices) {
    const p = L[i]
    if (p) pts.push([p.x, p.y])
  }
  if (pts.length < 3) return pts
  const hull = convexHull(pts)
  if (hull.length < 3) return hull
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length
  const k = expand || 1
  return hull.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k])
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

// raw frame-normalized point -> visible (object-cover) normalized point
function toDisplayXY(nx, ny, sw, sh) {
  const sa = sw / sh
  let x = nx
  let y = ny
  if (sa > DISPLAY_ASPECT) {
    const vis = DISPLAY_ASPECT / sa
    const off = (1 - vis) / 2
    x = (nx - off) / vis
  } else if (sa < DISPLAY_ASPECT) {
    const vis = sa / DISPLAY_ASPECT
    const off = (1 - vis) / 2
    y = (ny - off) / vis
  }
  return [x, y]
}

// Which per-region signal stands in for a metric that isn't itself localised.
function regionSeverity(region, key) {
  const s = region.scores
  switch (key) {
    case 'skinType':
    case 'oiliness':
      return s.oiliness
    case 'moisture':
      return s.dryness // highlight where skin reads driest
    case 'radiance':
      return s.texture
    case 'firmness':
      return s.wrinkles
    case 'skinAge':
      return Math.max(s.wrinkles, s.spots, s.darkCircles)
    case 'acne':
      return Math.round(s.spots * 0.6 + s.redness * 0.4)
    case 'droopyUpper':
    case 'droopyLower':
      return region.name.startsWith('underEye') || region.name.startsWith('crowsFeet')
        ? Math.max(s.wrinkles, s.eyeBags, 45)
        : 0
    default:
      return s[key] ?? 0
  }
}

function buildMetricRail() {
  if (!SkinMetrics || !els.metricRail || els.metricRail.childElementCount) return
  SkinMetrics.METRICS.forEach((m) => {
    METRIC_BY_KEY[m.key] = m
  })
  els.metricRail.innerHTML = SkinMetrics.METRICS.map(
    (m) =>
      `<button type="button" data-key="${m.key}" aria-pressed="false">` +
      `<span class="name">${m.label}</span>` +
      (m.dir === 'text'
        ? `<span class="val" style="color:${m.color}">—</span>`
        : `<span class="bar"><i style="background:${m.color}"></i></span>`) +
      `</button>`,
  ).join('')
  els.metricRail.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => toggleMetric(b.dataset.key))
  })
}

function buildLayerStrip() {
  if (!els.layerStrip || els.layerStrip.childElementCount) return
  els.layerStrip.innerHTML = LAYER_DEFS.map(
    (l) =>
      `<button type="button" data-layer="${l.key}" aria-pressed="false">` +
      `<span class="dot" style="background:${l.hue}"></span>${l.label}</button>`,
  ).join('')
  els.layerStrip.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => toggleLayer(b.dataset.layer))
  })
}

function syncLayerButtons() {
  els.layerStrip.querySelectorAll('button').forEach((b) => {
    const on = !!overlayLayers[b.dataset.layer]
    const hue = LAYER_DEFS.find((l) => l.key === b.dataset.layer)?.hue
    b.setAttribute('aria-pressed', String(on))
    b.style.background = on ? hue || '' : ''
    b.style.borderColor = on ? 'transparent' : ''
  })
}

function toggleLayer(key) {
  overlayLayers[key] = !overlayLayers[key]
  persist('photoOverlayLayers', JSON.stringify(overlayLayers))
  syncLayerButtons()
  drawOverlay()
}

function syncMetricButtons() {
  els.metricRail.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(state.activeMetrics.has(b.dataset.key)))
  })
}

function toggleMetric(key) {
  if (state.activeMetrics.has(key)) state.activeMetrics.delete(key)
  else state.activeMetrics.add(key)
  syncMetricButtons()
  drawOverlay()
}

// Rail: every metric shows its live severity bar; the spot counter shows while
// that layer is on.
function updateHudBars() {
  const map = state.mapData
  els.metricRail.querySelectorAll('button').forEach((b) => {
    if (b.dataset.key === 'skinType') {
      const el = b.querySelector('.val')
      if (el) el.textContent = map?.skinType || '—'
      return
    }
    let v = 0
    if (map && map.regions.length) {
      let acc = 0
      for (const r of map.regions) acc += regionSeverity(r, b.dataset.key)
      v = Math.round(acc / map.regions.length)
    }
    b.querySelector('i')?.style && (b.querySelector('i').style.width = `${Math.min(100, v)}%`)
  })
  els.spotCount.hidden = !overlayLayers.spots || !liveMapEnabled
  if (!els.spotCount.hidden) {
    const spots = map ? map.marks.filter((m) => m.kind !== 'linear').length : 0
    const scars = map && overlayLayers.scars ? map.marks.filter((m) => m.kind === 'linear').length : 0
    els.spotCount.textContent =
      `${spots} spot${spots === 1 ? '' : 's'}` + (scars ? ` · ${scars} scar${scars === 1 ? '' : 's'}` : '')
  }
}

function sizeOverlay() {
  const cv = els.overlay
  if (!cv) return
  // clientWidth/Height = the frame's untransformed box (the CSS zoom on #video
  // and .overlay is applied on top and must NOT be baked into the canvas).
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (!w || !h) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  state.overlayCtx = cv.getContext('2d')
}

function clearOverlay() {
  const cv = els.overlay
  if (cv && state.overlayCtx) state.overlayCtx.clearRect(0, 0, cv.width, cv.height)
}

// Expansion of the mesh face-oval so the outline reaches the hairline / jawline
// ("cover my whole face") rather than cutting across the mid-forehead.
const OVAL_EXPAND = { x: 1.12, up: 1.36, down: 1.14 }

function faceCentroid(L) {
  let sx = 0
  let sy = 0
  for (const p of L) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / L.length, y: sy / L.length }
}

function drawOverlay() {
  const cv = els.overlay
  if (!cv || cv.hidden || state.mode !== 'camera') return
  if (!state.overlayCtx || cv.width === 0) sizeOverlay()
  const g = state.overlayCtx
  if (!g) return
  g.clearRect(0, 0, cv.width, cv.height)

  const L = state.lastLandmarks
  const vw = els.video.videoWidth
  const vh = els.video.videoHeight
  if (!L || !vw) return

  const P = (nx, ny) => {
    const [x, y] = toDisplayXY(nx, ny, vw, vh)
    return [x * cv.width, y * cv.height]
  }
  const tracePoly = (pts) => {
    g.beginPath()
    pts.forEach((pt, k) => {
      const [x, y] = P(pt[0], pt[1])
      if (k === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    })
    g.closePath()
  }
  const metrics = [...state.activeMetrics]
  const map = state.mapData
  const REGIONS = SkinMetrics?.REGIONS

  // ---- whole-face outline (expanded past the mesh oval to hairline / jaw) ----
  if (overlayLayers.outline && SkinMetrics?.FACE_OVAL) {
    const c = faceCentroid(L)
    tracePoly(
      SkinMetrics.FACE_OVAL.map((i) => L[i])
        .filter(Boolean)
        .map((p) => [
          c.x + (p.x - c.x) * OVAL_EXPAND.x,
          c.y + (p.y - c.y) * (p.y < c.y ? OVAL_EXPAND.up : OVAL_EXPAND.down),
        ]),
    )
    g.lineWidth = Math.max(1.5, cv.width / 220)
    g.strokeStyle = 'rgba(255, 255, 255, 0.6)'
    g.stroke()
  }

  // ---- face zones (large contoured areas, no captions) ----
  if (overlayLayers.zones || metrics.length) {
    const sevByName = {}
    const colByName = {}
    if (metrics.length && map) {
      for (const r of map.regions) {
        let best = -1
        let bestK = null
        for (const k of metrics) {
          const s = regionSeverity(r, k)
          if (s > best) {
            best = s
            bestK = k
          }
        }
        sevByName[r.name] = best
        colByName[r.name] = METRIC_BY_KEY[bestK]?.color || '#ffffff'
      }
    }
    for (const zone of FACE_ZONES) {
      const show = zone.core ? overlayLayers.zones || metrics.length : metrics.length
      if (!show) continue
      const idx = ZONE_INDICES[zone.key] || REGIONS?.[zone.key]
      if (!idx) continue
      const pts = zonePoly(L, idx, zone.exp || 1.2)
      if (pts.length < 3) continue
      tracePoly(pts)
      const sev = sevByName[zone.key]
      if (sev != null && sev >= 12) {
        g.fillStyle = hexA(colByName[zone.key], 0.12 + 0.4 * Math.min(1, sev / 100))
        g.fill()
      } else if (overlayLayers.zones && !metrics.length) {
        g.fillStyle = hexA(zone.hue, 0.08)
        g.fill()
      }
      g.lineWidth = Math.max(1, cv.width / 300)
      g.strokeStyle = hexA(zone.hue, metrics.length ? 0.5 : 0.85)
      g.stroke()
    }
  }

  // ---- spots / moles / scars ----
  if (map && (overlayLayers.spots || overlayLayers.scars)) {
    for (const mk of map.marks) {
      const [x, y] = P(mk.x, mk.y)
      if (mk.kind === 'linear') {
        if (!overlayLayers.scars) continue
        const rad = Math.max(4, cv.width * 0.02)
        g.strokeStyle = 'rgba(255, 70, 90, 0.95)'
        g.lineWidth = Math.max(1.5, cv.width / 240)
        g.strokeRect(x - rad, y - rad, rad * 2, rad * 2)
      } else {
        if (!overlayLayers.spots) continue
        const rad = Math.max(3, cv.width * 0.014 * (0.6 + mk.strength))
        g.beginPath()
        g.arc(x, y, rad, 0, Math.PI * 2)
        g.strokeStyle = 'rgba(255, 190, 60, 0.95)'
        g.lineWidth = Math.max(1.5, cv.width / 260)
        g.stroke()
      }
    }
  }

  updateHudBars()
}

function applyLiveMapVisibility() {
  const on = liveMapEnabled && SkinMetrics
  els.overlay.hidden = !on
  els.layerStrip.hidden = !on
  els.metricSide.hidden = !on
  els.metricRail.hidden = !on
  els.metricStripHint.hidden = !on
  els.spotCount.hidden = !on || !overlayLayers.spots
  if (on) {
    buildLayerStrip()
    buildMetricRail()
    syncLayerButtons()
    syncMetricButtons()
    sizeOverlay()
    updateHudBars()
  } else {
    clearOverlay()
  }
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
  state.mapData = null
  state.lastLandmarks = null
  state.lastMapAt = 0
  resetCoverage()
}

function stopCamera({ release = false } = {}) {
  if (state.raf !== null) {
    cancelAnimationFrame(state.raf)
    state.raf = null
  }
  clearOverlay()
  state.stream?.getTracks().forEach((t) => t.stop())
  state.stream = null
  els.video.srcObject = null
  // On a full teardown (cancel / page hidden) free the WebGL context the VIDEO
  // landmarker holds. iOS Safari caps live GL contexts and loses them under
  // memory pressure. On capture→preview we keep it warm so a retake is instant.
  if (release && videoLandmarker) {
    try {
      videoLandmarker.close()
    } catch {
      /* ignore */
    }
    videoLandmarker = null
    initPromise = null
  }
}

// Thrown when the browser exposes no camera API at all — almost always because
// the page isn't in a secure context (iOS Safari gives `navigator.mediaDevices
// === undefined` on http:// and file://; the camera only works over https:// or
// http://localhost).
class InsecureContextError extends Error {}

async function requestCameraStream() {
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new InsecureContextError(
      window.isSecureContext
        ? 'This browser does not support camera capture.'
        : 'The camera needs a secure page. Open this over https:// (a file:// or ' +
          'plain http:// page cannot use the camera on iPhone).',
    )
  }
  // Front camera, roughly 3:4. iOS honours `facingMode` but is fussy about hard
  // width/height — keep them as `ideal` only, and fall back to bare facingMode.
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
    if (
      err instanceof DOMException &&
      (err.name === 'OverconstrainedError' || err.name === 'NotReadableError')
    ) {
      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      })
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
      state.lastLandmarks = landmarks
    } else {
      resetCoverage()
      state.lastLandmarks = null
      state.mapData = null
    }

    // Live skin map: re-run the lightweight per-region pass every ~320 ms
    // whenever a face is present — it drives the always-on spot / mole / scar
    // markers as well as the selected-metric heat.
    if (
      liveMapEnabled &&
      state.lastLandmarks &&
      SkinMetrics &&
      timestamp - state.lastMapAt >= 320
    ) {
      state.lastMapAt = timestamp
      try {
        state.mapData = SkinMetrics.analyzeMap(
          state.lastLandmarks,
          video,
          video.videoWidth,
          video.videoHeight,
        )
      } catch (err) {
        console.error('live map', err)
      }
    }
    if (liveMapEnabled) drawOverlay()

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

// ---------------------------------------------------------------------------
// Skin-age panel (SkinMetrics, defined in skin-metrics.js)
// ---------------------------------------------------------------------------
function renderSkinSkeleton() {
  if (!SkinMetrics || !els.skinGrid) return
  els.skinAgeVal.textContent = '•••'
  els.skinGrid.innerHTML = SkinMetrics.METRICS.map(
    (m) => `
      <div class="skin-metric">
        <div class="ring" style="border-color:${m.color}"><b>•••</b></div>
        <div class="label">${m.label}</div>
      </div>`,
  ).join('')
  els.skinPanel.hidden = false
}

function renderSkinReport(report) {
  if (!els.skinGrid) return
  els.skinAgeVal.textContent =
    report.confidence === 'low' ? `~${report.skinAge}` : String(report.skinAge)
  els.skinGrid.innerHTML = report.metrics
    .map(
      (m) => `
      <div class="skin-metric">
        <div class="ring" style="border-color:${m.color}">
          <b>${m.display}</b>${m.rating ? `<small>${m.rating}</small>` : ''}
        </div>
        <div class="label">${m.label}</div>
      </div>`,
    )
    .join('')
  els.skinPanel.hidden = false
}

async function validateStill(dataUrl) {
  els.previewMessage.textContent = 'Checking your photo…'
  els.previewMessage.dataset.state = 'checking'
  renderSkinSkeleton()
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

    // Skin-age panel: run the metric heuristics on the still + its face mesh.
    if (landmarks && landmarks.length > 0 && SkinMetrics) {
      try {
        renderSkinReport(
          SkinMetrics.analyze(landmarks, img, img.naturalWidth, img.naturalHeight),
        )
      } catch (err) {
        console.error('skin metrics', err)
        els.skinPanel.hidden = true
      }
    } else {
      els.skinPanel.hidden = true
    }
  } catch {
    els.previewMessage.textContent = 'Could not check the photo. Retake and try again.'
    els.previewMessage.dataset.state = 'bad'
    if (els.skinPanel) els.skinPanel.hidden = true
  }
}

// A separate IMAGE-mode landmarker for validating the captured still.
let imageLandmarker = null
let imageLandmarkerPromise = null
async function ensureImageLandmarker() {
  if (imageLandmarker) return imageLandmarker
  if (!imageLandmarkerPromise) {
    imageLandmarkerPromise = (async () => {
      const vision = await getVision()
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
    })().catch((e) => {
      imageLandmarkerPromise = null
      throw e
    })
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

function cameraErrorMessage(err) {
  if (err instanceof InsecureContextError) return err.message
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return (
      'Camera permission was denied. On iPhone: Settings ▸ Safari ▸ Camera ▸ ' +
      'Allow, or tap “AA” in the address bar ▸ Website Settings ▸ Camera, then reload.'
    )
  }
  if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
    return 'No usable front camera was found on this device.'
  }
  if (err && err.name === 'NotReadableError') {
    return 'The camera is busy in another app. Close it and try again.'
  }
  if (err && err.name === 'AbortError') {
    return 'The camera did not start. Try again.'
  }
  return 'Camera access is unavailable. Reload and try again.'
}

async function startCamera() {
  // Stop any live stream but keep the landmarker warm — a retake shouldn't pay
  // the model-load cost again. Full release happens on cancel / page-hide.
  stopCamera()
  els.cameraError.hidden = true
  resetTracking()
  showScreen('camera')
  els.message.textContent = 'Starting camera…'

  let stream
  try {
    // iOS Safari ties getUserMedia to the tap that triggered it and the grant
    // window is short — request the camera FIRST, before the (potentially
    // multi-second) MediaPipe download, or the gesture goes stale and iOS
    // rejects with NotAllowedError.
    stream = await requestCameraStream()
  } catch (err) {
    console.error('camera', err)
    els.cameraError.textContent = cameraErrorMessage(err)
    els.cameraError.hidden = false
    showScreen('choose')
    return
  }

  state.stream = stream
  els.video.srcObject = stream
  try {
    await els.video.play()
  } catch {
    // Autoplay was blocked despite muted+playsinline (rare on iOS). The stream
    // is live; a tap on the frame will start it.
  }

  applyLiveMapVisibility()
  els.video.addEventListener('loadedmetadata', () => sizeOverlay(), { once: true })
  requestAnimationFrame(() => sizeOverlay())

  els.message.textContent = 'Loading face detection…'
  try {
    await initFaceDetection()
  } catch (err) {
    console.error('detector', err)
    els.cameraError.textContent =
      'Face detection could not load. Check your connection and reload.'
    els.cameraError.hidden = false
    stopCamera({ release: true })
    showScreen('choose')
    return
  }
  ensureImageLandmarker().catch(() => {})

  // Camera may have been cancelled while the model loaded.
  if (state.mode !== 'camera' || !state.stream) return

  renderGuide(false)
  state.lastDetect = 0
  state.raf = requestAnimationFrame(tick)
}

// iOS suspends getUserMedia tracks and rAF when Safari backgrounds; coming back
// leaves a frozen frame. Tear the camera down on hide so returning is a clean
// restart rather than a stuck preview.
addDoc('visibilitychange', () => {
  if (document.hidden && state.mode === 'camera' && !state.captured) {
    stopCamera({ release: true })
    resetTracking()
    els.cameraError.textContent = 'Camera paused. Tap “Start camera” to resume.'
    els.cameraError.hidden = false
    showScreen('choose')
  }
})

// --- events ---
els.startBtn.addEventListener('click', startCamera)
els.takeBtn.addEventListener('click', captureFromVideo)
els.cancelBtn.addEventListener('click', () => {
  stopCamera({ release: true })
  resetTracking()
  showScreen('choose')
})
els.retakeBtn.addEventListener('click', () => {
  els.photo.removeAttribute('src')
  startCamera()
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

els.liveMap.checked = liveMapEnabled
els.liveMap.addEventListener('change', () => {
  liveMapEnabled = els.liveMap.checked
  persist('photoLiveMap', liveMapEnabled ? '1' : '0')
  if (!liveMapEnabled) {
    state.activeMetrics.clear()
    state.mapData = null
    syncMetricButtons()
  }
  applyLiveMapVisibility()
})

// Keep the overlay canvas matched to the frame on rotor / resize.
addWin('resize', () => {
  if (state.mode === 'camera' && liveMapEnabled) {
    sizeOverlay()
    drawOverlay()
  }
})

// Skip the intro screen — start scanning as soon as the page loads. On browsers
// that require a user gesture for the camera (notably iOS Safari), startCamera()
// falls back to the #screen-choose screen with a "Start camera" button.
startCamera()

return () => {
  stopCamera({ release: true })
  teardown.forEach((fn) => fn())
}
}
