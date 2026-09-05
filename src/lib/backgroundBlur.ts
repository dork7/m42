import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision'

// Self-hosted assets — same wasm fileset as the face landmarker, no CDN.
const WASM_PATH = `${import.meta.env.BASE_URL}vendor/mediapipe/wasm`
const MODEL_PATH = `${import.meta.env.BASE_URL}models/selfie_segmenter.tflite`

export const BLUR_RADIUS_PX = 14

let visionResolver: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null =
  null
let videoSegmenter: ImageSegmenter | null = null
let imageSegmenter: ImageSegmenter | null = null
let videoPromise: Promise<ImageSegmenter> | null = null
let imagePromise: Promise<ImageSegmenter> | null = null

async function getVisionResolver() {
  if (!visionResolver) {
    visionResolver = await FilesetResolver.forVisionTasks(WASM_PATH)
  }
  return visionResolver
}

async function createSegmenter(
  runningMode: 'VIDEO' | 'IMAGE',
  delegate: 'GPU' | 'CPU',
): Promise<ImageSegmenter> {
  const vision = await getVisionResolver()
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode,
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  })
}

async function createWithFallback(
  runningMode: 'VIDEO' | 'IMAGE',
): Promise<ImageSegmenter> {
  try {
    return await createSegmenter(runningMode, 'GPU')
  } catch {
    return createSegmenter(runningMode, 'CPU')
  }
}

export async function initBackgroundBlur() {
  if (videoSegmenter) return
  if (!videoPromise) {
    videoPromise = createWithFallback('VIDEO')
  }
  videoSegmenter = await videoPromise
}

async function ensureImageSegmenter() {
  if (imageSegmenter) return imageSegmenter
  if (!imagePromise) imagePromise = createWithFallback('IMAGE')
  imageSegmenter = await imagePromise
  return imageSegmenter
}

/**
 * A reusable offscreen canvas holding the current person mask as an alpha
 * channel (white RGB, alpha = person confidence). Compositing with
 * `destination-in` then cuts a source frame down to the person.
 */
export function createMaskCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

function writeMaskToCanvas(
  mask: Float32Array,
  maskW: number,
  maskH: number,
  maskCanvas: HTMLCanvasElement,
) {
  if (maskCanvas.width !== maskW || maskCanvas.height !== maskH) {
    maskCanvas.width = maskW
    maskCanvas.height = maskH
  }
  const ctx = maskCanvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(maskW, maskH)
  const data = img.data
  for (let i = 0; i < mask.length; i += 1) {
    const o = i * 4
    data[o] = 255
    data[o + 1] = 255
    data[o + 2] = 255
    data[o + 3] = Math.round(Math.min(1, Math.max(0, mask[i])) * 255)
  }
  ctx.putImageData(img, 0, 0)
}

/** Runs video segmentation and updates `maskCanvas` in place. */
export function updateVideoMask(
  video: HTMLVideoElement,
  timestamp: number,
  maskCanvas: HTMLCanvasElement,
): boolean {
  if (!videoSegmenter || video.videoWidth === 0) return false
  try {
    const result = videoSegmenter.segmentForVideo(video, timestamp)
    const mask = result.confidenceMasks?.[0]
    if (!mask) return false
    writeMaskToCanvas(mask.getAsFloat32Array(), mask.width, mask.height, maskCanvas)
    mask.close()
    return true
  } catch {
    return false
  }
}

/**
 * Composites a background-blurred frame with the sharp person on top, into
 * `outCtx`. `maskCanvas` must already hold a person mask (see updateVideoMask).
 * `scratch` is a reusable canvas for the person cut-out.
 */
export function drawBlurredComposite(
  source: CanvasImageSource,
  width: number,
  height: number,
  maskCanvas: HTMLCanvasElement,
  outCtx: CanvasRenderingContext2D,
  scratchCtx: CanvasRenderingContext2D,
) {
  const { canvas: out } = outCtx
  const { canvas: scratch } = scratchCtx
  if (out.width !== width || out.height !== height) {
    out.width = width
    out.height = height
  }
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width
    scratch.height = height
  }

  // 1. Blurred background fills the frame.
  outCtx.save()
  outCtx.filter = `blur(${BLUR_RADIUS_PX}px)`
  outCtx.drawImage(source, 0, 0, width, height)
  outCtx.restore()

  // 2. Sharp person cut-out via the mask alpha.
  scratchCtx.clearRect(0, 0, width, height)
  scratchCtx.drawImage(source, 0, 0, width, height)
  scratchCtx.save()
  scratchCtx.globalCompositeOperation = 'destination-in'
  scratchCtx.imageSmoothingEnabled = true
  scratchCtx.drawImage(maskCanvas, 0, 0, width, height)
  scratchCtx.restore()

  // 3. Person over blurred background.
  outCtx.drawImage(scratch, 0, 0, width, height)
}

/**
 * One-shot: returns a new canvas with the background blurred behind the person.
 * Used for still images (captured frame or upload).
 */
export async function blurImageBackground(
  source: HTMLImageElement | HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const segmenter = await ensureImageSegmenter()
  const width =
    'naturalWidth' in source ? source.naturalWidth : source.width
  const height =
    'naturalHeight' in source ? source.naturalHeight : source.height

  const result = segmenter.segment(source)
  const mask = result.confidenceMasks?.[0]
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const outCtx = out.getContext('2d')!

  if (!mask) {
    outCtx.drawImage(source, 0, 0, width, height)
    return out
  }

  const maskCanvas = createMaskCanvas()
  writeMaskToCanvas(mask.getAsFloat32Array(), mask.width, mask.height, maskCanvas)
  mask.close()

  const scratch = document.createElement('canvas')
  drawBlurredComposite(
    source,
    width,
    height,
    maskCanvas,
    outCtx,
    scratch.getContext('2d')!,
  )
  return out
}
