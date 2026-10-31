import { describe, expect, it, vi } from 'vitest'
import type { PathKeeperBridgeApi } from '../../src/shared/api'
import type { IpcResponse } from '../../src/shared/types'
import { createRendererApi, PathKeeperIpcError } from '../../src/renderer/src/api/bridge'

function envelopeOk<T>(data: T): IpcResponse<T> {
  return { ok: true, data }
}

function envelopeError<T>(code: string, message: string, details?: unknown): IpcResponse<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } }
}

/** Build the smallest bridge double that exercises name/path wrapper logic. */
function makeBridge(overrides: Record<string, unknown> = {}): PathKeeperBridgeApi {
  const bridge = {
    projects: {
      list: async () => envelopeOk([{ id: 1, name: 'demo' }]),
      rename: async (_projectId: number, name: string) => envelopeOk({ id: 1, name })
    },
    settings: {
      get: async () => envelopeOk({ maxFileSizeKb: 1_048_576 }),
      update: async (patch: { maxFileSizeKb?: number }) => {
        if (patch.maxFileSizeKb === 1_048_577) {
          return envelopeError('SETTINGS_INVALID', '最大文件大小必须是 1 到 1048576 之间的整数 KB。')
        }
        return envelopeOk({ maxFileSizeKb: patch.maxFileSizeKb ?? 1_048_576 })
      }
    },
    scanCancel: async () => envelopeError('SCAN_CANCELLED', '扫描已取消。'),
    events: {
      onScanProgress: () => () => undefined,
      onDependenciesChanged: () => () => undefined
    },
    ...overrides
  }
  return bridge as unknown as PathKeeperBridgeApi
}

describe('renderer bridge wrapper', () => {
  it('unwraps successful envelopes into plain data', async () => {
    const api = createRendererApi(makeBridge())
    await expect(api.projects.list()).resolves.toEqual([{ id: 1, name: 'demo' }])
    await expect(api.settings.get()).resolves.toEqual({ maxFileSizeKb: 1_048_576 })
  })

  it('re-throws envelope failures with a stable code and message', async () => {
    const api = createRendererApi(makeBridge())
    const error = await api.settings.update({ maxFileSizeKb: 1_048_577 }).catch((value) => value)
    expect(error).toBeInstanceOf(PathKeeperIpcError)
    expect(error.name).toBe('PathKeeperError')
    expect(error.code).toBe('SETTINGS_INVALID')
    expect(error.message).toContain('1048576')
  })

  it('keeps cancellation detectable through the error code', async () => {
    const api = createRendererApi(makeBridge())
    const error = await api.scanCancel().catch((value) => value)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('SCAN_CANCELLED')
  })

  it('passes arguments through to the bridge method', async () => {
    const rename = vi.fn(async (_projectId: number, name: string) => envelopeOk({ id: 1, name }))
    const api = createRendererApi(makeBridge({ projects: { rename } }))
    await expect(api.projects.rename(7, '新名字')).resolves.toEqual({ id: 1, name: '新名字' })
    expect(rename).toHaveBeenCalledWith(7, '新名字')
  })

  it('leaves event subscriptions synchronous (cleanup functions keep working)', () => {
    const api = createRendererApi(makeBridge())
    const unsubscribe = api.events.onScanProgress(() => undefined)
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })

  it('surfaces malformed bridge responses as INTERNAL errors', async () => {
    const api = createRendererApi(makeBridge({ settings: { get: async () => ({ bad: true }) } }))
    const error = await api.settings.get().catch((value) => value)
    expect(error).toBeInstanceOf(PathKeeperIpcError)
    expect(error.code).toBe('INTERNAL')
  })
})
