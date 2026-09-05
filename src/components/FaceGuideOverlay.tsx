type Props = {
  valid: boolean
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
  return (
    <div
      className={`absolute bg-black/28 ${className}`}
      aria-hidden="true"
    />
  )
}

export function FaceGuideOverlay({ valid }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0">
      <Scrim className="inset-x-0 top-0 h-[20.75%]" />
      <Scrim className="inset-x-0 bottom-0 h-[20.75%]" />
      <Scrim className="left-0 top-[20.75%] bottom-[20.75%] w-[11%]" />
      <Scrim className="right-0 top-[20.75%] bottom-[20.75%] w-[11%]" />

      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="relative rounded-[20px]"
          style={{
            width: '78%',
            aspectRatio: '1 / 1',
          }}
        >
          <CornerBracket valid={valid} className="left-0 top-0 rounded-tl-[18px] border-b-0 border-r-0" />
          <CornerBracket valid={valid} className="right-0 top-0 rounded-tr-[18px] border-b-0 border-l-0" />
          <CornerBracket valid={valid} className="bottom-0 left-0 rounded-bl-[18px] border-r-0 border-t-0" />
          <CornerBracket valid={valid} className="bottom-0 right-0 rounded-br-[18px] border-l-0 border-t-0" />
        </div>
      </div>
    </div>
  )
}
