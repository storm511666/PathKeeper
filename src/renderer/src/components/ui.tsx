import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode
} from 'react'
import {
  CircleAlert,
  CircleCheck,
  Info,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  X
} from 'lucide-react'
import { cx } from '@renderer/lib/cx'

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'quiet'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
  block?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading = false,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, `btn-${size}`, block && 'btn-block', className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 size={14} className="spin" aria-hidden="true" />
      ) : icon ? (
        <span className="btn-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="btn-label">{children}</span>
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also used as the tooltip. */
  label: string
  tone?: 'default' | 'danger' | 'brass'
}

export function IconButton({
  label,
  tone = 'default',
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      type={type}
      className={cx('icon-btn', `icon-btn-${tone}`, className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Toggle / segmented control                                          */
/* ------------------------------------------------------------------ */

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Accessible name; render a visible label next to the toggle yourself. */
  label: string
  disabled?: boolean
  testId?: string
}

export function Toggle({ checked, onChange, label, disabled = false, testId }: ToggleProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      className={cx('toggle', checked && 'is-on')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
    </button>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  testId?: string
}

export interface SegmentedProps<T extends string> {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  label: string
  disabled?: boolean
  className?: string
  testId?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
  testId
}: SegmentedProps<T>): ReactNode {
  return (
    <div
      className={cx('segmented', className)}
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          data-testid={option.testId}
          className={cx('segmented-option', value === option.value && 'is-active')}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Chips / stats / notices                                             */
/* ------------------------------------------------------------------ */

export type ChipTone = 'neutral' | 'brass' | 'mint' | 'red' | 'muted' | 'outline'

export function Chip({
  tone = 'neutral',
  mono = false,
  title,
  className,
  children
}: {
  tone?: ChipTone
  mono?: boolean
  title?: string
  className?: string
  children: ReactNode
}): ReactNode {
  return (
    <span title={title} className={cx('chip', `chip-${tone}`, mono && 'chip-mono', className)}>
      {children}
    </span>
  )
}

export type StatTone = 'default' | 'brass' | 'mint' | 'red' | 'muted'

export function Stat({
  label,
  value,
  tone = 'default'
}: {
  label: string
  value: ReactNode
  tone?: StatTone
}): ReactNode {
  return (
    <div className={cx('stat', `stat-${tone}`)}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

export type NoticeTone = 'info' | 'warn' | 'danger' | 'success'

const NOTICE_ICONS: Record<NoticeTone, ReactNode> = {
  info: <Info size={15} />,
  warn: <TriangleAlert size={15} />,
  danger: <CircleAlert size={15} />,
  success: <ShieldCheck size={15} />
}

export interface NoticeProps {
  tone?: NoticeTone
  title?: string
  icon?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  compact?: boolean
  className?: string
  testId?: string
}

export function Notice({
  tone = 'info',
  title,
  icon,
  children,
  actions,
  compact = false,
  className,
  testId
}: NoticeProps): ReactNode {
  return (
    <div
      className={cx('notice', `notice-${tone}`, compact && 'notice-compact', className)}
      data-testid={testId}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <span className="notice-icon" aria-hidden="true">
        {icon ?? NOTICE_ICONS[tone]}
      </span>
      <div className="notice-copy">
        {title ? <p className="notice-title">{title}</p> : null}
        {children ? <div className="notice-body">{children}</div> : null}
      </div>
      {actions ? <div className="notice-actions">{actions}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: string | null
  optional?: boolean
  children: ReactNode
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional = false,
  className,
  children,
  ...rest
}: FieldProps): ReactNode {
  return (
    <div className={cx('field', error ? 'field-invalid' : null, className)} {...rest}>
      <label className="field-label" htmlFor={htmlFor}>
        <span>{label}</span>
        {optional ? <span className="field-optional">可选</span> : null}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Loading / progress / empty states                                   */
/* ------------------------------------------------------------------ */

export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <span className="spinner" role={label ? 'status' : undefined}>
      <Loader2 size={15} className="spin" aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  )
}

export function ProgressBar({
  percent,
  label = '扫描进度'
}: {
  percent: number
  label?: string
}): ReactNode {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
    >
      <div className="progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  )
}

export type MotifVariant = 'route' | 'scan' | 'ledger' | 'backup' | 'project'

/**
 * The route-line motif: a surveyed line with terminals, station nodes and a
 * destination crosshair. Used in empty states and the brand mark.
 */
export function RouteMotif({ variant = 'route' }: { variant?: MotifVariant }): ReactNode {
  return (
    <svg
      className={cx('route-motif', `route-motif-${variant}`)}
      viewBox="0 0 280 128"
      fill="none"
      aria-hidden="true"
    >
      <g className="motif-dim" stroke="currentColor" strokeWidth="1">
        <path d="M6 22 H34 M6 30 H22" opacity=".45" />
        <path d="M268 108 H244 M268 100 H252" opacity=".45" />
        <path d="M18 100 V112 H30" opacity=".35" />
        <path d="M250 18 V30 H238" opacity=".35" />
      </g>
      <g className="motif-route" stroke="currentColor" strokeWidth="1.1">
        <path d="M12 104 H52 L86 70 H150 L186 34 H268" strokeDasharray="4 6" opacity=".55" />
        <path d="M12 104 H52 L86 70 H150 L186 34 H268" opacity=".18" strokeWidth="7" strokeLinecap="round" />
      </g>
      <g className="motif-nodes" fill="currentColor">
        <circle cx="12" cy="104" r="3.4" />
        <circle cx="86" cy="70" r="2" opacity=".7" />
        <circle cx="150" cy="70" r="2" opacity=".7" />
        <circle cx="186" cy="34" r="2" opacity=".7" />
      </g>
      <g className="motif-target" stroke="currentColor" strokeWidth="1">
        <circle cx="268" cy="34" r="8" opacity=".65" />
        <circle cx="268" cy="34" r="2.2" fill="currentColor" stroke="none" />
        <path d="M268 20 V26 M268 42 V48 M254 34 H260 M276 34 H282" opacity=".6" />
      </g>
      <g className="motif-ticks" stroke="currentColor" strokeWidth="1" opacity=".5">
        <path d="M52 104 V100 M66 92 L69 95 M86 70 V66 M104 70 V73 M150 70 V66 M168 52 L171 55 M186 34 V30" />
      </g>
    </svg>
  )
}

export function BrandMark({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="brand-mark"
      aria-hidden="true"
    >
      <path
        d="M3.2 18.6 V9.1 L7.4 4.9 H14.3 L20.8 11.4 V18.6 H3.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M3.2 18.6 H20.8" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.2" cy="9.1" r="1.6" fill="currentColor" />
      <circle cx="20.8" cy="11.4" r="1.6" fill="currentColor" />
      <path d="M7.6 14.6 H16.2" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2.4" />
    </svg>
  )
}

export function EmptyState({
  title,
  description,
  actions,
  motif = 'route',
  className,
  testId
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  motif?: MotifVariant
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div className={cx('empty-state', className)} data-testid={testId}>
      <RouteMotif variant={motif} />
      <h2 className="empty-title">{title}</h2>
      {description ? <p className="empty-desc">{description}</p> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  )
}

export function InlineError({
  message,
  detail,
  code
}: {
  message: string
  detail?: string | null
  code?: string | null
}): ReactNode {
  return (
    <div className="inline-error" role="alert">
      <CircleAlert size={14} aria-hidden="true" />
      <div>
        <p>{message}</p>
        {code || detail ? (
          <p className="inline-error-meta">
            {code ? <span className="mono">[{code}]</span> : null}
            {detail ? <span>{detail}</span> : null}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function DismissButton({ onClick, label = '关闭' }: { onClick: () => void; label?: string }): ReactNode {
  return (
    <button type="button" className="dismiss-btn" aria-label={label} title={label} onClick={onClick}>
      <X size={13} aria-hidden="true" />
    </button>
  )
}
