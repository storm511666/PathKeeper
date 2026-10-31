import { app, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  ApplyRequest,
  DependencyValidateFixRequest,
  IgnoreInput,
  PathPreviewRequest,
  PickPathRequest,
  RuleInput,
  SaveTextRequest,
  ScanProgress,
  ScanRequest,
  SoftwareAddRequest,
  SoftwareInspectResult,
  SoftwarePickMode,
  SoftwareScanRequest,
  SystemInfo
} from '../shared/types'
import { AppError, ERROR_CODES, serializeError } from './errors'
import { PathKeeperService } from './services/pathkeeper-service'

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(ERROR_CODES.validation, `${field} 必须是整数。`, { field })
  }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.validation, `${field} 必须是字符串。`, { field })
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireObject<T>(value: unknown, field: string): T {
  if (!isPlainObject(value)) {
    throw new AppError(ERROR_CODES.validation, `${field} 必须是对象。`, { field })
  }
  return value as T
}

/** Program icons are small; anything bigger is skipped to keep IPC snappy. */
const MAX_ICON_DATA_BYTES = 512 * 1024

/**
 * Enrich a software inspection with the OS icon for its entry program (or the
 * install folder). This only reads the icon cache; the target is never run.
 */
async function withSoftwareIcon(result: SoftwareInspectResult): Promise<SoftwareInspectResult> {
  const target = result.entryPath ?? result.rootPath
  try {
    const image = await app.getFileIcon(target, { size: 'large' })
    if (image.isEmpty()) return result
    const png = image.toPNG()
    if (png.length === 0 || png.length > MAX_ICON_DATA_BYTES) return result
    return {
      ...result,
      info: {
        ...result.info,
        iconDataUrl: `data:image/png;base64,${png.toString('base64')}`
      }
    }
  } catch {
    // Icons are decorative; a missing one must never fail the inspection.
    return result
  }
}

/**
 * Wire every renderer channel from `src/shared/ipc.ts` to the service.
 *
 * Each handler is wrapped in the `IpcResponse` envelope. Scan progress is
 * pushed to the invoking webContents (never to a different window) so a
 * renderer always sees the progress of the operation it started.
 */
