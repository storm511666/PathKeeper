/// <reference types="vite/client" />

import type { PathKeeperBridgeApi } from '@shared/api'

/**
 * The renderer is bundled separately from the main process, so it only knows
 * about the preload bridge type and Vite's import.meta.env.
 */
declare global {
  interface Window {
    /** Undefined when the renderer runs in a plain browser (dev visual mode). */
    pathkeeper?: PathKeeperBridgeApi
  }
}

export {}
