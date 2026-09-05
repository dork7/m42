import { Camera, ImageUp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFlow } from '../../context/FlowContext'
import {
  detectFacesInImage,
  detectFacesInVideo,
  initFaceDetection,
} from '../../lib/faceDetection'
import {
  createValidationStabilizer,
  getPreviewDisplaySize,
  loadImageFromDataUrl,
  validateDetections,
  type FaceValidationResult,
  type FaceValidationStatus,
} from '../../lib/faceGuide'
import { FaceGuideOverlay } from '../FaceGuideOverlay'
import { Button } from '../ui/Button'

type Mode = 'choose' | 'camera' | 'preview'

const INITIAL_VALIDATION: FaceValidationResult = {
  status: 'no_face',
  message: "We can't see your face clearly",
}

const PORTRAIT_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: 'user',
    width: { ideal: 960 },
    height: { ideal: 1280 },
    aspectRatio: { ideal: 3 / 4 },
  },
  audio: false,
}

const FALLBACK_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'user' },
  audio: false,
}

const PREVIEW_CONTAINER_STYLE = {
  transform: 'translateZ(0)',
  contain: 'paint',
} as const

async function requestCameraStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(PORTRAIT_CAMERA_CONSTRAINTS)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia(FALLBACK_CAMERA_CONSTRAINTS)
    }
    throw error
  }
}

