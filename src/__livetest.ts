// Temporary LIVE test harness for the guided face-capture feature.
// Runs the exact production pipeline (faceDetection.ts + faceGuide.ts) against
// the webcam, shows every check value, and auto-captures on the same
// CFG.captureHold streak the real PhotoScreen uses.
// Delete along with __livetest.html when done.
import { detectFaceInVideo, initFaceDetection } from './lib/faceDetection'
import {
  CFG,
  CFG_DEFAULTS,
  createSampleCanvasCtx,
  eulerFromMatrix,
  evaluateCoverage,
  evaluateFace,
  faceBoxFromLandmarks,
  sampleFaceBrightness,
  toDisplayBox,
  UNKNOWN_COVERAGE,
  type CoverageResult,
} from './lib/faceGuide'

const video = document.getElementById('video') as HTMLVideoElement
const still = document.getElementById('still') as HTMLImageElement
const panel = document.getElementById('panel') as HTMLPreElement
const verdictEl = document.getElementById('verdict') as HTMLElement
const messageEl = document.getElementById('message') as HTMLElement
const seenEl = document.getElementById('seen') as HTMLElement

const SEEN_KEYS = [
  'no_face',
  'too_far',
  'too_close',
  'off_center',
  'pose_yaw',
  'pose_pitch',
  'pose_roll',
  'light_dark',
  'light_bright',
  'cover_glasses',
  'cover_mask',
  'cover_occluded',
  'valid',
  'auto_captured',
]
const seen: Record<string, boolean> = {}
SEEN_KEYS.forEach((k) => (seen[k] = false))
function renderSeen() {
  seenEl.innerHTML = SEEN_KEYS.map(
    (k) => `<span class="${seen[k] ? 'hit' : ''}">${k}${seen[k] ? ' ✓' : ''}</span>`,
  ).join('')
}
renderSeen()

const sampleCtx = createSampleCanvasCtx()
const capCanvas = document.createElement('canvas')

let streak = 0
let captured = false
let autoOn = false
let coverEnabled = true
let mirror = true
let lastDetect = 0

type LiveState = {
  fps: number
  brightness: number | null
  yaw: number | null
  pitch: number | null
  roll: number | null
  boxW: number | null
  cx: number | null
  cy: number | null
  coverage: string
  light: string
  pose: string
  position: string
  status: string
  allGood: boolean
  streak: number
  message: string
}
const state: Partial<LiveState> = {}
;(window as unknown as { __live: Partial<LiveState> }).__live = state
;(window as unknown as { __seen: Record<string, boolean> }).__seen = seen

let frames = 0
let fpsMark = performance.now()

// Latest raw mask signals (from the [coverage] debug log) for on-screen display.
let lastMaskSig: Record<string, unknown> | null = null
{
  const orig = console.log.bind(console)
  console.log = (...a: unknown[]) => {
    if (a[0] === '[coverage]' && a[1] && typeof a[1] === 'object') {
      const c = a[1] as Record<string, unknown>
      lastMaskSig = {
        verdict: c.verdict,
        maskColor: c.maskColor,
        blueShift: c.blueShift,
        redDrop: c.redDrop,
        lipVsCheek: c.lipRednessVsCheek,
        sigUnskinlike: c.sigUnskinlike,
        sigColourBreak: c.sigColourBreak,
        sigLipsHidden: c.sigLipsHidden,
        sigBrighter: c.sigBrighter,
      }
    }
    orig(...a)
  }
}

function capture() {
  captured = true
  const w = video.videoWidth
  const h = video.videoHeight
  capCanvas.width = w
  capCanvas.height = h
  const ctx = capCanvas.getContext('2d')!
  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, w, h)
  ctx.restore()
  still.src = capCanvas.toDataURL('image/jpeg', 0.9)
  still.style.display = 'block'
  video.style.display = 'none'
  seen.auto_captured = true
  renderSeen()
  // eslint-disable-next-line no-console
  console.log('[livetest] AUTO-CAPTURED')
}

