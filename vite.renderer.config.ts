import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Renderer-only dev server used for visual iteration without Electron.
 * The app still requires the real preload bridge; in this mode a dev-only
 * mock API can be enabled by renderer-ui.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5180,
    strictPort: true
  }
})
