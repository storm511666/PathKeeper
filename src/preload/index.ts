import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { PathKeeperBridgeApi } from '../shared/api'
import type {
  AppSettings,
  ApplyResult,
  AutoCheckResult,
  BackupRecord,
  DependencyCacheRebuildResult,
  DependencyChangesResult,
  DependencyIgnoreResult,
  DependencyRepairResult,
  DependencyScanResult,
  DependencyValidation,
  FilePreview,
  IgnoreRule,
  IpcResponse,
  MatchRule,
  MigrationRecord,
  PathInfo,
  Project,
  RollbackResult,
  RuleTestResult,
  RuleValidation,
  ScanProgress,
  ScanResult,
  SelectedPath,
  SoftwareInspectResult,
  SoftwareScanResult,
  SystemInfo
} from '../shared/types'

/**
 * The preload bridge never throws across the context boundary: Electron
 * recreates exceptions in the renderer with only message/stack, which would
 * lose PathKeeper's structured error codes. Every request therefore resolves
 * to an `IpcResponse` envelope; the renderer wrapper in
 * `src/renderer/src/api/bridge.ts` re-throws a real error with code/details.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResponse<T>> {
  const response = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (!response || typeof response !== 'object' || !('ok' in response)) {
    return {
      ok: false,
      error: { code: 'INTERNAL', message: '主进程返回了无法识别的响应。' }
    }
  }
  return response
}

const api: PathKeeperBridgeApi = {
  projects: {
    list: () => invoke<Project[]>(IPC.projectsList),
    add: () => invoke<Project | null>(IPC.projectsAdd),
    addFromPath: (rootPath) => invoke<Project>(IPC.projectsAddFromPath, rootPath),
    remove: (projectId) => invoke<void>(IPC.projectsRemove, projectId),
    rename: (projectId, name) => invoke<Project>(IPC.projectsRename, projectId, name),
    reveal: (projectId) => invoke<void>(IPC.projectsReveal, projectId),
    loadSample: () => invoke<Project>(IPC.projectsLoadSample)
  },
  settings: {
    get: () => invoke<AppSettings>(IPC.settingsGet),
    update: (patch) => invoke<AppSettings>(IPC.settingsUpdate, patch)
  },
  paths: {
    preview: (request) => invoke<PathInfo>(IPC.pathsPreview, request)
  },
  autoCheck: (projectId) => invoke<AutoCheckResult>(IPC.autoCheckRun, projectId),
  dependencies: {
    scan: (projectId) => invoke<DependencyScanResult>(IPC.dependenciesScan, projectId),
    changes: (projectId) => invoke<DependencyChangesResult>(IPC.dependenciesChanges, projectId),
    startWatch: (projectId) => invoke<void>(IPC.dependenciesWatchStart, projectId),
    stopWatch: (projectId) => invoke<void>(IPC.dependenciesWatchStop, projectId),
    validateFix: (request) => invoke<DependencyValidation>(IPC.dependenciesValidateFix, request),
    repair: (request) => invoke<DependencyRepairResult>(IPC.dependenciesRepair, request),
    rebuildCache: (projectId, paths) =>
      invoke<DependencyCacheRebuildResult>(IPC.dependenciesRebuildCache, projectId, paths),
    ignore: (projectId, path, ignored) =>
      invoke<DependencyIgnoreResult>(IPC.dependenciesIgnore, projectId, path, ignored)
  },
  scan: (request) => invoke<ScanResult>(IPC.scanRun, request),
  scanCancel: () => invoke<void>(IPC.scanCancel),
  apply: (request) => invoke<ApplyResult>(IPC.applyRun, request),
  software: {
    pick: (mode) => invoke<SoftwareInspectResult | null>(IPC.softwarePick, mode),
    inspect: (absPath) => invoke<SoftwareInspectResult>(IPC.softwareInspect, absPath),
    add: (request) => invoke<Project>(IPC.softwareAdd, request),
    scan: (request) => invoke<SoftwareScanResult>(IPC.softwareScan, request)
  },
  files: {
    preview: (projectId, relativePath) =>
      invoke<FilePreview>(IPC.filesPreview, projectId, relativePath)
  },
  history: {
    list: (projectId) => invoke<MigrationRecord[]>(IPC.historyList, projectId),
    rollback: (migrationId) => invoke<RollbackResult>(IPC.historyRollback, migrationId),
    remove: (migrationId) => invoke<void>(IPC.historyRemove, migrationId)
  },
  backups: {
    list: (projectId) => invoke<BackupRecord[]>(IPC.backupsList, projectId),
    remove: (backupId) => invoke<void>(IPC.backupsRemove, backupId),
    reveal: (backupId) => invoke<void>(IPC.backupsReveal, backupId)
  },
  rules: {
    list: (projectId) => invoke<MatchRule[]>(IPC.rulesList, projectId),
    add: (projectId, input) => invoke<MatchRule>(IPC.rulesAdd, projectId, input),
    update: (ruleId, patch) => invoke<MatchRule>(IPC.rulesUpdate, ruleId, patch),
    remove: (ruleId) => invoke<void>(IPC.rulesRemove, ruleId),
    reset: (projectId) => invoke<MatchRule[]>(IPC.rulesReset, projectId),
    validate: (pattern, flags) => invoke<RuleValidation>(IPC.rulesValidate, pattern, flags),
    test: (pattern, flags, sample) =>
      invoke<RuleTestResult>(IPC.rulesTest, pattern, flags, sample)
  },
  ignores: {
    list: (projectId) => invoke<IgnoreRule[]>(IPC.ignoresList, projectId),
    add: (projectId, input) => invoke<IgnoreRule>(IPC.ignoresAdd, projectId, input),
    update: (ruleId, patch) => invoke<IgnoreRule>(IPC.ignoresUpdate, ruleId, patch),
    remove: (ruleId) => invoke<void>(IPC.ignoresRemove, ruleId),
    reset: (projectId) => invoke<IgnoreRule[]>(IPC.ignoresReset, projectId)
  },
  dialogs: {
    pickProjectPath: (request) => invoke<SelectedPath | null>(IPC.pickProjectPath, request),
    saveTextFile: (request) => invoke<string | null>(IPC.saveTextFile, request)
  },
  system: {
    info: () => invoke<SystemInfo>(IPC.systemInfo),
    showProjectFile: (projectId, relativePath) =>
      invoke<void>(IPC.systemShowProjectFile, projectId, relativePath)
  },
  events: {
    onScanProgress: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress): void => {
        handler(progress)
      }
      ipcRenderer.on(IPC.scanProgress, listener)
      return () => {
        ipcRenderer.removeListener(IPC.scanProgress, listener)
      }
    },
    onDependenciesChanged: (handler) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        changes: DependencyChangesResult
      ): void => {
        handler(changes)
      }
      ipcRenderer.on(IPC.dependenciesChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.dependenciesChanged, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('pathkeeper', api)
