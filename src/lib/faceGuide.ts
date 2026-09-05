import type { BoundingBox } from '@mediapipe/tasks-vision'

export type Rect = {
  x: number
  y: number
  w: number
  h: number
}

export type FaceValidationStatus =
  | 'no_face'
  | 'too_far'
  | 'too_close'
  | 'off_center'
  | 'valid'

export type FaceValidationResult = {
  status: FaceValidationStatus
  message: string
}

const MIN_SCORE = 0.5
const GUIDE_INSET = 0.78
const GUIDE_CENTER_PAD = 0.08

// Enter/exit bands to prevent flip-flopping at thresholds
const SIZE_ENTER = 0.16
const SIZE_EXIT = 0.12
const SIZE_MAX_ENTER = 0.95
const SIZE_MAX_EXIT = 1.05
const OVERLAP_ENTER = 0.65
const OVERLAP_EXIT = 0.55

const STABILIZER_FRAMES = 3

const STATUS_MESSAGES: Record<FaceValidationStatus, string> = {
  no_face: "We can't see your face clearly",
  too_far: 'Move a little closer',
  too_close: 'Move back a little',
  off_center: 'Center your face in the frame',
  valid: 'Looks good',
}

export function getObjectCoverTransform(
  sourceW: number,
  sourceH: number,
  displayW: number,
  displayH: number,
) {
  const sourceAspect = sourceW / sourceH
  const displayAspect = displayW / displayH

  if (sourceAspect > displayAspect) {
    const scale = displayH / sourceH
    return {
      scale,
      offsetX: (displayW - sourceW * scale) / 2,
      offsetY: 0,
    }
  }

  const scale = displayW / sourceW
  return {
    scale,
    offsetX: 0,
    offsetY: (displayH - sourceH * scale) / 2,
  }
}

export function mapBboxToDisplay(
  bbox: BoundingBox,
  transform: ReturnType<typeof getObjectCoverTransform>,
): Rect {
  return {
    x: bbox.originX * transform.scale + transform.offsetX,
    y: bbox.originY * transform.scale + transform.offsetY,
    w: bbox.width * transform.scale,
    h: bbox.height * transform.scale,
  }
}

export function getGuideRect(displayW: number, displayH: number): Rect {
  const size = Math.min(displayW, displayH) * GUIDE_INSET
  return {
    x: (displayW - size) / 2,
    y: (displayH - size) / 2,
    w: size,
    h: size,
  }
}

function intersectionArea(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return 0
  return (x2 - x1) * (y2 - y1)
}

function getPaddedGuideRect(guideRect: Rect): Rect {
  const padX = guideRect.w * GUIDE_CENTER_PAD
  const padY = guideRect.h * GUIDE_CENTER_PAD
  return {
    x: guideRect.x + padX,
    y: guideRect.y + padY,
    w: guideRect.w - padX * 2,
    h: guideRect.h - padY * 2,
  }
}

function isCenterInGuide(faceRect: Rect, guideRect: Rect): boolean {
  const padded = getPaddedGuideRect(guideRect)
  const faceCenterX = faceRect.x + faceRect.w / 2
  const faceCenterY = faceRect.y + faceRect.h / 2
  return (
    faceCenterX >= padded.x &&
    faceCenterX <= padded.x + padded.w &&
    faceCenterY >= padded.y &&
    faceCenterY <= padded.y + padded.h
  )
}

function resultForStatus(status: FaceValidationStatus): FaceValidationResult {
  return {
    status,
    message: STATUS_MESSAGES[status],
  }
}

function classifyFaceMetrics(
  faceRect: Rect,
  guideRect: Rect,
  previousStatus: FaceValidationStatus | null,
): FaceValidationStatus {
  const faceArea = faceRect.w * faceRect.h
  const guideArea = guideRect.w * guideRect.h
  const overlap = intersectionArea(faceRect, guideRect)
  const overlapRatio = overlap / faceArea
  const faceToGuideRatio = faceArea / guideArea
  const centerInGuide = isCenterInGuide(faceRect, guideRect)

  const wasValid = previousStatus === 'valid'

  const minSize = wasValid ? SIZE_EXIT : SIZE_ENTER
  const maxSize = wasValid ? SIZE_MAX_EXIT : SIZE_MAX_ENTER
  const minOverlap = wasValid ? OVERLAP_EXIT : OVERLAP_ENTER

  if (faceToGuideRatio < minSize) {
    return 'too_far'
  }

  if (faceToGuideRatio > maxSize) {
    return 'too_close'
  }

  if (!centerInGuide || overlapRatio < minOverlap) {
    return 'off_center'
  }

  return 'valid'
}

export function validateFaceInGuide(
  faceRect: Rect | null,
  guideRect: Rect,
  previousStatus: FaceValidationStatus | null = null,
): FaceValidationResult {
  if (!faceRect) {
    return resultForStatus('no_face')
  }

  const status = classifyFaceMetrics(faceRect, guideRect, previousStatus)
  return resultForStatus(status)
}

type DetectionLike = {
  boundingBox?: BoundingBox
  categories: { score: number }[]
}

export function validateDetections(
  detections: DetectionLike[],
  sourceW: number,
  sourceH: number,
  displayW: number,
  displayH: number,
  previousStatus: FaceValidationStatus | null = null,
): FaceValidationResult {
  const transform = getObjectCoverTransform(sourceW, sourceH, displayW, displayH)
  const guide = getGuideRect(displayW, displayH)

  const usable = detections.filter(
    (d) => d.boundingBox && (d.categories[0]?.score ?? 0) >= MIN_SCORE,
  )

  if (usable.length === 0) {
    return validateFaceInGuide(null, guide, previousStatus)
  }

  let best = usable[0]
  let bestArea = 0
  for (const detection of usable) {
    const box = detection.boundingBox!
    const area = box.width * box.height
    if (area > bestArea) {
      bestArea = area
      best = detection
    }
  }

  const faceRect = mapBboxToDisplay(best.boundingBox!, transform)
  return validateFaceInGuide(faceRect, guide, previousStatus)
}

export function createValidationStabilizer(requiredFrames = STABILIZER_FRAMES) {
  let stableStatus: FaceValidationStatus | null = null
  let pendingStatus: FaceValidationStatus | null = null
  let pendingCount = 0

  return {
    update(raw: FaceValidationResult): FaceValidationResult {
      if (raw.status === stableStatus) {
        pendingStatus = null
        pendingCount = 0
        return resultForStatus(stableStatus!)
      }

      if (raw.status === pendingStatus) {
        pendingCount += 1
      } else {
        pendingStatus = raw.status
        pendingCount = 1
      }

      if (stableStatus === null || pendingCount >= requiredFrames) {
        stableStatus = raw.status
        pendingStatus = null
        pendingCount = 0
        return resultForStatus(stableStatus)
      }

      return resultForStatus(stableStatus ?? raw.status)
    },
    reset() {
      stableStatus = null
      pendingStatus = null
      pendingCount = 0
    },
  }
}

export const PREVIEW_DISPLAY_WIDTH = 280

export function getPreviewDisplaySize() {
  const displayW = PREVIEW_DISPLAY_WIDTH
  const displayH = (displayW * 4) / 3
  return { displayW, displayH }
}

export async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = dataUrl
  })
}