export function registerIpcHandlers(
  service: PathKeeperService,
  getWindow: () => BrowserWindow | null
): void {
  const handle = (channel: string, handler: IpcHandler): void => {
    // Registering twice (e.g. after a dev reload) must not crash Electron.
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const data = await handler(event, ...args)
        return { ok: true, data: data === undefined ? null : data }
      } catch (error) {
        return { ok: false, error: serializeError(error) }
      }
    })
  }

  const showOpenDialog = async (options: OpenDialogOptions) => {
    const window = getWindow()
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
  }

  const showSaveDialog = async (options: SaveDialogOptions) => {
    const window = getWindow()
    return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options)
  }

  // -------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------

  handle(IPC.projectsList, () => service.listProjects())

  handle(IPC.projectsAdd, async () => {
    const result = await showOpenDialog({
      title: '选择项目文件夹',
      properties: ['openDirectory'],
      buttonLabel: '添加项目'
    })
    const folder = result.filePaths[0]
    if (result.canceled || !folder) return null
    return service.addProjectFromPath(folder)
  })

  handle(IPC.projectsAddFromPath, (_event, rootPath) =>
    service.addProjectFromPath(requireString(rootPath, 'rootPath'))
  )

  handle(IPC.projectsRemove, (_event, projectId) =>
    service.removeProject(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.projectsLoadSample, () => service.loadSampleProject())

  handle(IPC.projectsRename, (_event, projectId, name) =>
    service.renameProject(requireNumber(projectId, 'projectId'), requireString(name, 'name'))
  )

  handle(IPC.projectsReveal, async (_event, projectId) => {
    const project = service.getProject(requireNumber(projectId, 'projectId'))
    const error = await shell.openPath(project.rootPath)
    if (error) {
      throw new AppError(ERROR_CODES.fileNotFound, `无法打开项目文件夹：${error}`, {
        path: project.rootPath
      })
    }
    return null
  })

  // -------------------------------------------------------------------
  // Software scan (“扫描一个软件”)
  // -------------------------------------------------------------------

  handle(IPC.softwarePick, async (_event, mode) => {
    const pickMode: SoftwarePickMode = mode === 'directory' ? 'directory' : 'file'
    const options: OpenDialogOptions =
      pickMode === 'directory'
        ? {
            title: '选择软件安装目录',
            properties: ['openDirectory'],
            buttonLabel: '选择这个目录'
          }
        : {
            title: '选择软件程序或快捷方式',
            properties: ['openFile'],
            buttonLabel: '选择',
            filters: [
              { name: '程序或快捷方式', extensions: ['exe', 'lnk'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          }
    const result = await showOpenDialog(options)
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    return withSoftwareIcon(await service.inspectSoftwareTarget(selected))
  })

  handle(IPC.softwareInspect, async (_event, absPath) =>
    withSoftwareIcon(await service.inspectSoftwareTarget(requireString(absPath, 'absPath')))
  )

  handle(IPC.softwareAdd, (_event, request) =>
    service.addSoftwareProject(requireObject<SoftwareAddRequest>(request, 'request'))
  )

  handle(IPC.softwareScan, (_event, request) =>
    service.scanSoftware(requireObject<SoftwareScanRequest>(request, 'request'))
  )

  // -------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------

  handle(IPC.settingsGet, () => service.getSettings())

  handle(IPC.settingsUpdate, (_event, patch) => service.updateSettings(patch ?? {}))

  // -------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------

  handle(IPC.pathsPreview, (_event, request) =>
    service.previewPaths(requireObject<PathPreviewRequest>(request, 'request'))
  )

  handle(IPC.autoCheckRun, (_event, projectId) =>
    service.autoCheck(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.dependenciesScan, (_event, projectId) =>
    service.scanDependencies(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.dependenciesChanges, (_event, projectId) =>
    service.checkDependencyChanges(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.dependenciesWatchStart, (event, projectId) => {
    const id = requireNumber(projectId, 'projectId')
    service.startDependencyWatch(id, (changes) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.dependenciesChanged, changes)
        }
      } catch {
        // The watcher is best-effort; a closed window must not crash it.
      }
    })
    return null
  })

  handle(IPC.dependenciesWatchStop, (_event, projectId) => {
    service.stopDependencyWatch(requireNumber(projectId, 'projectId'))
    return null
  })

  handle(IPC.dependenciesValidateFix, (_event, request) =>
    service.validateDependencyFix(requireObject<DependencyValidateFixRequest>(request, 'request'))
  )

  handle(IPC.dependenciesRepair, (_event, request) =>
    service.repairDependencyPath(requireObject<DependencyValidateFixRequest>(request, 'request'))
  )

  handle(IPC.dependenciesRebuildCache, (_event, projectId, paths) => {
    if (!Array.isArray(paths)) {
      throw new AppError(ERROR_CODES.validation, 'paths 必须是数组。')
    }
    return service.rebuildDependencyCache(
      requireNumber(projectId, 'projectId'),
      paths.map((path, index) => requireString(path, `paths[${index}]`))
    )
  })

  handle(IPC.dependenciesIgnore, (_event, projectId, pathValue, ignored) =>
    service.ignoreDependency(
      requireNumber(projectId, 'projectId'),
      requireString(pathValue, 'path'),
      ignored === true
    )
  )

  // -------------------------------------------------------------------
  // Scan / apply
  // -------------------------------------------------------------------

  handle(IPC.scanRun, (event, request) => {
    const scanRequest = requireObject<ScanRequest>(request, 'request')
    const onProgress = (progress: ScanProgress): void => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.scanProgress, progress)
        }
      } catch {
        // Progress is best-effort; losing one event must not fail the scan.
      }
    }
    return service.scan(scanRequest, onProgress)
  })

  handle(IPC.scanCancel, () => {
    service.cancelScan()
    return null
  })

  handle(IPC.filesPreview, (_event, projectId, relativePath) =>
    service.previewFile(
      requireNumber(projectId, 'projectId'),
      requireString(relativePath, 'relativePath')
    )
  )

  handle(IPC.applyRun, (_event, request) =>
    service.apply(requireObject<ApplyRequest>(request, 'request'))
  )

  // -------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------

  handle(IPC.historyList, (_event, projectId) =>
    service.listHistory(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.historyRollback, (_event, migrationId) =>
    service.rollback(requireNumber(migrationId, 'migrationId'))
  )

  handle(IPC.historyRemove, (_event, migrationId) => {
    service.removeHistory(requireNumber(migrationId, 'migrationId'))
    return null
  })

  // -------------------------------------------------------------------
  // Backups
  // -------------------------------------------------------------------

  handle(IPC.backupsList, (_event, projectId) =>
    service.listBackups(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.backupsRemove, (_event, backupId) => {
    service.removeBackup(requireNumber(backupId, 'backupId'))
    return null
  })

  handle(IPC.backupsReveal, async (_event, backupId) => {
    const backup = service.getBackupRecord(requireNumber(backupId, 'backupId'))
    if (backup.missing) {
      throw new AppError(ERROR_CODES.backupMissing, '备份目录已不存在。', {
        backupId: backup.id,
        backupDir: backup.absPath
      })
    }
    shell.showItemInFolder(backup.absPath)
    return null
  })

  // -------------------------------------------------------------------
  // Match rules
  // -------------------------------------------------------------------

  handle(IPC.rulesList, (_event, projectId) =>
    service.listMatchRules(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.rulesAdd, (_event, projectId, input) =>
    service.addMatchRule(
      requireNumber(projectId, 'projectId'),
      requireObject<RuleInput>(input, 'input')
    )
  )

  handle(IPC.rulesUpdate, (_event, ruleId, patch) =>
    service.updateMatchRule(
      requireNumber(ruleId, 'ruleId'),
      requireObject<Partial<RuleInput>>(patch, 'patch')
    )
  )

  handle(IPC.rulesRemove, (_event, ruleId) => {
    service.removeMatchRule(requireNumber(ruleId, 'ruleId'))
    return null
  })

  handle(IPC.rulesReset, (_event, projectId) =>
    service.resetMatchRules(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.rulesValidate, (_event, pattern, flags) =>
    service.validateMatchRule(requireString(pattern, 'pattern'), requireString(flags, 'flags'))
  )

  handle(IPC.rulesTest, (_event, pattern, flags, sample) =>
    service.testMatchRule(
      requireString(pattern, 'pattern'),
      requireString(flags, 'flags'),
      requireString(sample, 'sample')
    )
  )

  // -------------------------------------------------------------------
  // Ignore rules
  // -------------------------------------------------------------------

  handle(IPC.ignoresList, (_event, projectId) =>
    service.listIgnoreRules(requireNumber(projectId, 'projectId'))
  )

  handle(IPC.ignoresAdd, (_event, projectId, input) =>
    service.addIgnoreRule(
      requireNumber(projectId, 'projectId'),
      requireObject<IgnoreInput>(input, 'input')
    )
  )

  handle(IPC.ignoresUpdate, (_event, ruleId, patch) =>
    service.updateIgnoreRule(
      requireNumber(ruleId, 'ruleId'),
      requireObject<Partial<IgnoreInput>>(patch, 'patch')
    )
  )

  handle(IPC.ignoresRemove, (_event, ruleId) => {
    service.removeIgnoreRule(requireNumber(ruleId, 'ruleId'))
    return null
  })

  handle(IPC.ignoresReset, (_event, projectId) =>
    service.resetIgnoreRules(requireNumber(projectId, 'projectId'))
  )

  // -------------------------------------------------------------------
  // Native dialogs
  // -------------------------------------------------------------------

  handle(IPC.pickProjectPath, async (_event, request) => {
    const pickRequest = requireObject<PickPathRequest>(request, 'request')
    const project = service.getProject(requireNumber(pickRequest.projectId, 'projectId'))
    const kind = pickRequest.kind === 'directory' ? 'directory' : 'file'
    const sideLabel = pickRequest.side === 'new' ? '新路径' : '旧路径'
    const options: OpenDialogOptions = {
      title: `选择${sideLabel}（${kind === 'directory' ? '文件夹' : '文件'}）`,
      defaultPath: project.rootPath,
      buttonLabel: '选择',
      properties: kind === 'directory' ? ['openDirectory'] : ['openFile']
    }
    const result = await showOpenDialog(options)
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    // The native dialog can navigate anywhere; resolve must stay inside root.
    return service.describeProjectPath(project.id, selected)
  })

  handle(IPC.saveTextFile, async (_event, request) => {
    const saveRequest = requireObject<SaveTextRequest>(request, 'request')
    const content = requireString(saveRequest.content, 'content')
    if (content.length > 200_000_000) {
      throw new AppError(ERROR_CODES.validation, '导出内容过大。')
    }
    const requestedName =
      typeof saveRequest.defaultName === 'string' ? basename(saveRequest.defaultName.trim()) : ''
    const defaultName = requestedName.length > 0 ? requestedName : 'pathkeeper-export.csv'
    const result = await showSaveDialog({
      title: '保存文件',
      defaultPath: defaultName,
      buttonLabel: '保存',
      filters: [
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '文本文件', extensions: ['txt', 'md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const filePath = result.filePath
    if (result.canceled || !filePath) return null
    // Excel on Chinese Windows needs the UTF-8 BOM to read CSV correctly.
    const payload =
      filePath.toLowerCase().endsWith('.csv') && !content.startsWith('\uFEFF')
        ? `\uFEFF${content}`
        : content
    await writeFile(filePath, payload, 'utf8')
    return filePath
  })

  // -------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------

  handle(IPC.systemInfo, (): SystemInfo => {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? '',
      platform: process.platform,
      userDataPath: service.getUserDataPath()
    }
  })

  handle(IPC.systemShowProjectFile, async (_event, projectId, relativePath) => {
    const resolved = service.resolveProjectFile(
      requireNumber(projectId, 'projectId'),
      requireString(relativePath, 'relativePath')
    )
    if (resolved.kind === 'directory') {
      const error = await shell.openPath(resolved.absPath)
      if (error) {
        throw new AppError(ERROR_CODES.fileNotFound, `无法打开文件夹：${error}`, {
          path: resolved.absPath
        })
      }
    } else {
      shell.showItemInFolder(resolved.absPath)
    }
    return null
  })
}
