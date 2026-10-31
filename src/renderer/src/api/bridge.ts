import type { PathKeeperApi, PathKeeperBridgeApi } from '@shared/api'
import type { IpcResponse } from '@shared/types'

/**
 * Error reconstructed on the renderer side of the contextBridge.
 *
 * The preload bridge resolves `IpcResponse` envelopes instead of throwing,
 * because Electron recreates cross-context exceptions with only message/stack
 * and PathKeeper's beginner-facing UX maps stable error codes
 * (SCAN_CANCELLED, SCAN_STALE, SETTINGS_INVALID, ...) to friendly guidance.
 */
export class PathKeeperIpcError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'PathKeeperError'
    this.code = code
    this.details = details
  }
}

function unwrap<T>(response: IpcResponse<T>): T {
  if (!response || typeof response !== 'object' || !('ok' in response)) {
    throw new PathKeeperIpcError('INTERNAL', '主进程返回了无法识别的响应。')
  }
  if (response.ok) return response.data
  throw new PathKeeperIpcError(
    response.error.code || 'INTERNAL',
    response.error.message || '操作失败，请重试。',
    response.error.details
  )
}

type AnyAsync = (...args: never[]) => Promise<unknown>

function wrapMethod(method: AnyAsync): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => unwrap((await method(...(args as never[]))) as IpcResponse<unknown>)
}

/**
 * Rebuild the renderer-facing API from the bridge: every promise-returning
 * method unwraps its envelope and re-throws a local Error with code + details.
 * Event subscriptions stay untouched (they are synchronous and cannot fail
 * across the bridge in a way that loses data).
 */
function wrapNamespace(value: unknown, isRoot = false): unknown {
  if (typeof value === 'function') return wrapMethod(value as AnyAsync)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const wrapped: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    // `events` exposes synchronous subscribe helpers returning an unsubscribe
    // function; wrapping them as async would break cleanup.
    wrapped[key] = !isRoot || key !== 'events' ? wrapNamespace(child) : child
  }
  return wrapped
}

export function createRendererApi(bridge: PathKeeperBridgeApi): PathKeeperApi {
  return wrapNamespace(bridge, true) as PathKeeperApi
}
