const countFormatter = new Intl.NumberFormat('zh-CN')

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatCount(value: number): string {
  return countFormatter.format(value)
}

/** `2026-10-29 14:03` — local time, stable across renderer locales. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.replace('T', ' ').slice(0, 16)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit] ?? 'B'}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(2)} 秒`
}

export function formatFileSizeKb(kb: number): string {
  if (kb < 1024) return `${formatCount(kb)} KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(kb % 1024 === 0 ? 0 : 1)} MB`
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'pathkeeper'
}

/** `20261029-1403` for file names and backup folders. */
export function timestampSlug(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

export function shortenPath(value: string, max = 64): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 3) / 2)
  const tail = Math.floor((max - 3) / 2)
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`
}