function tick(ts: number) {
  frames++
  if (ts - fpsMark > 1000) {
    state.fps = Math.round((frames * 1000) / (ts - fpsMark))
    frames = 0
    fpsMark = ts
  }

  if (!captured && video.videoWidth > 0 && ts - lastDetect > 100) {
    lastDetect = ts
    const result = detectFaceInVideo(video, performance.now())
    const landmarks = result.faceLandmarks?.[0]

    let brightness: number | null = null
    let coverage: CoverageResult = UNKNOWN_COVERAGE
    if (landmarks && landmarks.length > 0) {
      const rawBox = faceBoxFromLandmarks(landmarks)
      try {
        brightness = sampleFaceBrightness(
          video,
          video.videoWidth,
          video.videoHeight,
          rawBox,
          sampleCtx,
        )
      } catch {
        /* ignore */
      }
      if (coverEnabled) {
        try {
          coverage = evaluateCoverage(
            landmarks,
            video,
            video.videoWidth,
            video.videoHeight,
            sampleCtx,
          )
        } catch (e) {
          console.warn('[livetest] coverage err', e)
        }
      }
    }

    const evaln = evaluateFace(result, brightness, coverage, {
      w: video.videoWidth,
      h: video.videoHeight,
    })

    // pose angles for display
    const m = result.facialTransformationMatrixes?.[0]?.data
    const ang = m ? eulerFromMatrix(Array.from(m)) : null
    const dbox =
      landmarks && landmarks.length
        ? toDisplayBox(
            faceBoxFromLandmarks(landmarks),
            video.videoWidth,
            video.videoHeight,
          )
        : null

    streak = evaln.allGood ? streak + 1 : 0
    if (autoOn && streak >= CFG.captureHold && !captured) capture()

    // latch observed cases
    if (evaln.status === 'no_face') seen.no_face = true
    if (evaln.status === 'too_far') seen.too_far = true
    if (evaln.status === 'too_close') seen.too_close = true
    if (evaln.status === 'off_center') seen.off_center = true
    if (evaln.status === 'valid') seen.valid = true
    if (evaln.light.label === 'Too Dark') seen.light_dark = true
    if (evaln.light.label === 'Too Bright') seen.light_bright = true
    if (evaln.coverage.label === 'Remove Glasses') seen.cover_glasses = true
    if (evaln.coverage.label === 'Uncover Face' && coverage.kind === 'mask')
      seen.cover_mask = true
    if (coverage.kind === 'occluded') seen.cover_occluded = true
    if (ang && evaln.pose.label !== 'Good') {
      if (Math.abs(ang.yaw) > CFG.poseYawGood) seen.pose_yaw = true
      if (Math.abs(ang.pitch) > CFG.posePitchGood) seen.pose_pitch = true
      if (Math.abs(ang.roll) > CFG.poseRollGood) seen.pose_roll = true
    }
    renderSeen()

    Object.assign(state, {
      brightness,
      yaw: ang ? +ang.yaw.toFixed(1) : null,
      pitch: ang ? +ang.pitch.toFixed(1) : null,
      roll: ang ? +ang.roll.toFixed(1) : null,
      boxW: dbox ? +dbox.w.toFixed(3) : null,
      cx: dbox ? +dbox.cx.toFixed(3) : null,
      cy: dbox ? +dbox.cy.toFixed(3) : null,
      coverage: coverEnabled
        ? `${coverage.kind} / ${evaln.coverage.label}`
        : 'OFF',
      maskSignals: lastMaskSig,
      light: evaln.light.label,
      pose: evaln.pose.label,
      position: evaln.position.label,
      status: evaln.status,
      allGood: evaln.allGood,
      streak,
      message: evaln.message,
    })

    verdictEl.textContent = evaln.allGood
      ? `ALL GOOD  (streak ${streak}/${CFG.captureHold})`
      : evaln.status.toUpperCase()
    verdictEl.className = 'big ' + (evaln.allGood ? 'ok' : 'bad')
    messageEl.textContent = evaln.message
    panel.textContent = JSON.stringify(
      { fps: state.fps, ...state },
      null,
      1,
    )
  }
  requestAnimationFrame(tick)
}

