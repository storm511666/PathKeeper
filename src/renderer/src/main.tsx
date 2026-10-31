import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { PathKeeperApi } from '@shared/api'
import { App } from './App'
import { createRendererApi } from './api/bridge'
import './styles/global.css'
import './styles/components.css'
import './styles/pages.css'
import './styles/software.css'

async function resolveApi(): Promise<PathKeeperApi> {
  // Production always uses the real preload bridge. The mock only exists to
  // review the renderer in a plain browser (`npm run dev:renderer`).
  if (import.meta.env.DEV && !window.pathkeeper) {
    const { createMockApi } = await import('./dev/mockApi')
    return createMockApi()
  }
  return createRendererApi(window.pathkeeper!)
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('PathKeeper: #root element is missing')
}

resolveApi()
  .then((api) => {
    createRoot(rootElement).render(
      <StrictMode>
        <App api={api} />
      </StrictMode>
    )
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    rootElement.innerHTML = ''
    const pre = document.createElement('pre')
    pre.className = 'boot-failure'
    pre.textContent = `PathKeeper 无法加载界面：\n${message}`
    rootElement.appendChild(pre)
  })
