import type {
  FaceLandmarkerResult,
  NormalizedLandmark,
} from '@mediapipe/tasks-vision'

// Aspect ratio the live <video> / preview <img> are shown at (object-cover in a
// 3:4 box — see PhotoScreen). Landmark coords are relative to the full camera
// frame; anything the position check reads must first be remapped into this
// visible, cover-cropped space via toDisplayBox().
export const DISPLAY_ASPECT = 3 / 4

// All tuning lives here. Position thresholds are calibrated to the on-screen
// guide (FaceGuideOverlay): a rounded square 78% of the frame width, 58.5% of
// the frame height, centred. All coords/fractions are of the VISIBLE frame.
export const CFG = {
  // --- Lighting: mean luma (0–255) of the face region (sampleFaceBrightness). ---
  lightGoodMin: 90,
  lightGoodMax: 150,
  lightOkMin: 55,
  lightOkMax: 222,

  // --- Head pose: |angle| in degrees from the 4x4 transform matrix. Pitch runs
  // looser than yaw/roll because a webcam below eye level reads ~10–16° of pitch
  // on someone looking straight at the screen. ---
  poseYawGood: 14,
  poseYawOk: 22,
  posePitchGood: 18,
  posePitchOk: 28,
  poseRollGood: 12,
  poseRollOk: 20,

  // --- Face position (evaluatePosition), in VISIBLE-frame fractions. ---
  sizeGoodMin: 0.44, // face-mesh bbox width; below this = "Come Closer"
  sizeGoodMax: 0.64, // above this = "Move Back"
  centerTolX: 0.12, // |cx - 0.5| allowed before "Center Face"
  centerTolY: 0.12, // |cy - centerTargetY| allowed
  centerTargetY: 0.5, // guide is vertically centred

  captureHold: 10, // consecutive all-good detections (~90ms each) before capture

  // --- Face-covering heuristics — see evaluateCoverage. ---
  // Glasses: a decisive tinted-lens reading, OR >= 2 softer frame/lens signals.
  glassEyeDarkRatio: 0.62, // eye band darker than this fraction of skin luma
  glassGlareFrac: 0.1, // fraction of eye-band pixels near-white (lens glare)
  glassBridgeDarkRatio: 0.6, // nose-bridge darker than this fraction of cheek luma
  glassBridgeContrast: 30, // nose-bridge luma std-dev above this = a rim/bridge edge
  glassTempleDarkRatio: 0.55, // temple darker than this fraction of cheek luma = an arm
  glassSoftSignalsToTrip: 2, // soft signals required when no decisive tint
  sunglassLumRatio: 0.45, // eye band this much darker than skin = decisive tint

  // Mask: the lower face must (a) look UN-skinlike — brighter than the cheeks, or
  // shifted toward blue / desaturated — and (b) differ substantially from the
  // cheeks, OR the lips are no longer redder than the cheeks. A beard / jaw
  // shadow only makes the area darker while KEEPING skin chroma, so (a) fails.
  maskBrightDelta: 12, // lower face brighter than cheeks by this (white/surgical)
  maskBlueShiftMin: 0.018, // rise in blue chromaticity vs cheeks (blue/black/grey)
  maskRedDropMin: 0.022, // drop in red chromaticity vs cheeks (any non-skin fabric)
  maskColorDelta: 24, // RGB distance lower-face vs cheeks = a real colour break
  maskLipRednessRatio: 1.04, // bare lips are at least this much redder than cheeks
  maskFlatMax: 22, // (unused for now) lower-face luma std-dev = smooth fabric

  // Partial occlusion (a hand / hair covering one side of the face). Compare the
  // left and right halves of the eye–cheek band: on a real frontal face they
  // match; a covering flattens one side (its eye/features vanish) and usually
  // shifts its colour or brightness.
  occlusionMinFaceW: 0.14, // skip if the face is smaller than this (raw frame)
  occlusionColorDelta: 38, // RGB distance between the two halves = different stuff
  occlusionFlatMax: 15, // a half with std-dev below this has lost its eye/features
  occlusionStdRatio: 0.5, // flatter half < this fraction of the busier half
  occlusionLumDelta: 28, // brightness gap between the halves
  occlusionStdRatioLoose: 0.72, // std ratio paired with the brightness gap

  coverageMinSkinLum: 40, // below this the face is too dark to judge coverage
  coverageConfirmFrames: 3, // frames the covered/clear flip must hold

  // --- Capture quality: only checked on the final still (sampleFaceSharpness).
  // Mean luma gradient over an 80×80 crop of the face — sharp ~10–30, a blurry
  // or out-of-focus face ~2–6. ---
  sharpnessMin: 5,
}

