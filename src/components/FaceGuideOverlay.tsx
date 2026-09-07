import { useId } from 'react'

export type GuideShape = 'rectangle' | 'oval'

type Props = {
  valid: boolean
  shape?: GuideShape
}

function CornerBracket({
  valid,
  className,
}: {
  valid: boolean
  className: string
}) {
  const color = valid ? 'border-berry' : 'border-white/70'
  return (
    <div
      className={`absolute h-8 w-8 border-[3px] transition-colors duration-200 ${color} ${className}`}
      aria-hidden="true"
    />
  )
}

function Scrim({ className }: { className: string }) {
  return <div className={`absolute bg-black/28 ${className}`} aria-hidden="true" />
}

function RectangleGuide({ valid }: { valid: boolean }) {
  return (
    <>
      <Scrim className="inset-x-0 top-0 h-[20.75%]" />
      <Scrim className="inset-x-0 bottom-0 h-[20.75%]" />
      <Scrim className="left-0 top-[20.75%] bottom-[20.75%] w-[11%]" />
      <Scrim className="right-0 top-[20.75%] bottom-[20.75%] w-[11%]" />

      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="relative rounded-[20px]"
          style={{ width: '78%', aspectRatio: '1 / 1' }}
        >
          <CornerBracket valid={valid} className="left-0 top-0 rounded-tl-[18px] border-b-0 border-r-0" />
          <CornerBracket valid={valid} className="right-0 top-0 rounded-tr-[18px] border-b-0 border-l-0" />
          <CornerBracket valid={valid} className="bottom-0 left-0 rounded-bl-[18px] border-r-0 border-t-0" />
          <CornerBracket valid={valid} className="bottom-0 right-0 rounded-br-[18px] border-l-0 border-t-0" />
        </div>
      </div>
    </>
  )
}

// Ellipse geometry in the 300×400 (3:4) viewBox — width ≈ 78% of the frame,
// tall enough to frame forehead-to-chin, vertically centred.
const OVAL = { cx: 150, cy: 200, rx: 117, ry: 152 }

function OvalGuide({ valid }: { valid: boolean }) {
  const maskId = useId()
  const stroke = valid ? 'var(--berry)' : 'rgba(255,255,255,0.75)'
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 300 400"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId}>
          <rect width="300" height="400" fill="white" />
          <ellipse cx={OVAL.cx} cy={OVAL.cy} rx={OVAL.rx} ry={OVAL.ry} fill="black" />
        </mask>
      </defs>
      <rect width="300" height="400" fill="rgba(0,0,0,0.28)" mask={`url(#${maskId})`} />
      <ellipse
        cx={OVAL.cx}
        cy={OVAL.cy}
        rx={OVAL.rx}
        ry={OVAL.ry}
        fill="none"
        stroke={stroke}
        strokeWidth={3}
        strokeDasharray="10 8"
        className="transition-[stroke] duration-200"
      />
    </svg>
  )
}

export function FaceGuideOverlay({ valid, shape = 'rectangle' }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {shape === 'oval' ? (
        <OvalGuide valid={valid} />
      ) : (
        <RectangleGuide valid={valid} />
      )}
    </div>
  )
}
