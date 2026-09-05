import { Button } from '../ui/Button'
import { useFlow } from '../../context/FlowContext'

function HeroFace() {
  const dots = [
    { cx: 95, cy: 75, delay: 0 },
    { cx: 130, cy: 110, delay: 0.6 },
    { cx: 70, cy: 130, delay: 1.2 },
    { cx: 110, cy: 155, delay: 0.3 },
  ]

  return (
    <div className="mx-auto mb-8 flex justify-center">
      <svg
        viewBox="0 0 200 220"
        className="h-48 w-48"
        aria-hidden="true"
        role="img"
      >
        <ellipse
          cx="100"
          cy="115"
          rx="65"
          ry="80"
          fill="none"
          stroke="var(--lilac)"
          strokeWidth="2"
          opacity="0.6"
        />
        <path
          d="M 55 95 Q 75 80 100 85 Q 125 80 145 95"
          fill="none"
          stroke="var(--ink-muted)"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <ellipse
          cx="78"
          cy="105"
          rx="8"
          ry="5"
          fill="none"
          stroke="var(--ink-muted)"
          strokeWidth="1.5"
          opacity="0.4"
        />
        <ellipse
          cx="122"
          cy="105"
          rx="8"
          ry="5"
          fill="none"
          stroke="var(--ink-muted)"
          strokeWidth="1.5"
          opacity="0.4"
        />
        <path
          d="M 85 145 Q 100 155 115 145"
          fill="none"
          stroke="var(--ink-muted)"
          strokeWidth="1.5"
          opacity="0.4"
        />
        {dots.map((dot, i) => (
          <circle
            key={i}
            cx={dot.cx}
            cy={dot.cy}
            r="6"
            fill="var(--berry)"
            opacity="0.7"
            className="hero-dot"
            style={{
              animation: `pulse-dot 2s ease-in-out ${dot.delay}s infinite`,
            }}
          />
        ))}
      </svg>
    </div>
  )
}

export function IntroScreen() {
  const { nextStep } = useFlow()

  return (
    <div className="flex flex-col items-center text-center">
      <HeroFace />
      <h1 className="font-display text-[32px] font-bold leading-[1.15] text-ink md:text-[34px]">
        Let&apos;s get to know your skin.
      </h1>
      <p className="mt-3 max-w-sm text-base leading-relaxed text-ink-muted">
        One photo, four quick questions, real answers in under a minute.
      </p>
      <Button className="mt-8 w-full max-w-xs" onClick={nextStep}>
        Start my scan
      </Button>
      <p className="mt-4 text-[13px] leading-snug text-ink-muted">
        Not a medical diagnosis — just a starting point for your routine.
      </p>
    </div>
  )
}
