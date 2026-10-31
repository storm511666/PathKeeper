import type { PathKeeperBridgeApi } from './api'

declare global {
  interface Window {
    /** Raw IPC bridge (envelope-returning). Wrapped by the renderer API layer. */
    pathkeeper: PathKeeperBridgeApi
  }
}

export {}
