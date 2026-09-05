import { useFlow } from '../../context/FlowContext'
import type { Cause, Concern, Severity } from '../../types/flow'
import { GlassPanel } from '../ui/GlassPanel'

const severityOrder: Record<Severity, number> = {
  Noticeable: 0,
  Moderate: 1,
  Mild: 2,
}

const severityStyles: Record<Severity, string> = {
  Mild: 'bg-aloe/30 text-ink',
  Moderate: 'bg-peach/40 text-ink',
  Noticeable: 'bg-berry-soft text-berry',
}

function ScoreRing({ score }: { score: number }) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference

  return (
    <div className="relative flex h-36 w-36 items-center justify-center">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="var(--berry-soft)"
          strokeWidth="8"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="var(--berry)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="font-display text-[40px] font-bold leading-none text-ink">
          {score}
        </span>
        <span className="mt-1 text-[13px] text-ink-muted">Skin score</span>
      </div>
    </div>
  )
}

function ConcernCard({ concern }: { concern: Concern }) {
  return (
    <GlassPanel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">{concern.name}</h3>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-medium ${severityStyles[concern.severity]}`}
        >
          {concern.severity}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
        {concern.description}
      </p>
    </GlassPanel>
  )
}

function CauseCard({ cause }: { cause: Cause }) {
  return (
    <GlassPanel className="flex gap-3 p-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-peach/30 text-xl">
        {cause.icon}
      </div>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-ink">{cause.title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {cause.description}
        </p>
      </div>
    </GlassPanel>
  )
}

export function ResultsScreen() {
  const { photo, result, resetForRetake } = useFlow()

  if (!result) return null

  const sortedConcerns = [...result.concerns].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
  )

  return (
    <div className="flex flex-col">
      <h1 className="font-display text-[28px] font-bold leading-[1.15] text-ink md:text-[32px]">
        Here&apos;s what we found
      </h1>

      <div className="mt-6 flex items-center gap-5">
        <ScoreRing score={result.score} />
        <div className="flex flex-col gap-3">
          {photo && (
            <img
              src={photo}
              alt="Your analyzed photo thumbnail"
              className="h-20 w-20 rounded-panel object-cover shadow-glass"
            />
          )}
          <div>
            <p className="text-[13px] text-ink-muted">Skin type</p>
            <p className="mt-0.5 text-base font-semibold text-ink">
              {result.skinType}
            </p>
          </div>
        </div>
      </div>

      {sortedConcerns.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-xl font-bold text-ink">
            Your concerns
          </h2>
          <div className="mt-3 flex flex-col gap-3">
            {sortedConcerns.map((concern) => (
              <ConcernCard key={concern.name} concern={concern} />
            ))}
          </div>
        </section>
      )}

      {result.causes.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-xl font-bold text-ink">
            What might be causing this
          </h2>
          <div className="mt-3 flex flex-col gap-3">
            {result.causes.map((cause) => (
              <CauseCard key={cause.title} cause={cause} />
            ))}
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={resetForRetake}
        className="focus-ring mt-8 self-center text-[13px] text-ink-muted underline-offset-2 hover:underline"
      >
        Retake my scan
      </button>

      <p className="mt-6 text-center text-[13px] leading-relaxed text-ink-muted">
        This is guidance, not a medical diagnosis. See a dermatologist for any
        ongoing skin concerns.
      </p>
    </div>
  )
}