document.getElementById('resume')!.addEventListener('click', () => {
  captured = false
  streak = 0
  still.style.display = 'none'
  video.style.display = 'block'
})
document.getElementById('auto')!.addEventListener('click', (e) => {
  autoOn = !autoOn
  streak = 0
  ;(e.target as HTMLButtonElement).textContent = autoOn
    ? 'Auto-capture: ON'
    : 'Auto-capture: OFF'
})
document.getElementById('flip')!.addEventListener('click', () => {
  mirror = !mirror
  const t = mirror ? 'scaleX(-1)' : 'none'
  video.style.transform = t
  still.style.transform = t
})
document.getElementById('cover')!.addEventListener('click', (e) => {
  coverEnabled = !coverEnabled
  const b = e.target as HTMLButtonElement
  b.textContent = coverEnabled ? 'Face-clear check: ON' : 'Face-clear check: OFF'
  b.classList.toggle('on', coverEnabled)
})

// --- Live mask-threshold tuning: mutate CFG in place, next frame picks it up ---
type TuneKey = keyof typeof CFG
const TUNE: { key: TuneKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'maskLipRednessRatio', label: 'Lip redness ratio', min: 0.7, max: 1.2, step: 0.01 },
  { key: 'maskColorDelta', label: 'Colour break (RGB dist)', min: 5, max: 70, step: 1 },
  { key: 'maskBlueShiftMin', label: 'Blue-shift min', min: 0, max: 0.08, step: 0.001 },
  { key: 'maskRedDropMin', label: 'Red-drop min', min: 0, max: 0.08, step: 0.001 },
  { key: 'maskBrightDelta', label: 'Brighter-than-cheek delta', min: 0, max: 40, step: 1 },
  { key: 'coverageConfirmFrames', label: 'Confirm frames', min: 1, max: 10, step: 1 },
  { key: 'coverageMinSkinLum', label: 'Min skin luma to judge', min: 10, max: 90, step: 1 },
]
const tuneRows = document.getElementById('tuneRows')!
const tuneDirty = document.getElementById('tuneDirty')!
const fmt = (n: number) => (n > 0 && n < 1 ? n.toFixed(3) : String(n))
function refreshDirty() {
  const d = TUNE.filter((f) => CFG[f.key] !== CFG_DEFAULTS[f.key]).length
  tuneDirty.textContent = d ? `(${d} changed)` : ''
}
for (const f of TUNE) {
  const row = document.createElement('div')
  row.className = 'row'
  const name = document.createElement('span')
  name.textContent = f.label
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(f.min)
  input.max = String(f.max)
  input.step = String(f.step)
  input.value = String(CFG[f.key])
  const val = document.createElement('span')
  val.className = 'val'
  val.textContent = fmt(CFG[f.key])
  input.addEventListener('input', () => {
    const v = Number(input.value)
    ;(CFG as Record<string, number>)[f.key] = v
    val.textContent = fmt(v)
    refreshDirty()
  })
  row.append(name, input, val)
  tuneRows.appendChild(row)
}
document.getElementById('tuneReset')!.addEventListener('click', () => {
  for (const f of TUNE) (CFG as Record<string, number>)[f.key] = CFG_DEFAULTS[f.key]
  tuneRows.querySelectorAll('input').forEach((inp, i) => {
    inp.value = String(CFG[TUNE[i].key])
    ;(inp.nextElementSibling as HTMLElement).textContent = fmt(CFG[TUNE[i].key])
  })
  refreshDirty()
})

async function main() {
  try {
    localStorage.setItem('faceCoverageDebug', '1') // enable [coverage] signal log
  } catch {
    /* ignore */
  }
  verdictEl.textContent = 'loading model…'
  await initFaceDetection()
  verdictEl.textContent = 'requesting camera…'
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 1280 } },
    audio: false,
  })
  video.srcObject = stream
  await video.play()
  verdictEl.textContent = 'running'
  requestAnimationFrame(tick)
}

main().catch((e) => {
  verdictEl.textContent = 'ERROR'
  verdictEl.className = 'big bad'
  panel.textContent = (e as Error).message + '\n' + (e as Error).stack
})
