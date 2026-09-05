import type { ReactNode } from 'react'

type Props = {
  children: ReactNode
  className?: string
}

export function GlassPanel({ children, className = '' }: Props) {
  return (
    <div className={`glass-panel rounded-panel ${className}`}>{children}</div>
  )
}
