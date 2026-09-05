type Props = {
  label: string
  selected: boolean
  onClick: () => void
}

export function Chip({ label, selected, onClick }: Props) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`focus-ring w-full rounded-btn px-4 py-3 text-left text-base font-medium transition-colors ${
        selected
          ? 'border-[1.5px] border-berry bg-berry-soft text-berry'
          : 'border border-transparent bg-surface/60 text-ink hover:bg-surface/90'
      }`}
    >
      {label}
    </button>
  )
}