// MediaPipe canonical 478-point face mesh indices, grouped into sampling regions.
export const COVERAGE_REGIONS = {
  eyeBand: [33, 263, 70, 300, 145, 374, 168],
  noseBridge: [168, 6, 197, 195, 8],
  rightTemple: [33, 234, 127, 116],
  leftTemple: [263, 454, 356, 345],
  rightCheek: [50, 101, 205, 207, 187],
  leftCheek: [280, 330, 425, 427, 411],
  forehead: [10, 151, 9, 107, 336],
  lowerFace: [2, 164, 0, 13, 14, 17, 18, 200, 199, 152, 212, 432],
  lips: [13, 14, 0, 17, 61, 291],
} as const

function coverageDebugEnabled(): boolean {
  try {
    return localStorage.getItem('faceCoverageDebug') === '1'
  } catch {
    return false
  }
}
let coverageDebugTick = 0
let faceDebugTick = 0

export type CheckLevel = 'good' | 'warn' | 'bad'

export type Check = {
  level: CheckLevel
  label: string
}

export type FaceStatus =
  | 'no_face'
  | 'covered'
  | 'blurry'
  | 'too_far'
  | 'too_close'
  | 'off_center'
  | 'valid'

export type CoverageKind =
  | 'clear'
  | 'glasses'
  | 'mask'
  | 'occluded'
  | 'unknown'

export type CoverageResult = Check & {
  ok: boolean
  kind: CoverageKind
}

export type FaceEvaluation = {
  faceFound: boolean
  light: Check
  pose: Check
  position: Check
  coverage: Check
  status: FaceStatus
  allGood: boolean
  message: string
}

export type FaceBox = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  w: number
  h: number
  cx: number
  cy: number
}

const NO_FACE: FaceEvaluation = {
  faceFound: false,
  light: { level: 'warn', label: '—' },
  pose: { level: 'bad', label: 'No Face' },
  position: { level: 'bad', label: 'No Face' },
  coverage: { level: 'bad', label: 'No Face' },
  status: 'no_face',
  allGood: false,
  message: 'Position your face in the circle',
}

export const UNKNOWN_COVERAGE: CoverageResult = {
  level: 'warn',
  label: '—',
  ok: true,
  kind: 'unknown',
}

