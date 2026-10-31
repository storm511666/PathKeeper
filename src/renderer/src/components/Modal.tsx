import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cx } from '@renderer/lib/cx'
import { IconButton } from './ui'

export interface ModalProps {
  open: boolean
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: 'sm' | 'md' | 'lg'
  testId?: string
  tone?: 'default' | 'danger'
}

/**
 * Native <dialog> modal: gives us a focus trap, Escape handling and a top-layer
 * backdrop without shipping a dialog library. Escape is translated into the
 * React `onClose` callback so callers own the open/close state.
 */
export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  width = 'md',
  testId,
  tone = 'default'
}: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const handleCancel = (event: Event): void => {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', handleCancel)
    return () => dialog.removeEventListener('cancel', handleCancel)
  }, [open, onClose])

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      data-testid={testId}
      aria-labelledby={titleId}
      onClick={(event) => {
        // Click on the ::backdrop is reported as a click on the dialog itself.
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className={cx('modal-card', `modal-${width}`, tone === 'danger' && 'modal-danger')}>
        <header className="modal-head">
          <div className="modal-head-copy">
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {description ? <p className="modal-desc">{description}</p> : null}
          </div>
          <IconButton label="关闭对话框" className="modal-close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        {children ? <div className="modal-body">{children}</div> : null}
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </dialog>
  )
}
