import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import { cx } from '@renderer/lib/cx'
import { IconButton } from './ui'

export type ToastTone = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  detail?: string
}

export interface ToastApi {
  success: (message: string, detail?: string) => void
  error: (message: string, detail?: string) => void
  info: (message: string, detail?: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const TOAST_ICONS: Record<ToastTone, ReactNode> = {
  success: <CircleCheck size={15} />,
  error: <CircleAlert size={15} />,
  info: <Info size={15} />
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<ToastItem[]>([])
  const counterRef = useRef(0)
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number): void => {
    const timer = timersRef.current.get(id)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(id)
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, message: string, detail?: string): void => {
      counterRef.current += 1
      const id = counterRef.current
      // Keep at most four visible toasts; the oldest yield space.
      setItems((current) => [...current.slice(-3), { id, tone, message, detail }])
      const timer = setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 5200)
      timersRef.current.set(id, timer)
    },
    [dismiss]
  )

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, detail) => push('success', message, detail),
      error: (message, detail) => push('error', message, detail),
      info: (message, detail) => push('info', message, detail)
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="region" aria-label="通知" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={cx('toast', `toast-${item.tone}`)}
            data-testid="toast"
            data-tone={item.tone}
            role={item.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-icon" aria-hidden="true">
              {TOAST_ICONS[item.tone]}
            </span>
            <div className="toast-copy">
              <p className="toast-message">{item.message}</p>
              {item.detail ? <p className="toast-detail">{item.detail}</p> : null}
            </div>
            <IconButton
              label="关闭通知"
              className="toast-close"
              data-testid="toast-close"
              onClick={() => dismiss(item.id)}
            >
              <span aria-hidden="true">×</span>
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast 必须在 ToastProvider 内使用')
  return api
}