export function faceBoxFromLandmarks(landmarks: NormalizedLandmark[]): FaceBox {
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

/**
 * Remap a face box from full-camera-frame coords into the coords actually shown
 * on screen. The <video>/<img> is object-cover inside a `DISPLAY_ASPECT` box, so
 * when the camera delivers a wider (or taller) stream the sides (or top/bottom)
 * are cropped and never seen. Without this, a face filling the on-screen guide
 * still measures "too small" because it's compared against the uncropped width.
 */
export function toDisplayBox(
  box: FaceBox,
  sourceW: number,
  sourceH: number,
  displayAspect = DISPLAY_ASPECT,
): FaceBox {
  let { minX, minY, maxX, maxY } = box
  const sourceAspect = sourceW / sourceH

  if (sourceAspect > displayAspect) {
    // Stream wider than the frame → sides cropped. Rescale X about the centre.
    const visible = displayAspect / sourceAspect
    const off = (1 - visible) / 2
    minX = (minX - off) / visible
    maxX = (maxX - off) / visible
  } else if (sourceAspect < displayAspect) {
    // Stream taller than the frame → top/bottom cropped. Rescale Y.
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
export function eulerFromMatrix(m: number[]) {
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

/**
 * Average luminance of the face region only, so a dark background doesn't
 * cause a false "Too Dark". Draws the face bounding box into a tiny canvas.
 */
export function sampleFaceBrightness(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  box: FaceBox,
  sampleCtx: CanvasRenderingContext2D,
): number {
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

/**
 * Rough focus / motion-blur score for the face: the mean luma gradient over the
 * face drawn into an 80×80 crop, so it's roughly independent of source
 * resolution. A sharp face keeps crisp eye / nostril / lip edges (~10–30); a
 * blurry one goes mushy (~2–6). Only meaningful on the final still.
 */
export function sampleFaceSharpness(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  box: FaceBox,
  sampleCtx: CanvasRenderingContext2D,
): number {
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

  const lumAt = (i: number) =>
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

type RegionStats = {
  lum: number
  stdDev: number
  r: number
  g: number
  b: number
  brightFrac: number
}

function statsFromImageData(data: Uint8ClampedArray): RegionStats {
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

/**
 * Stats for an arbitrary normalized rectangle of the source (0–1 coords),
 * drawn into the shared sample canvas. Returns null if the rect is degenerate.
 */
function sampleNormRect(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  nx: number,
  ny: number,
  nw: number,
  nh: number,
  sampleCtx: CanvasRenderingContext2D,
): RegionStats | null {
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

/**
 * Mean luminance, luminance std-dev (texture) and mean RGB of a face sub-region
 * defined by a set of landmark indices. Reuses the shared tiny sample canvas.
 */
export function sampleRegionStats(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  landmarks: NormalizedLandmark[],
  indices: readonly number[],
  sampleCtx: CanvasRenderingContext2D,
): RegionStats | null {
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
  // Pad slightly so a thin region (eye line, lip line) has area to sample.
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

type RGB = { r: number; g: number; b: number }

// Chromaticity (hue independent of brightness). Skin sits high-red / low-blue;
// darkening it (a beard, a shadow) pushes red UP and blue DOWN. Any fabric —
// white, grey, black, blue — pushes the opposite way: red down, blue up.
function chromaticity(c: RGB): { r: number; b: number } {
  const sum = c.r + c.g + c.b + 1
  return { r: c.r / sum, b: c.b / sum }
}

function rgbDistance(a: RGB, b: RGB): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

const GLASSES_RESULT: CoverageResult = {
  level: 'bad',
  label: 'Remove Glasses',
  ok: false,
  kind: 'glasses',
}
const MASK_RESULT: CoverageResult = {
  level: 'bad',
  label: 'Uncover Face',
  ok: false,
  kind: 'mask',
}
const OCCLUSION_RESULT: CoverageResult = {
  level: 'bad',
  label: 'Uncover Face',
  ok: false,
  kind: 'occluded',
}
const CLEAR_RESULT: CoverageResult = {
  level: 'good',
  label: 'Good',
  ok: true,
  kind: 'clear',
}

/**
 * Heuristic detection of a face covering — glasses (clear or tinted) over the
 * eyes, or a mask over the lower face — by comparing those regions against
 * known-skin reference patches (cheeks + forehead). This is not a classifier:
 * thin rimless frames or a face turned away may slip through.
 */
export function evaluateCoverage(
  landmarks: NormalizedLandmark[],
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  sampleCtx: CanvasRenderingContext2D,
): CoverageResult {
  const stat = (indices: readonly number[]) =>
    sampleRegionStats(source, sourceW, sourceH, landmarks, indices, sampleCtx)

  const rightCheek = stat(COVERAGE_REGIONS.rightCheek)
  const leftCheek = stat(COVERAGE_REGIONS.leftCheek)
  const forehead = stat(COVERAGE_REGIONS.forehead)
  const cheeks = [rightCheek, leftCheek].filter(Boolean) as RegionStats[]
  const skinRefs = [...cheeks, forehead].filter(Boolean) as RegionStats[]
  if (cheeks.length === 0 || skinRefs.length === 0 || !forehead) {
    return UNKNOWN_COVERAGE
  }

  const skinLum = skinRefs.reduce((s, x) => s + x.lum, 0) / skinRefs.length
  // Face too dark to judge reliably — the Lighting check already blocks this.
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

  // Glasses signals. `sigTinted` alone is decisive; the rest are "soft" and need
  // to agree (glassSoftSignalsToTrip) so heavy brows / deep-set eyes / a nose
  // shadow don't trip it on their own.
  const sigTinted = !!eyeBand && eyeBand.lum < skinLum * CFG.sunglassLumRatio
  const softGlass = [
    !!eyeBand && eyeBand.lum < skinLum * CFG.glassEyeDarkRatio,
    !!eyeBand && eyeBand.brightFrac > CFG.glassGlareFrac,
    !!noseBridge && noseBridge.lum < cheekLum * CFG.glassBridgeDarkRatio,
    !!noseBridge &&
      noseBridge.stdDev >
        Math.max(CFG.glassBridgeContrast, forehead.stdDev * 2),
    templeMinLum < cheekLum * CFG.glassTempleDarkRatio,
  ]
  const softGlassCount = softGlass.filter(Boolean).length
  const glasses = sigTinted || softGlassCount >= CFG.glassSoftSignalsToTrip

  // Mask. A beard / jaw shadow only makes the lower face DARKER while keeping
  // skin chroma (red up, blue down). A mask does the opposite — it is brighter
  // than skin (white / surgical) or its chroma shifts toward blue / grey. Detect
  // that "un-skinlike" shift, then require a real difference from the cheeks or
  // that the lips are no longer redder than the cheeks.
  const lowerFace = stat(COVERAGE_REGIONS.lowerFace)
  const lips = stat(COVERAGE_REGIONS.lips)

  const maskColor = lowerFace ? rgbDistance(lowerFace, cheekRGB) : 0
  const lowerChroma = lowerFace ? chromaticity(lowerFace) : null
  const cheekChroma = chromaticity(cheekRGB)
  const blueShift = lowerChroma ? lowerChroma.b - cheekChroma.b : 0
  const redDrop = lowerChroma ? cheekChroma.r - lowerChroma.r : 0

  const sigBrighter =
    !!lowerFace && lowerFace.lum > cheekLum + CFG.maskBrightDelta
  const sigUnskinlike =
    blueShift > CFG.maskBlueShiftMin || redDrop > CFG.maskRedDropMin
  const notBeard = sigBrighter || sigUnskinlike

  const sigColourBreak = maskColor > CFG.maskColorDelta
  const cheekRedness = cheekRGB.r / (cheekRGB.g + 1)
  const lipRedness = lips ? lips.r / (lips.g + 1) : Infinity
  const sigLipsHidden =
    !!lips && lipRedness < cheekRedness * CFG.maskLipRednessRatio

  const mask = !!lowerFace && notBeard && (sigColourBreak || sigLipsHidden)

  // --- Partial occlusion: a hand / hair over one side of the face ---
  // On a frontal face the left and right halves of the eye–cheek band match:
  // each holds an eye (busy, similar brightness). A covering flattens one half
  // and usually shifts its colour or brightness.
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

  let symColor = 0
  let symLum = 0
  let symStdRatio = 1
  let occluded = false
  if (leftHalf && rightHalf) {
    symColor = rgbDistance(leftHalf, rightHalf)
    symLum = Math.abs(leftHalf.lum - rightHalf.lum)
    const lo = Math.min(leftHalf.stdDev, rightHalf.stdDev)
    const hi = Math.max(leftHalf.stdDev, rightHalf.stdDev, 1)
    symStdRatio = lo / hi
    occluded =
      symColor > CFG.occlusionColorDelta ||
      (lo < CFG.occlusionFlatMax && symStdRatio < CFG.occlusionStdRatio) ||
      (symLum > CFG.occlusionLumDelta &&
        symStdRatio < CFG.occlusionStdRatioLoose)
  }

  if (coverageDebugEnabled() && coverageDebugTick++ % 4 === 0) {
    // eslint-disable-next-line no-console
    console.log('[coverage]', {
      skinLum: +skinLum.toFixed(1),
      cheekLum: +cheekLum.toFixed(1),
      lowerFaceLum: lowerFace ? +lowerFace.lum.toFixed(1) : null,
      eyeBandLum: eyeBand ? +eyeBand.lum.toFixed(1) : null,
      eyeBandGlare: eyeBand ? +eyeBand.brightFrac.toFixed(3) : null,
      bridgeLum: noseBridge ? +noseBridge.lum.toFixed(1) : null,
      foreheadStd: +forehead.stdDev.toFixed(1),
      templeMinLum: Number.isFinite(templeMinLum) ? +templeMinLum.toFixed(1) : null,
      maskColor: +maskColor.toFixed(1),
      blueShift: +blueShift.toFixed(3),
      redDrop: +redDrop.toFixed(3),
      lipRednessVsCheek: lips ? +(lipRedness / cheekRedness).toFixed(3) : null,
      sigTinted,
      softGlassCount,
      sigBrighter,
      sigUnskinlike,
      sigColourBreak,
      sigLipsHidden,
      symColor: +symColor.toFixed(1),
      symLum: +symLum.toFixed(1),
      symStdRatio: +symStdRatio.toFixed(2),
      occluded,
      verdict: glasses ? 'glasses' : mask ? 'mask' : occluded ? 'occluded' : 'clear',
    })
  }

  if (glasses) return GLASSES_RESULT
  if (mask) return MASK_RESULT
  if (occluded) return OCCLUSION_RESULT
  return CLEAR_RESULT
}

function evaluateLight(brightness: number): Check & { ok: boolean } {
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

function evaluatePose(matrix: number[] | null): Check & { ok: boolean } {
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

function evaluatePosition(box: FaceBox): {
  check: Check
  ok: boolean
  status: FaceStatus
} {
  if (box.w < CFG.sizeGoodMin) {
    return {
      check: { level: 'bad', label: 'Come Closer' },
      ok: false,
      status: 'too_far',
    }
  }
  if (box.w > CFG.sizeGoodMax) {
    return {
      check: { level: 'bad', label: 'Move Back' },
      ok: false,
      status: 'too_close',
    }
  }
  const offX = Math.abs(box.cx - 0.5)
  const offY = Math.abs(box.cy - CFG.centerTargetY)
  if (offX > CFG.centerTolX || offY > CFG.centerTolY) {
    return {
      check: { level: 'warn', label: 'Center Face' },
      ok: false,
      status: 'off_center',
    }
  }
  return { check: { level: 'good', label: 'Good' }, ok: true, status: 'valid' }
}

const POSITION_MESSAGES: Record<FaceStatus, string> = {
  no_face: 'Position your face in the circle',
  covered: 'Uncover your face',
  blurry: 'Photo looks blurry — hold steady and retake',
  too_far: 'Move a little closer',
  too_close: 'Move back a little',
  off_center: 'Center your face in the frame',
  valid: 'Looks good',
}

const COVERAGE_MESSAGES: Record<CoverageKind, string> = {
  clear: '',
  glasses: 'Take off your glasses',
  mask: 'Take off your face mask',
  occluded: 'Keep your whole face visible',
  unknown: 'Uncover your face',
}

/**
 * Runs all four checks from a single FaceLandmarker result plus a pre-computed
 * face-region brightness and coverage verdict. `brightness` is null when it
 * couldn't be sampled (treated as a passing light check so it never blocks on
 * its own); `coverage` defaults to a passing "unknown" result. `frame` is the
 * camera/image pixel size — pass it so the position check runs in the visible,
 * object-cover-cropped space rather than against the full uncropped frame.
 * `sharpness` (from sampleFaceSharpness) is only passed for the final still —
 * null on the live feed, where per-frame motion blur is expected.
 */
export function evaluateFace(
  result: FaceLandmarkerResult,
  brightness: number | null,
  coverage: CoverageResult = UNKNOWN_COVERAGE,
  frame?: { w: number; h: number },
  sharpness: number | null = null,
): FaceEvaluation {
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
      ? { level: 'warn' as const, label: 'Ok', ok: true }
      : evaluateLight(brightness)
  const pose = evaluatePose(Array.isArray(matrix) ? matrix : matrix ? Array.from(matrix) : null)
  const position = evaluatePosition(box)

  if (coverageDebugEnabled() && faceDebugTick++ % 4 === 0) {
    const angles = matrix
      ? eulerFromMatrix(Array.isArray(matrix) ? matrix : Array.from(matrix))
      : null
    // eslint-disable-next-line no-console
    console.log('[face]', {
      boxW: +box.w.toFixed(3),
      cx: +box.cx.toFixed(3),
      cy: +box.cy.toFixed(3),
      yaw: angles ? +angles.yaw.toFixed(1) : null,
      pitch: angles ? +angles.pitch.toFixed(1) : null,
      roll: angles ? +angles.roll.toFixed(1) : null,
      brightness: brightness === null ? null : +brightness.toFixed(1),
      sharpness: sharpness === null ? null : +sharpness.toFixed(1),
      position: position.status,
      pose: pose.label,
    })
  }

  const blurry = sharpness !== null && sharpness < CFG.sharpnessMin
  const allGood =
    light.ok && pose.ok && position.ok && coverage.ok && !blurry

  let message: string
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

  const status: FaceStatus = allGood
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

export const PREVIEW_DISPLAY_WIDTH = 280

export function createSampleCanvasCtx(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = 80
  canvas.height = 80
  return canvas.getContext('2d', { willReadFrequently: true })!
}

export async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = dataUrl
  })
}
