import {
  FaceDetector,
  FilesetResolver,
  type Detection,
} from '@mediapipe/tasks-vision'

const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

let visionResolver: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null =
  null
let videoDetector: FaceDetector | null = null
let imageDetector: FaceDetector | null = null
let imageDetectorPromise: Promise<FaceDetector> | null = null
let videoLoadingPromise: Promise<void> | null = null
let videoNeedsReinit = false

async function getVisionResolver() {
  if (!visionResolver) {
    visionResolver = await FilesetResolver.forVisionTasks(WASM_URL)
  }
  return visionResolver
}

async function createDetector(
  runningMode: 'VIDEO' | 'IMAGE',
  delegate: 'GPU' | 'CPU',
): Promise<FaceDetector> {
  const vision = await getVisionResolver()
  return FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate,
    },
    runningMode,
    minDetectionConfidence: 0.5,
  })
}

async function createDetectorWithFallback(
  runningMode: 'VIDEO' | 'IMAGE',
): Promise<FaceDetector> {
  try {
    return await createDetector(runningMode, 'GPU')
  } catch {
    return createDetector(runningMode, 'CPU')
  }
}

async function ensureVideoDetector() {
  if (videoDetector && !videoNeedsReinit) return

  if (!videoLoadingPromise) {
    videoLoadingPromise = (async () => {
      videoDetector = await createDetectorWithFallback('VIDEO')
      videoNeedsReinit = false
    })().finally(() => {
      videoLoadingPromise = null
    })
  }

  await videoLoadingPromise
}

async function ensureImageDetector() {
  if (imageDetector) return imageDetector

  if (!imageDetectorPromise) {
    imageDetectorPromise = createDetectorWithFallback('IMAGE').finally(() => {
      imageDetectorPromise = null
    })
  }

  imageDetector = await imageDetectorPromise
  return imageDetector
}

export async function initFaceDetection() {
  await ensureVideoDetector()
}

export function detectFacesInVideo(
  video: HTMLVideoElement,
  timestamp: number,
): Detection[] {
  if (!videoDetector || video.videoWidth === 0 || video.videoHeight === 0) {
    return []
  }

  try {
    return videoDetector.detectForVideo(video, timestamp).detections
  } catch {
    videoNeedsReinit = true
    videoDetector = null
    return []
  }
}

export async function detectFacesInImage(
  source: HTMLImageElement | HTMLCanvasElement,
): Promise<Detection[]> {
  const detector = await ensureImageDetector()
  try {
    return detector.detect(source).detections
  } catch {
    imageDetector = null
    const retryDetector = await ensureImageDetector()
    return retryDetector.detect(source).detections
  }
}
