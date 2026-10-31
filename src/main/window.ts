import { BrowserWindow } from 'electron'
import { join } from 'node:path'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1419',
    title: 'PathKeeper',
    ...(isWindows
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#0d1419',
            symbolColor: '#dce7ea',
            height: 38
          }
        }
      : isMac
        ? { titleBarStyle: 'hiddenInset' as const }
        : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  // PathKeeper is local-only. Never let the UI open a new window or browser.
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // Reloading the current document keeps the URL identical and is harmless.
    // Any other navigation (including file:// to another file) is denied.
    if (url === window.webContents.getURL()) return
    event.preventDefault()
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
