import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'text'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  children: ReactNode
}

const variantClasses: Record<Variant, string> = {
  primary:
    'rounded-btn bg-gradient-to-br from-berry to-[#FF7A9C] px-6 py-3.5 text-base font-semibold text-white shadow-btn-primary transition-transform hover:scale-[1.02] hover:shadow-berry-glow active:scale-[0.98]',
  secondary:
    'rounded-btn border-[1.5px] border-berry bg-transparent px-6 py-3.5 text-base font-semibold text-berry transition-colors hover:bg-berry-soft/40',
  text: 'text-ink-muted underline-offset-2 transition-colors hover:underline',
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: Props) {
  return (
    <button
      type="button"
      className={`focus-ring ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
