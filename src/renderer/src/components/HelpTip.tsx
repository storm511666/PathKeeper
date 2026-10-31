import type { ReactNode } from 'react'

/**
 * A small accessible "?" affordance with a hover/focus tooltip. Used for
 * beginner-facing explanations without adding another modal step.
 */
export function HelpTip({
  children,
  label = '查看说明'
}: {
  children: ReactNode
  label?: string
}): ReactNode {
  return (
    <span className="help-tip" tabIndex={0} role="note" aria-label={label}>
      <span className="help-tip-mark" aria-hidden="true">
        ?
      </span>
      <span className="help-tip-bubble" role="tooltip">
        {children}
      </span>
    </span>
  )
}
