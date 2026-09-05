import { useEffect, useState } from 'react'
import { analyzeSkin } from '../../api/analyzeSkin'
import { useFlow } from '../../context/FlowContext'
import { Button } from '../ui/Button'

const STATUS_MESSAGES = [
  'Reading texture...',
  'Checking tone evenness...',
  'Mapping concerns...',
  'Putting it together...',
]

const MARKER_DOTS = [
  { top: '28%', left: '35%', delay: 0.5 },
  { top: '45%', left: '62%', delay: 1.0 },
  { top: '58%', left: '42%', delay: 1.5 },
]

export function AnalyzingScreen() {
  const { photo, answers, setResult, nextStep } = useFlow()
  const [statusIndex, setStatusIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_MESSAGES.length)
    }, 1800)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!photo) return

    let cancelled = false
    const startTime = Date.now()
    const minDisplay = 3000

    const run = async () => {
      try {
        setError(null)
        const result = await analyzeSkin(photo, answers)
        const elapsed = Date.now() - startTime
        const remaining = Math.max(0, minDisplay - elapsed)

        if (!cancelled) {
          setTimeout(() => {
            if (!cancelled) {
              setResult(result)
              nextStep()
            }
          }, remaining)
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Analysis failed. Try again in a moment.',
          )
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [photo, answers, setResult, nextStep, retryKey])

  const handleRetry = () => {
    setRetryKey((k) => k + 1)
  }

  if (!photo) return null

  return (
    <div className="flex flex-col items-center">
      <div className="relative overflow-hidden rounded-frame">
        <img
          src={photo}
          alt="Your photo being analyzed"
          className="aspect-[3/4] w-full max-w-[280px] object-cover"
        />

        <div
          className="scan-line pointer-events-none absolute left-0 right-0 h-10"
          style={{
            background:
              'linear-gradient(180deg, transparent, var(--berry), var(--lilac), transparent)',
            filter: 'blur(4px)',
            animation: 'scan-sweep 2.5s ease-in-out infinite',
          }}
        />

        {MARKER_DOTS.map((dot, i) => (
          <div
            key={i}
            className="marker-dot absolute h-3 w-3 rounded-full"
            style={{
              top: dot.top,
              left: dot.left,
              background: 'var(--berry)',
              boxShadow: '0 0 12px var(--berry)',
              animation: `pulse-dot 1.5s ease-in-out ${dot.delay}s infinite`,
            }}
          />
        ))}
      </div>

      <p
        className="mt-6 text-base text-ink"
        aria-live="polite"
        aria-atomic="true"
      >
        {error ?? STATUS_MESSAGES[statusIndex]}
      </p>

      {!error && (
        <div className="mt-4 h-1 w-full max-w-[200px] overflow-hidden rounded-full bg-berry/15">
          <div
            className="indeterminate-bar h-full w-1/3 rounded-full bg-gradient-to-r from-berry to-lilac"
            style={{ animation: 'indeterminate 1.8s ease-in-out infinite' }}
          />
        </div>
      )}

      {error && (
        <Button className="mt-6" onClick={handleRetry}>
          Try again
        </Button>
      )}

      {!error && (
        <p className="mt-4 text-[13px] text-ink-muted">
          Usually takes about 15 seconds.
        </p>
      )}
    </div>
  )
}
