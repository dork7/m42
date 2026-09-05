import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from '@mediapipe/tasks-vision'

// Self-hosted assets — served from our own origin, no CDN at runtime.
// The wasm folder is copied from node_modules by the `postinstall` script;
// face_landmarker.task is committed under public/models/.
const WASM_PATH = `${import.meta.env.BASE_URL}vendor/mediapipe/wasm`
const MODEL_PATH = `${import.meta.env.BASE_URL}models/face_landmarker.task`

let visionResolver: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null =
  null
let videoLandmarker: FaceLandmarker | null = null
let imageLandmarker: FaceLandmarker | null = null
let imageLandmarkerPromise: Promise<FaceLandmarker> | null = null
let videoLoadingPromise: Promise<void> | null = null
let videoNeedsReinit = false

async function getVisionResolver() {
  if (!visionResolver) {
    visionResolver = await FilesetResolver.forVisionTasks(WASM_PATH)
  }
  return visionResolver
}

async function createLandmarker(
  runningMode: 'VIDEO' | 'IMAGE',
  delegate: 'GPU' | 'CPU',
): Promise<FaceLandmarker> {
  const vision = await getVisionResolver()
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
      delegate,
    },
    runningMode,
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFacialTransformationMatrixes: true,
  })
}

async function createLandmarkerWithFallback(
  runningMode: 'VIDEO' | 'IMAGE',
): Promise<FaceLandmarker> {
  try {
    return await createLandmarker(runningMode, 'GPU')
  } catch {
    return createLandmarker(runningMode, 'CPU')
  }
}

async function ensureVideoLandmarker() {
  if (videoLandmarker && !videoNeedsReinit) return

  if (!videoLoadingPromise) {
    videoLoadingPromise = (async () => {
      videoLandmarker = await createLandmarkerWithFallback('VIDEO')
      videoNeedsReinit = false
    })().finally(() => {
      videoLoadingPromise = null
    })
  }

  await videoLoadingPromise
}

async function ensureImageLandmarker() {
  if (imageLandmarker) return imageLandmarker

  if (!imageLandmarkerPromise) {
    imageLandmarkerPromise = createLandmarkerWithFallback('IMAGE').finally(() => {
      imageLandmarkerPromise = null
    })
  }

  imageLandmarker = await imageLandmarkerPromise
  return imageLandmarker
}

export async function initFaceDetection() {
  await ensureVideoLandmarker()
}

const EMPTY_RESULT: FaceLandmarkerResult = {
  faceLandmarks: [],
  faceBlendshapes: [],
  facialTransformationMatrixes: [],
}

export function detectFaceInVideo(
  video: HTMLVideoElement,
  timestamp: number,
): FaceLandmarkerResult {
  if (!videoLandmarker || video.videoWidth === 0 || video.videoHeight === 0) {
    return EMPTY_RESULT
  }

  try {
    return videoLandmarker.detectForVideo(video, timestamp)
  } catch {
    videoNeedsReinit = true
    videoLandmarker = null
    return EMPTY_RESULT
  }
}

export async function detectFaceInImage(
  source: HTMLImageElement | HTMLCanvasElement,
): Promise<FaceLandmarkerResult> {
  const landmarker = await ensureImageLandmarker()
  try {
    return landmarker.detect(source)
  } catch {
    imageLandmarker = null
    const retry = await ensureImageLandmarker()
    return retry.detect(source)
  }
}
