import { useReducer } from 'react'
import { CFG, CFG_DEFAULTS } from '../lib/faceGuide'

type FieldKey = keyof typeof CFG

const FIELDS: {
  key: FieldKey
  label: string
  min: number
  max: number
  step: number
}[] = [
  { key: 'maskLipRednessRatio', label: 'Lip redness ratio', min: 0.7, max: 1.2, step: 0.01 },
  { key: 'maskColorDelta', label: 'Colour break (RGB dist)', min: 5, max: 70, step: 1 },
  { key: 'maskBlueShiftMin', label: 'Blue-shift min', min: 0, max: 0.08, step: 0.001 },
  { key: 'maskRedDropMin', label: 'Red-drop min', min: 0, max: 0.08, step: 0.001 },
  { key: 'maskBrightDelta', label: 'Brighter-than-cheek Δ', min: 0, max: 40, step: 1 },
  { key: 'coverageConfirmFrames', label: 'Confirm frames (debounce)', min: 1, max: 10, step: 1 },
  { key: 'coverageMinSkinLum', label: 'Min skin luma to judge', min: 10, max: 90, step: 1 },
]

const fmt = (n: number) => (n < 1 && n > 0 ? n.toFixed(3) : String(n))

/**
 * Dev-only live tuning of the face-covering (mask) thresholds. `CFG` is a plain
 * mutable object read fresh every detection frame, so edits here take effect on
 * the next frame with no reload.
 */
export function MaskTuningPanel() {
  const [, force] = useReducer((n: number) => n + 1, 0)
  const dirty = FIELDS.some(({ key }) => CFG[key] !== CFG_DEFAULTS[key])

  const set = (key: FieldKey, value: number) => {
    // Intentional: CFG is a shared mutable settings object the detection loop
    // reads every frame — that's how a runtime tweak takes effect immediately.
    // eslint-disable-next-line react/immutability
    ;(CFG as Record<string, number>)[key] = value
    force()
  }

  return (
    <details className="mt-3 w-full max-w-[280px] rounded-panel border border-berry/25 bg-surface/50 p-3 text-left text-[12px]">
      <summary className="cursor-pointer select-none font-semibold text-ink">
        Mask detection tuning{dirty ? ' •' : ''}{' '}
        <span className="font-normal text-ink-muted">(dev)</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2.5">
        {FIELDS.map(({ key, label, min, max, step }) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between text-ink-muted">
              <span>{label}</span>
              <span className="tabular-nums font-semibold text-ink">
                {fmt(CFG[key])}
              </span>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={CFG[key]}
              onChange={(e) => set(key, Number(e.target.value))}
              className="accent-berry"
            />
          </label>
        ))}
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            for (const { key } of FIELDS) set(key, CFG_DEFAULTS[key])
          }}
          className="focus-ring self-start rounded-btn bg-surface/80 px-3 py-1.5 font-semibold text-ink hover:bg-surface disabled:opacity-40"
        >
          Reset to defaults
        </button>
      </div>
    </details>
  )
}
