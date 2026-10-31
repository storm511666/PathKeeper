import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Button } from './ui'
import { Modal } from './Modal'

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  details?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  testId?: string
  confirmTestId?: string
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * Promise-based confirmation dialog. Destructive flows await the boolean
 * result, so a cancelled confirmation never falls through to a write.
 */
export function ConfirmProvider({ children }: { children: ReactNode }): ReactNode {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((next) => {
    return new Promise<boolean>((resolve) => {
      // A second confirm supersedes the first one.
      resolverRef.current?.(false)
      resolverRef.current = resolve
      setOptions(next)
    })
  }, [])

  const settle = useCallback((value: boolean): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOptions(null)
    resolve?.(value)
  }, [])

  const tone = options?.tone ?? 'default'

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== null}
        title={options?.title ?? ''}
        description={options?.description}
        onClose={() => settle(false)}
        width="sm"
        tone={tone}
        testId={options?.testId ?? 'confirm-dialog'}
        footer={
          <>
            <Button variant="ghost" onClick={() => settle(false)}>
              {options?.cancelLabel ?? '取消'}
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              data-testid={options?.confirmTestId ?? 'confirm-accept'}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? '确认'}
            </Button>
          </>
        }
      >
        {options?.details ? <div className="confirm-details">{options.details}</div> : null}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm 必须在 ConfirmProvider 内使用')
  return confirm
}
