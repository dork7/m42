// Temporary LIVE test harness for the guided face-capture feature.
// Runs the exact production pipeline (faceDetection.ts + faceGuide.ts) against
// the webcam, shows every check value, and auto-captures on the same
// CFG.captureHold streak the real PhotoScreen uses.
// Delete along with __livetest.html when done.
import { detectFaceInVideo, initFaceDetection } from './lib/faceDetection'
import {
  CFG,
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
      coverage: `${coverage.kind} / ${evaln.coverage.label}`,
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

async function main() {
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