export function PhotoScreen() {
  const { photo, setPhoto, nextStep } = useFlow()
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastDetectRef = useRef(0)
  const containerSizeRef = useRef({ width: 0, height: 0 })
  const validationStatusRef = useRef<FaceValidationStatus>(INITIAL_VALIDATION.status)
  const stabilizerRef = useRef(createValidationStabilizer())

  const [mode, setMode] = useState<Mode>(photo ? 'preview' : 'choose')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [faceValidation, setFaceValidation] =
    useState<FaceValidationResult>(INITIAL_VALIDATION)
  const [detectorReady, setDetectorReady] = useState(false)
  const [isValidating, setIsValidating] = useState(false)

  const updateFaceValidation = useCallback((result: FaceValidationResult) => {
    if (result.status === validationStatusRef.current) return
    validationStatusRef.current = result.status
    setFaceValidation(result)
  }, [])

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    document.documentElement.classList.remove('camera-active')
  }, [])

  const validateImageDataUrl = useCallback(async (dataUrl: string) => {
    await initFaceDetection()
    const img = await loadImageFromDataUrl(dataUrl)
    const { displayW, displayH } = getPreviewDisplaySize()
    const detections = await detectFacesInImage(img)
    return validateDetections(
      detections,
      img.naturalWidth,
      img.naturalHeight,
      displayW,
      displayH,
    )
  }, [])

  useEffect(() => {
    initFaceDetection()
      .then(() => setDetectorReady(true))
      .catch(() => {
        setCameraError(
          'Face detection could not load. Refresh the page and try again.',
        )
      })
  }, [])

  useEffect(() => {
    return () => stopCamera()
  }, [stopCamera])

  useEffect(() => {
    const container = previewContainerRef.current
    if (!container) return

    const updateSize = () => {
      containerSizeRef.current = {
        width: container.clientWidth,
        height: container.clientHeight,
      }
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [mode, photo])

  useEffect(() => {
    if (mode !== 'camera') return

    document.documentElement.classList.add('camera-active')
    return () => {
      document.documentElement.classList.remove('camera-active')
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'camera' || !detectorReady) return

    stabilizerRef.current.reset()
    validationStatusRef.current = INITIAL_VALIDATION.status
    setFaceValidation(INITIAL_VALIDATION)

    const tick = (timestamp: number) => {
      const video = videoRef.current
      const { width: displayW, height: displayH } = containerSizeRef.current
      if (!video || displayW === 0 || displayH === 0 || video.videoWidth === 0) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      if (timestamp - lastDetectRef.current >= 100) {
        lastDetectRef.current = timestamp
        const detections = detectFacesInVideo(video, performance.now())
        const raw = validateDetections(
          detections,
          video.videoWidth,
          video.videoHeight,
          displayW,
          displayH,
          validationStatusRef.current,
        )
        const stabilized = stabilizerRef.current.update(raw)
        updateFaceValidation(stabilized)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [mode, detectorReady, updateFaceValidation])

  useEffect(() => {
    if (mode !== 'preview' || !photo || !detectorReady) return

    let cancelled = false
    setIsValidating(true)

    validateImageDataUrl(photo)
      .then((result) => {
        if (!cancelled) {
          validationStatusRef.current = result.status
          setFaceValidation(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          validationStatusRef.current = 'no_face'
          setFaceValidation({
            status: 'no_face',
            message: "We can't see your face clearly",
          })
        }
      })
      .finally(() => {
        if (!cancelled) setIsValidating(false)
      })

    return () => {
      cancelled = true
    }
  }, [mode, photo, detectorReady, validateImageDataUrl])

  const startCamera = async () => {
    stopCamera()
    setCameraError(null)
    stabilizerRef.current.reset()
    validationStatusRef.current = INITIAL_VALIDATION.status
    setFaceValidation(INITIAL_VALIDATION)
    setMode('camera')

    try {
      await initFaceDetection()
      setDetectorReady(true)
      const stream = await requestCameraStream()
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
    } catch {
      document.documentElement.classList.remove('camera-active')
      setCameraError(
        'Camera access is unavailable. Upload a photo instead.',
      )
      setMode('choose')
    }
  }

  const captureFrame = () => {
    if (faceValidation.status !== 'valid') return

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    stopCamera()
    setPhoto(dataUrl)
    setMode('preview')
  }

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !file.type.startsWith('image/')) return

    setIsValidating(true)
    setCameraError(null)

    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const dataUrl = reader.result as string
        const result = await validateImageDataUrl(dataUrl)

        if (result.status !== 'valid') {
          validationStatusRef.current = result.status
          setFaceValidation(result)
          setCameraError(result.message)
          setIsValidating(false)
          return
        }

        stopCamera()
        setPhoto(dataUrl)
        validationStatusRef.current = result.status
        setFaceValidation(result)
        setMode('preview')
      } catch {
        setCameraError('Upload failed. Pick a different image and try again.')
      } finally {
        setIsValidating(false)
      }
    }
    reader.onerror = () => {
      setCameraError('Upload failed. Pick a different image and try again.')
      setIsValidating(false)
    }
    reader.readAsDataURL(file)
  }

  const handleRetake = () => {
    setPhoto(null)
    setMode('choose')
    setCameraError(null)
    stabilizerRef.current.reset()
    validationStatusRef.current = INITIAL_VALIDATION.status
    setFaceValidation(INITIAL_VALIDATION)
  }

  const canCapture = faceValidation.status === 'valid' && detectorReady
  const canContinue =
    faceValidation.status === 'valid' && detectorReady && !isValidating

  if (mode === 'preview' && photo) {
    return (
      <div className="flex flex-col items-center">
        <h1 className="font-display text-[28px] font-bold leading-[1.15] text-ink md:text-[32px]">
          Time for your close-up
        </h1>
        <p className="mt-2 text-center text-base text-ink-muted">
          Natural light, no filters, face centered — this helps us read your
          skin accurately.
        </p>
        <div
          ref={previewContainerRef}
          className="relative mt-6 overflow-hidden rounded-frame border-2 shadow-berry-glow"
          style={{ ...PREVIEW_CONTAINER_STYLE, borderColor: 'var(--berry)' }}
        >
          <img
            src={photo}
            alt="Your uploaded face photo for skin analysis"
            className="aspect-[3/4] w-full max-w-[280px] object-cover"
          />
          <FaceGuideOverlay valid={faceValidation.status === 'valid'} />
        </div>
        <p
          className={`mt-3 text-center text-[13px] ${
            faceValidation.status === 'valid' ? 'text-ink-muted' : 'text-berry'
          }`}
          role={faceValidation.status === 'valid' ? undefined : 'alert'}
        >
          {isValidating ? 'Checking your photo...' : faceValidation.message}
        </p>
        <p className="mt-2 text-center text-[13px] text-ink-muted">
          Your photo stays private and isn&apos;t used to train anything.
        </p>
        <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
          <Button onClick={nextStep} disabled={!canContinue}>
            Continue
          </Button>
          <Button variant="secondary" onClick={handleRetake}>
            Retake
          </Button>
        </div>
      </div>
    )
  }

  if (mode === 'camera') {
    return (
      <div className="flex flex-col items-center">
        <h1 className="font-display text-[28px] font-bold leading-[1.15] text-ink md:text-[32px]">
          Time for your close-up
        </h1>
        <div
          ref={previewContainerRef}
          className="relative mt-6 w-full max-w-[280px] overflow-hidden rounded-frame"
          style={PREVIEW_CONTAINER_STYLE}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="aspect-[3/4] w-full object-cover"
          />
          <FaceGuideOverlay valid={faceValidation.status === 'valid'} />
        </div>
        <p
          className={`mt-3 text-[13px] ${
            faceValidation.status === 'valid' ? 'text-ink-muted' : 'text-berry'
          }`}
          role={faceValidation.status === 'valid' ? undefined : 'alert'}
        >
          {!detectorReady
            ? 'Loading face detection...'
            : faceValidation.message}
        </p>
        <canvas ref={canvasRef} className="hidden" />
        <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
          <Button onClick={captureFrame} disabled={!canCapture}>
            Take a photo
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              stopCamera()
              setMode('choose')
              stabilizerRef.current.reset()
              validationStatusRef.current = INITIAL_VALIDATION.status
              setFaceValidation(INITIAL_VALIDATION)
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center">
      <h1 className="font-display text-[28px] font-bold leading-[1.15] text-ink md:text-[32px]">
        Time for your close-up
      </h1>
      <p className="mt-2 text-center text-base text-ink-muted">
        Natural light, no filters, face centered — this helps us read your skin
        accurately.
      </p>

      {cameraError && (
        <p className="mt-4 text-center text-[13px] text-berry" role="alert">
          {cameraError}
        </p>
      )}

      {isValidating && (
        <p className="mt-4 text-center text-[13px] text-ink-muted">
          Checking your photo...
        </p>
      )}

      <div className="mt-6 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={startCamera}
          disabled={isValidating}
          className="focus-ring glass-panel flex flex-col items-center gap-3 rounded-panel p-6 transition-transform hover:scale-[1.01] disabled:opacity-60"
        >
          <Camera className="h-8 w-8 text-berry" aria-hidden="true" />
          <span className="text-base font-semibold text-ink">Take a photo</span>
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isValidating}
          className="focus-ring glass-panel flex flex-col items-center gap-3 rounded-panel p-6 transition-transform hover:scale-[1.01] disabled:opacity-60"
        >
          <ImageUp className="h-8 w-8 text-berry" aria-hidden="true" />
          <span className="text-base font-semibold text-ink">Upload a photo</span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileChange}
        aria-label="Upload a photo"
      />
    </div>
  )
}
