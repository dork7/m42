import type { Check, CheckLevel } from '../lib/faceGuide'

const LEVEL_CLASS: Record<CheckLevel, string> = {
  good: 'bg-emerald-500/90 text-white',
  warn: 'bg-amber-500/90 text-white',
  bad: 'bg-rose-500/90 text-white',
}

function StatusChip({
  title,
  check,
  className = '',
}: {
  title: string
  check: Check
  className?: string
}) {
  return (
    <div
      className={`rounded-btn px-2 py-1.5 text-center leading-tight transition-colors duration-200 ${LEVEL_CLASS[check.level]} ${className}`}
    >
      <div className="text-[11px] font-semibold opacity-95">{title}</div>
      <div className="text-[12px] font-extrabold">{check.label}</div>
    </div>
  )
}

type Props = {
  light: Check
  pose: Check
  position: Check
  /** Pass null to hide the "Face Clear" chip (coverage check disabled). */
  coverage: Check | null
  className?: string
}

export function FaceStatusChips({
  light,
  pose,
  position,
  coverage,
  className = '',
}: Props) {
  return (
    <div
      className={`grid w-full max-w-[280px] grid-cols-2 gap-1.5 ${className}`}
      role="status"
      aria-live="polite"
    >
      <StatusChip title="Lighting" check={light} />
      <StatusChip title="Look Straight" check={pose} />
      <StatusChip
        title="Face Position"
        check={position}
        className={coverage ? '' : 'col-span-2'}
      />
      {coverage && <StatusChip title="Face Clear" check={coverage} />}
    </div>
  )
}
