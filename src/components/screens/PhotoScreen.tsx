import { AlertTriangle, Camera, ImageUp, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFlow } from '../../context/FlowContext'
import {
  blurImageBackground,
  createMaskCanvas,
  drawBlurredComposite,
  initBackgroundBlur,
  updateVideoMask,
} from '../../lib/backgroundBlur'
import {
  detectFaceInImage,
  detectFaceInVideo,
  initFaceDetection,
} from '../../lib/faceDetection'
import {
  CFG,
  createSampleCanvasCtx,
  evaluateCoverage,
  evaluateFace,
  faceBoxFromLandmarks,
  loadImageFromDataUrl,
  sampleFaceBrightness,
  sampleFaceSharpness,
  UNKNOWN_COVERAGE,
  type CoverageResult,
  type FaceEvaluation,
} from '../../lib/faceGuide'
import { FaceGuideOverlay } from '../FaceGuideOverlay'
import { FaceStatusChips } from '../FaceStatusChips'
import { ScanningOverlay, ValidatingBar } from '../ScanningOverlay'
import { Button } from '../ui/Button'

type Mode = 'choose' | 'camera' | 'preview'

const INITIAL_EVALUATION: FaceEvaluation = {
  faceFound: false,
  light: { level: 'warn', label: '—' },
  pose: { level: 'bad', label: 'No Face' },
  position: { level: 'bad', label: 'No Face' },
  coverage: { level: 'bad', label: 'No Face' },
  status: 'no_face',
  allGood: false,
  message: 'Position your face in the circle',
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
  const capturedRef = useRef(false)
  const sampleCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const evalStatusRef = useRef<string>(INITIAL_EVALUATION.status)
  const coverageStableRef = useRef<CoverageResult>(UNKNOWN_COVERAGE)
  const coveragePendingRef = useRef<{ ok: boolean; count: number }>({
    ok: UNKNOWN_COVERAGE.ok,
    count: 0,
  })
  const blurCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const scratchCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const hasMaskRef = useRef(false)
  const blurOnRef = useRef(false)
  const blurReadyRef = useRef(false)

  const [mode, setMode] = useState<Mode>(photo ? 'preview' : 'choose')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [faceEval, setFaceEval] = useState<FaceEvaluation>(INITIAL_EVALUATION)
  const [detectorReady, setDetectorReady] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [blurBackground, setBlurBackground] = useState(false)
  const [blurLoading, setBlurLoading] = useState(false)

  const getSampleCtx = useCallback(() => {
    if (!sampleCtxRef.current) sampleCtxRef.current = createSampleCanvasCtx()
    return sampleCtxRef.current
  }, [])

  const getMaskCanvas = useCallback(() => {
    if (!maskCanvasRef.current) maskCanvasRef.current = createMaskCanvas()
    return maskCanvasRef.current
  }, [])

  const getScratchCtx = useCallback(() => {
    if (!scratchCtxRef.current) {
      scratchCtxRef.current = document.createElement('canvas').getContext('2d')
    }
    return scratchCtxRef.current
  }, [])

  const resetCoverage = useCallback(() => {
    coverageStableRef.current = UNKNOWN_COVERAGE
    coveragePendingRef.current = { ok: UNKNOWN_COVERAGE.ok, count: 0 }
  }, [])

  // Debounce the covered / not-covered flip: it must hold for
  // CFG.coverageConfirmFrames consecutive frames before the chip changes, so a
  // single noisy frame doesn't flicker it. While covered, a change of covering
  // type (glasses <-> mask) is adopted immediately.
  const confirmCoverage = useCallback((raw: CoverageResult): CoverageResult => {
    const stable = coverageStableRef.current
    if (raw.ok === stable.ok) {
      coverageStableRef.current = raw
      coveragePendingRef.current.count = 0
      return raw
    }
    const pending = coveragePendingRef.current
    pending.count = pending.ok === raw.ok ? pending.count + 1 : 1
    pending.ok = raw.ok
    if (pending.count >= CFG.coverageConfirmFrames) {
      coverageStableRef.current = raw
      pending.count = 0
    }
    return coverageStableRef.current
  }, [])

  useEffect(() => {
    blurOnRef.current = blurBackground
    if (!blurBackground) hasMaskRef.current = false
  }, [blurBackground])

  useEffect(() => {
    if (!blurBackground || blurReadyRef.current) return
    setBlurLoading(true)
    initBackgroundBlur()
      .then(() => {
        blurReadyRef.current = true
      })
      .catch(() => {
        setCameraError('Background blur could not load.')
        setBlurBackground(false)
      })
      .finally(() => setBlurLoading(false))
  }, [blurBackground])

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

  const resetTracking = useCallback(() => {
    capturedRef.current = false
    evalStatusRef.current = INITIAL_EVALUATION.status
    resetCoverage()
    setFaceEval(INITIAL_EVALUATION)
  }, [resetCoverage])

  const captureFromVideo = useCallback(async () => {
    if (capturedRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return

    capturedRef.current = true
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Un-mirror so the saved image matches real orientation (the live
    // <video> is mirrored via CSS for a natural selfie preview).
    ctx.save()
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, w, h)
    ctx.restore()

    let output: HTMLCanvasElement = canvas
    if (blurOnRef.current && blurReadyRef.current) {
      try {
        output = await blurImageBackground(canvas)
      } catch {
        output = canvas
      }
    }

    const dataUrl = output.toDataURL('image/jpeg', 0.9)
    stopCamera()
    setPhoto(dataUrl)
    setMode('preview')
  }, [setPhoto, stopCamera])

  const validateImageDataUrl = useCallback(
    async (dataUrl: string): Promise<FaceEvaluation> => {
      await initFaceDetection()
      const img = await loadImageFromDataUrl(dataUrl)
      const result = await detectFaceInImage(img)
      const landmarks = result.faceLandmarks?.[0]
      let brightness: number | null = null
      let sharpness: number | null = null
      let coverage: CoverageResult = UNKNOWN_COVERAGE
      if (landmarks && landmarks.length > 0) {
        const box = faceBoxFromLandmarks(landmarks)
        try {
          brightness = sampleFaceBrightness(
            img,
            img.naturalWidth,
            img.naturalHeight,
            box,
            getSampleCtx(),
          )
          sharpness = sampleFaceSharpness(
            img,
            img.naturalWidth,
            img.naturalHeight,
            box,
            getSampleCtx(),
          )
          coverage = evaluateCoverage(
            landmarks,
            img,
            img.naturalWidth,
            img.naturalHeight,
            getSampleCtx(),
          )
        } catch {
          brightness = null
        }
      }
      return evaluateFace(
        result,
        brightness,
        coverage,
        { w: img.naturalWidth, h: img.naturalHeight },
        sharpness,
      )
    },
    [getSampleCtx],
  )

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
    if (mode !== 'camera') return
    document.documentElement.classList.add('camera-active')
    return () => {
      document.documentElement.classList.remove('camera-active')
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'camera' || !detectorReady) return

    resetTracking()

    const tick = (timestamp: number) => {
      const video = videoRef.current
      if (!video || video.videoWidth === 0 || capturedRef.current) {
        if (!capturedRef.current) rafRef.current = requestAnimationFrame(tick)
        return
      }

      const blurActive = blurOnRef.current && blurReadyRef.current

      if (timestamp - lastDetectRef.current >= 90) {
        lastDetectRef.current = timestamp

        if (blurActive) {
          if (updateVideoMask(video, performance.now(), getMaskCanvas())) {
            hasMaskRef.current = true
          }
        }

        const result = detectFaceInVideo(video, performance.now())
        const landmarks = result.faceLandmarks?.[0]
        let brightness: number | null = null
        let coverage: CoverageResult = UNKNOWN_COVERAGE
        if (landmarks && landmarks.length > 0) {
          const box = faceBoxFromLandmarks(landmarks)
          try {
            brightness = sampleFaceBrightness(
              video,
              video.videoWidth,
              video.videoHeight,
              box,
              getSampleCtx(),
            )
          } catch {
            brightness = null
          }
          try {
            coverage = confirmCoverage(
              evaluateCoverage(
                landmarks,
                video,
                video.videoWidth,
                video.videoHeight,
                getSampleCtx(),
              ),
            )
          } catch (err) {
            try {
              if (localStorage.getItem('faceCoverageDebug') === '1') {
                console.error('[coverage] error', err)
              }
            } catch {
              /* ignore */
            }
          }
        } else {
          resetCoverage()
        }

        const next = evaluateFace(result, brightness, coverage, {
          w: video.videoWidth,
          h: video.videoHeight,
        })

        // Only re-render when a chip label or the status actually changes.
        const signature = `${next.status}|${next.light.label}|${next.pose.label}|${next.position.label}|${next.coverage.label}`
        if (signature !== evalStatusRef.current) {
          evalStatusRef.current = signature
          setFaceEval(next)
        }
      }

      const blurCtx = blurCanvasRef.current?.getContext('2d')
      const scratchCtx = getScratchCtx()
      if (blurActive && hasMaskRef.current && blurCtx && scratchCtx) {
        drawBlurredComposite(
          video,
          video.videoWidth,
          video.videoHeight,
          getMaskCanvas(),
          blurCtx,
          scratchCtx,
        )
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, detectorReady])

  useEffect(() => {
    if (mode !== 'preview' || !photo || !detectorReady) return

    let cancelled = false
    setIsValidating(true)

    validateImageDataUrl(photo)
      .then((result) => {
        if (!cancelled) {
          evalStatusRef.current = result.status
          setFaceEval(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          evalStatusRef.current = 'no_face'
          setFaceEval(INITIAL_EVALUATION)
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
    resetTracking()
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
      setCameraError('Camera access is unavailable. Upload a photo instead.')
      setMode('choose')
    }
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

        if (!result.allGood) {
          evalStatusRef.current = result.status
          setFaceEval(result)
          setCameraError(
            result.faceFound
              ? result.message
              : "We can't see your face clearly. Try a different photo.",
          )
          setIsValidating(false)
          return
        }

        stopCamera()
        setPhoto(dataUrl)
        evalStatusRef.current = result.status
        setFaceEval(result)
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
    resetTracking()
  }

  const canContinue = faceEval.allGood && detectorReady && !isValidating
  const photoRejected = !isValidating && detectorReady && !faceEval.allGood
  const rejectReason = faceEval.faceFound
    ? faceEval.message
    : "We can't find your face clearly in this photo."

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
        {faceEval.faceFound && (
          <FaceStatusChips
            className="mt-6"
            light={faceEval.light}
            pose={faceEval.pose}
            position={faceEval.position}
            coverage={faceEval.coverage}
          />
        )}
        <div
          ref={previewContainerRef}
          className={`relative overflow-hidden rounded-frame border-2 shadow-berry-glow ${
            faceEval.faceFound ? 'mt-3' : 'mt-6'
          }`}
          style={{ ...PREVIEW_CONTAINER_STYLE, borderColor: 'var(--berry)' }}
        >
          <img
            src={photo}
            alt="Your uploaded face photo for skin analysis"
            className="aspect-[3/4] w-full max-w-[280px] object-cover"
          />
          <FaceGuideOverlay valid={faceEval.allGood} />
          {isValidating && <ScanningOverlay />}
        </div>
        {isValidating ? (
          <ValidatingBar label="Checking your photo…" />
        ) : photoRejected ? (
          <div
            className="mt-3 w-full max-w-[280px] rounded-panel border border-berry/30 bg-berry-soft/50 p-3 text-center"
            role="alert"
          >
            <div className="flex items-center justify-center gap-1.5 text-[13px] font-semibold text-berry">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              This photo isn&apos;t clear enough
            </div>
            <p className="mt-1 text-[13px] text-ink-muted">{rejectReason}</p>
          </div>
        ) : (
          <p className="mt-3 text-center text-[13px] text-ink-muted">
            {faceEval.message}
          </p>
        )}
        <p className="mt-2 text-center text-[13px] text-ink-muted">
          Your photo stays private and isn&apos;t used to train anything.
        </p>
        <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
          {photoRejected ? (
            <>
              <Button onClick={handleRetake}>Retake photo</Button>
              <Button variant="secondary" onClick={nextStep} disabled>
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button onClick={nextStep} disabled={!canContinue}>
                Continue
              </Button>
              <Button variant="secondary" onClick={handleRetake}>
                Retake
              </Button>
            </>
          )}
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
        <FaceStatusChips
          className="mt-6"
          light={faceEval.light}
          pose={faceEval.pose}
          position={faceEval.position}
          coverage={faceEval.coverage}
        />
        <div
          ref={previewContainerRef}
          className="relative mt-3 w-full max-w-[280px] overflow-hidden rounded-frame"
          style={PREVIEW_CONTAINER_STYLE}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="aspect-[3/4] w-full -scale-x-100 object-cover"
          />
          <canvas
            ref={blurCanvasRef}
            aria-hidden="true"
            className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${
              blurBackground ? '' : 'hidden'
            }`}
          />
          <FaceGuideOverlay valid={faceEval.allGood} />
        </div>
        <p
          className={`mt-3 text-[13px] ${
            faceEval.allGood ? 'text-ink-muted' : 'text-berry'
          }`}
          role={faceEval.allGood ? undefined : 'alert'}
        >
          {!detectorReady ? 'Loading face detection...' : faceEval.message}
        </p>
        <canvas ref={canvasRef} className="hidden" />
        <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
          <button
            type="button"
            onClick={() => setBlurBackground((v) => !v)}
            aria-pressed={blurBackground}
            className={`focus-ring flex items-center justify-center gap-2 rounded-btn px-4 py-2.5 text-[14px] font-semibold transition-colors ${
              blurBackground
                ? 'border-[1.5px] border-berry bg-berry-soft text-berry'
                : 'border border-transparent bg-surface/60 text-ink hover:bg-surface/90'
            }`}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {blurLoading
              ? 'Loading blur…'
              : blurBackground
                ? 'Background blur: On'
                : 'Blur background'}
          </button>
          <Button onClick={captureFromVideo}>
            Take a photo
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              stopCamera()
              setMode('choose')
              resetTracking()
            }}
          >
            Cancel
          </Button>
        </div>
        <p className="mt-3 text-center text-[12px] text-ink-muted">
          Framing &amp; coverage guidance only — not a liveness check.
        </p>
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

      {isValidating && <ValidatingBar />}

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
