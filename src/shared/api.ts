import type {
  AppSettings,
  ApplyRequest,
  ApplyResult,
  AutoCheckResult,
  BackupRecord,
  DependencyCacheRebuildResult,
  DependencyChangesResult,
  DependencyIgnoreResult,
  DependencyRepairResult,
  DependencyScanResult,
  DependencyValidateFixRequest,
  DependencyValidation,
  FilePreview,
  IgnoreInput,
  IgnoreRule,
  IpcResponse,
  MatchRule,
  MigrationRecord,
  PathInfo,
  PathPreviewRequest,
  PickPathRequest,
  Project,
  RollbackResult,
  RuleInput,
  RuleTestResult,
  RuleValidation,
  SaveTextRequest,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SelectedPath,
  SoftwareAddRequest,
  SoftwareInspectResult,
  SoftwarePickMode,
  SoftwareScanRequest,
  SoftwareScanResult,
  SystemInfo
} from './types'

/**
 * The only API exposed to the renderer through `window.pathkeeper`.
 * Everything is request/response except scan progress, which is an event.
 */
export interface PathKeeperApi {
  projects: {
    list(): Promise<Project[]>
    /** Opens a native folder picker, then creates and opens the project. */
    add(): Promise<Project | null>
    addFromPath(rootPath: string): Promise<Project>
    remove(projectId: number): Promise<void>
    rename(projectId: number, name: string): Promise<Project>
    reveal(projectId: number): Promise<void>
    /** Copies the bundled beginner sample into userData and opens it. */
    loadSample(): Promise<Project>
  }

  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }

  paths: {
    preview(request: PathPreviewRequest): Promise<PathInfo>
  }

  /**
   * Read-only helper for users who do not know which old/new path to enter.
   * Finds path references whose target file is missing and suggests existing
   * files that may be the moved target.
   */
  autoCheck(projectId: number): Promise<AutoCheckResult>

  dependencies: {
    scan(projectId: number): Promise<DependencyScanResult>
    changes(projectId: number): Promise<DependencyChangesResult>
    startWatch(projectId: number): Promise<void>
    stopWatch(projectId: number): Promise<void>
    validateFix(request: DependencyValidateFixRequest): Promise<DependencyValidation>
    repair(request: DependencyValidateFixRequest): Promise<DependencyRepairResult>
    rebuildCache(projectId: number, paths: string[]): Promise<DependencyCacheRebuildResult>
    ignore(projectId: number, path: string, ignored: boolean): Promise<DependencyIgnoreResult>
  }

  scan(request: ScanRequest): Promise<ScanResult>
  /** Ask the main process to stop the currently running scan. */
  scanCancel(): Promise<void>
  apply(request: ApplyRequest): Promise<ApplyResult>

  /**
   * “扫描一个软件”: pick an .exe/.lnk or install directory, read-only inspect,
   * then add it as a software project and run the software health report.
   */
  software: {
    pick(mode: SoftwarePickMode): Promise<SoftwareInspectResult | null>
    inspect(absPath: string): Promise<SoftwareInspectResult>
    add(request: SoftwareAddRequest): Promise<Project>
    scan(request: SoftwareScanRequest): Promise<SoftwareScanResult>
  }

  /** Read-only previews used by beginner candidate cards (thumbnails/1-line code). */
  files: {
    preview(projectId: number, relativePath: string): Promise<FilePreview>
  }

  history: {
    list(projectId: number): Promise<MigrationRecord[]>
    rollback(migrationId: number): Promise<RollbackResult>
    remove(migrationId: number): Promise<void>
  }

  backups: {
    list(projectId: number): Promise<BackupRecord[]>
    remove(backupId: number): Promise<void>
    reveal(backupId: number): Promise<void>
  }

  rules: {
    list(projectId: number): Promise<MatchRule[]>
    add(projectId: number, input: RuleInput): Promise<MatchRule>
    update(ruleId: number, patch: Partial<RuleInput>): Promise<MatchRule>
    remove(ruleId: number): Promise<void>
    reset(projectId: number): Promise<MatchRule[]>
    validate(pattern: string, flags: string): Promise<RuleValidation>
    test(pattern: string, flags: string, sample: string): Promise<RuleTestResult>
  }

  ignores: {
    list(projectId: number): Promise<IgnoreRule[]>
    add(projectId: number, input: IgnoreInput): Promise<IgnoreRule>
    update(ruleId: number, patch: Partial<IgnoreInput>): Promise<IgnoreRule>
    remove(ruleId: number): Promise<void>
    reset(projectId: number): Promise<IgnoreRule[]>
  }

  dialogs: {
    pickProjectPath(request: PickPathRequest): Promise<SelectedPath | null>
    saveTextFile(request: SaveTextRequest): Promise<string | null>
  }

  system: {
    info(): Promise<SystemInfo>
    showProjectFile(projectId: number, relativePath: string): Promise<void>
  }

  events: {
    onScanProgress(handler: (progress: ScanProgress) => void): () => void
    onDependenciesChanged(
      handler: (changes: DependencyChangesResult) => void
    ): () => void
  }
}

/**
 * Turn every promise-returning method into an envelope-returning method.
 *
 * Electron's contextBridge recreates thrown errors in the renderer with only
 * `message`/`stack`, dropping custom properties such as `code`. Error codes are
 * a core part of PathKeeper's beginner-friendly UX, so the bridge transfers
 * failures as data (`IpcResponse`) and the renderer re-throws a real error with
 * `code`/`details` on its own side of the boundary.
 */
type Bridgeify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<IpcResponse<R>>
    : T[K] extends (...args: never[]) => unknown
      ? T[K]
      : T[K] extends object
        ? Bridgeify<T[K]>
        : T[K]
}

/** Shape exposed on `window.pathkeeper` by the preload script. */
export type PathKeeperBridgeApi = Bridgeify<PathKeeperApi>
