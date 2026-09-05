const MARKER_DOTS = [
  { top: '30%', left: '34%', delay: 0.3 },
  { top: '46%', left: '63%', delay: 0.8 },
  { top: '60%', left: '43%', delay: 1.3 },
]

/**
 * A scanning sweep + pulsing markers, layered over a framed face image while a
 * photo is being validated. Matches the AnalyzingScreen motion language and
 * respects `prefers-reduced-motion` via the shared .scan-line / .marker-dot
 * classes in index.css.
 */
export function ScanningOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <div className="absolute inset-0 bg-black/10" />
      <div
        className="scan-line absolute left-0 right-0 h-10"
        style={{
          background:
            'linear-gradient(180deg, transparent, var(--berry), var(--lilac), transparent)',
          filter: 'blur(4px)',
          animation: 'scan-sweep 2.2s ease-in-out infinite',
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
  )
}

/** Inline indeterminate progress bar + label for the choose/upload screen. */
export function ValidatingBar({ label = 'Checking your photo…' }: { label?: string }) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <p className="text-[13px] text-ink-muted" aria-live="polite">
        {label}
      </p>
      <div className="h-1 w-full max-w-[200px] overflow-hidden rounded-full bg-berry/15">
        <div
          className="indeterminate-bar h-full w-1/3 rounded-full bg-gradient-to-r from-berry to-lilac"
          style={{ animation: 'indeterminate 1.8s ease-in-out infinite' }}
        />
      </div>
    </div>
  )
}
