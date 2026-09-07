import { Scan, ScanFace, Settings, Zap } from 'lucide-react'
import type { GuideShape } from './FaceGuideOverlay'
import { MaskTuningPanel } from './MaskTuningPanel'

type Props = {
  autoCapture: boolean
  onToggleAutoCapture: () => void
  guideShape: GuideShape
  onCycleGuideShape: () => void
  coverageEnabled: boolean
  onToggleCoverage: () => void
}

const rowBase =
  'focus-ring flex w-full items-center justify-between gap-2 rounded-btn px-4 py-2.5 text-[14px] font-semibold transition-colors'
const rowOn = 'border-[1.5px] border-berry bg-berry-soft text-berry'
const rowOff = 'border border-transparent bg-surface/60 text-ink hover:bg-surface/90'

export function CameraSettings({
  autoCapture,
  onToggleAutoCapture,
  guideShape,
  onCycleGuideShape,
  coverageEnabled,
  onToggleCoverage,
}: Props) {
  return (
    <details className="mt-3 w-full max-w-[280px] rounded-panel border border-berry/20 bg-surface/40 p-2">
      <summary className="focus-ring flex cursor-pointer select-none items-center gap-2 rounded-btn px-2 py-1.5 text-[14px] font-semibold text-ink">
        <Settings className="h-4 w-4" aria-hidden="true" />
        Settings
      </summary>

      <div className="mt-2 flex flex-col gap-2">
        <button
          type="button"
          onClick={onToggleAutoCapture}
          aria-pressed={autoCapture}
          className={`${rowBase} ${autoCapture ? rowOn : rowOff}`}
        >
          <span className="flex items-center gap-2">
            <Zap className="h-4 w-4" aria-hidden="true" />
            Auto-capture
          </span>
          <span>{autoCapture ? 'On' : 'Off'}</span>
        </button>

        <button
          type="button"
          onClick={onCycleGuideShape}
          className={`${rowBase} ${rowOff}`}
        >
          <span className="flex items-center gap-2">
            <Scan className="h-4 w-4" aria-hidden="true" />
            Guide shape
          </span>
          <span className="capitalize">{guideShape}</span>
        </button>

        <button
          type="button"
          onClick={onToggleCoverage}
          aria-pressed={coverageEnabled}
          className={`${rowBase} ${coverageEnabled ? rowOn : rowOff}`}
        >
          <span className="flex items-center gap-2">
            <ScanFace className="h-4 w-4" aria-hidden="true" />
            Face-clear check
          </span>
          <span>{coverageEnabled ? 'On' : 'Off'}</span>
        </button>

        {coverageEnabled && <MaskTuningPanel />}
      </div>
    </details>
  )
}
