import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { join, resolve } from 'node:path'
import { createMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { PathKeeperService } from './services/pathkeeper-service'

app.setName('PathKeeper')
if (process.platform === 'win32') {
  app.setAppUserModelId('io.pathkeeper.app')
}

// Isolated profile for automated end-to-end runs and troubleshooting.
if (process.env.PATHKEEPER_USER_DATA) {
  app.setPath('userData', resolve(process.env.PATHKEEPER_USER_DATA))
}

const isDev = !app.isPackaged
const isE2E = process.env.PATHKEEPER_E2E === '1'
let mainWindow: BrowserWindow | null = null
let service: PathKeeperService | null = null
let quitting = false

const hasSingleInstanceLock = isE2E || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('PathKeeper 无法启动', message)
    app.exit(1)
  })
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null)
  installLocalOnlyNetworkPolicy()
  installPermissionPolicy()

  const sampleProjectDir = app.isPackaged
    ? join(process.resourcesPath, 'sample-project')
    : join(app.getAppPath(), 'examples', 'beginner-sample')
  service = new PathKeeperService(app.getPath('userData'), { sampleProjectDir })
  await service.init()

  registerIpcHandlers(service, () => mainWindow)
  mainWindow = createMainWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
}

function installLocalOnlyNetworkPolicy(): void {
  // The renderer is loaded from file:// in production, so all web requests are
  // unexpected. Never allow telemetry, remote fonts, updates or web content.
  if (isDev) return

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  )
}

function installPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (quitting) return
  quitting = true
  service?.close()
})

process.on('uncaughtException', (error) => {
  // Keep the app usable if a single background operation throws. Renderer
  // operations already return structured errors; this is a last resort.
  console.error('[PathKeeper] uncaught exception', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[PathKeeper] unhandled rejection', reason)
})
