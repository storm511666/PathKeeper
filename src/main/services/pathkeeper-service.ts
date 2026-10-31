import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  ApplyRequest,
  ApplyResult,
  AutoCheckResult,
  BackupRecord,
  DependencyCacheRebuildResult,
  DependencyChangesResult,
  DependencyIgnoreResult,
  DependencyNode,
  DependencyRepairResult,
  DependencyScanResult,
  DependencyValidateFixRequest,
  DependencyValidation,
  FilePreview,
  IgnoreInput,
  IgnoreKind,
  IgnoreRule,
  MatchModes,
  MatchRule,
  MigrationRecord,
  PathInfo,
  PathKind,
  PathKindInput,
  PathPreviewRequest,
  Project,
  RollbackResult,
  RuleInput,
  RuleTestResult,
  RuleValidation,
  ScanOccurrence,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SelectedPath,
  SkippedOccurrence,
  SoftwareAddRequest,
  SoftwareInspectResult,
  SoftwareScanRequest,
  SoftwareScanResult
} from '../../shared/types'
import {
  applyTextEdits,
  autoCheckProject,
  decodeTextBuffer,
  diffDependencyNode,
  encodeTextBuffer,
  isAbortError,
  resolveMigrationPaths,
  scanDependencies,
  scanProject,
  testMatchRule,
  validateMatchRule
} from '../core'
import { scanSoftwarePackage } from '../core/softwareScan'
import { PathKeeperDatabase } from '../db/database'
import type { BackupRow, MigrationFileRow } from '../db/store'
import { PathKeeperStore } from '../db/store'
import { AppError, ERROR_CODES, errorMessage, isAppError } from '../errors'
import { previewProjectFile as renderFilePreview } from './file-preview'
import {
  assertPathInsideProject,
  createBackupFolderName,
  detectPathKind,
  directoryExists,
  fileExists,
  hashFileSync,
  isPathInside,
  listDirectoryNames,
  normalizeRelativePath,
  pathExists,
  removeDirectoryRecursive,
  resolveProjectPath,
  sha256Hex,
  splitRelativePath,
  toPosixPath,
  writeFileAtomicSync
} from './file-ops'
import {
  inspectSoftware,
  isSoftwareTargetError,
  parseSoftwareTarget
} from './software-info'

/** Folder (inside the project root) that receives every automatic backup. */
export const BACKUP_DIR_NAME = '.pathkeeper-backup'

const BACKUP_FILES_DIR = 'files'
const BACKUP_MANIFEST_FILE = 'manifest.json'
const BACKUP_FORMAT = 'pathkeeper-backup'
const BACKUP_FORMAT_VERSION = 1

/** Cached scan results expire after 30 minutes. */
const SCAN_SESSION_TTL_MS = 30 * 60 * 1000
/** At most this many scan sessions are kept in memory. */
const MAX_SCAN_SESSIONS = 12

const MAX_FILE_SIZE_KB_LIMIT = 1_048_576
const MAX_PROJECT_NAME_LENGTH = 120
const MAX_RULE_NAME_LENGTH = 120
const MAX_RULE_PATTERN_LENGTH = 4000
const MAX_IGNORE_PATTERN_LENGTH = 500

const RULE_CATEGORIES = new Set([
  'markdown',
  'code',
  'config',
  'web',
  'workflow',
  'text',
  'custom'
])
const IGNORE_KINDS = new Set<IgnoreKind>(['dir', 'suffix', 'glob'])
const KIND_INPUTS = new Set<PathKindInput>(['file', 'directory', 'auto'])
const BASE_RULE_FLAGS = 'imsu'

export interface ProjectRemovalInfo {
  projectId: number
  rootPath: string
  /** Absolute `.pathkeeper-backup` directory; backups are intentionally kept. */
  backupRoot: string
  /** Absolute paths of backup folders retained on disk. */
  backupsRetained: string[]
}

interface CachedSnapshot {
  filePath: string
  size: number
  mtimeMs: number
  hash: string
}

interface ScanSession {
  token: string
  result: ScanResult
  snapshots: Map<string, CachedSnapshot>
  projectId: number
  projectRoot: string
  createdAtMs: number
  lastUsedAtMs: number
}

interface PreparedFile {
  relPath: string
  absPath: string
  originalBuffer: Buffer
  newBuffer: Buffer
  preHash: string
  postHash: string
  replacements: number
}

interface BackupManifest {
  format: string
  version: number
  createdAt: string
  projectId: number
  projectName: string
  migrationId: number
  oldPath: string
  newPath: string
  kind: PathKind
  modes: MatchModes
  files: Array<{
    path: string
    backupPath: string
    size: number
    hash: string
    replacements: number
  }>
}

/** Normalize a path for snapshot lookups: always posix and project-relative. */
function snapshotKey(filePath: string): string {
  return normalizeRelativePath(toPosixPath(filePath))
}

type BomKind = 'utf8' | 'utf16le' | 'utf16be'

const BOM_BYTES: Record<BomKind, Buffer> = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
  utf16le: Buffer.from([0xff, 0xfe]),
  utf16be: Buffer.from([0xfe, 0xff])
}

function detectBom(buffer: Buffer): BomKind | null {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_BYTES.utf8)) return 'utf8'
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_BYTES.utf16le)) return 'utf16le'
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_BYTES.utf16be)) return 'utf16be'
  return null
}

/**
 * Never let a write change a file's BOM contract: keep the original BOM on the
 * re-encoded buffer (the core encoding model folds UTF-16 BOMs into the
 * encoding name, so the service reconciles the bytes explicitly).
 */
function reconcileBom(original: Buffer, encoded: Buffer): Buffer {
  const originalBom = detectBom(original)
  const encodedBom = detectBom(encoded)
  if (originalBom === null) {
    if (encodedBom === null) return encoded
    return Buffer.from(encoded.subarray(BOM_BYTES[encodedBom].length))
  }
  if (encodedBom === originalBom) return encoded
  const body = encodedBom === null ? encoded : encoded.subarray(BOM_BYTES[encodedBom].length)
  return Buffer.concat([BOM_BYTES[originalBom], body])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * PathKeeperService owns the SQLite database, the filesystem side of applying
 * and rolling back migrations, and the in-memory scan session cache.
 *
 * It deliberately has no Electron imports: `ipc.ts` wires it to the renderer
 * and native dialogs, which keeps the service fully testable with a temp
 * `userDataPath`.
 */
export interface PathKeeperServiceOptions {
  /** Absolute directory of the bundled beginner sample. */
  sampleProjectDir?: string
}

export class PathKeeperService {
  private readonly userDataPath: string
  private readonly sampleProjectDir: string | null
  private db: PathKeeperDatabase | null = null
  private store: PathKeeperStore | null = null
  private closed = false

  private readonly scanSessions = new Map<string, ScanSession>()
  private activeScan: AbortController | null = null
  private activeDependencyScan: AbortController | null = null
  private activeSoftwareScan: AbortController | null = null
  private operationQueue: Promise<unknown> = Promise.resolve()
  private readonly dependencySnapshots = new Map<number, DependencyScanResult>()
  private readonly dependencyWatchers = new Map<number, NodeJS.Timeout>()
  private readonly dependencyWatchBusy = new Set<number>()
  private readonly dependencyWatchSignals = new Map<number, string>()

  constructor(userDataPath: string, options: PathKeeperServiceOptions = {}) {
    if (typeof userDataPath !== 'string' || userDataPath.trim().length === 0) {
      throw new AppError(ERROR_CODES.validation, '用户数据目录无效。')
    }
    this.userDataPath = resolve(userDataPath)
    this.sampleProjectDir = options.sampleProjectDir ? resolve(options.sampleProjectDir) : null
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.db) return
    this.closed = false
    const database = new PathKeeperDatabase(this.userDataPath)
    try {
      const store = new PathKeeperStore(database)
      store.initialize()
      this.db = database
      this.store = store
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.activeScan?.abort()
    this.activeScan = null
    this.activeDependencyScan?.abort()
    this.activeDependencyScan = null
    this.activeSoftwareScan?.abort()
    this.activeSoftwareScan = null
    this.scanSessions.clear()
    for (const timer of this.dependencyWatchers.values()) clearInterval(timer)
    this.dependencyWatchers.clear()
    this.dependencySnapshots.clear()
    this.dependencyWatchBusy.clear()
    this.db?.close()
    this.db = null
    this.store = null
  }

  /**
   * User pressed “停止扫描”. Aborting is cooperative: the running engine stops
   * at its next checkpoint and the pending IPC call rejects with
   * SCAN_CANCELLED. Nothing has been written at that point.
   */
  cancelScan(): void {
    this.activeScan?.abort()
    this.activeDependencyScan?.abort()
    this.activeSoftwareScan?.abort()
  }

  getUserDataPath(): string {
    return this.userDataPath
  }

  getDatabasePath(): string {
    return join(this.userDataPath, 'pathkeeper.sqlite')
  }

  private requireStore(): PathKeeperStore {
    if (!this.store) {
      throw new AppError(ERROR_CODES.dbNotOpen, '数据库尚未初始化。')
    }
    return this.store
  }

  // ---------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------

  listProjects(): Project[] {
    return this.requireStore().listProjects()
  }

  getProject(projectId: number): Project {
    return this.requireProject(projectId)
  }

  addProjectFromPath(rootPath: string): Project {
    const store = this.requireStore()
    const rootInput = this.requireText(rootPath, 'rootPath', 32_767)
    if (!isAbsolute(rootInput)) {
      throw new AppError(ERROR_CODES.projectRootInvalid, '项目路径必须是绝对路径。', {
        rootPath: rootInput
      })
    }
    const normalized = this.normalizeProjectRoot(rootInput)
    const existing = store.findProjectByRootKey(normalized.rootKey)
    if (existing) {
      const now = new Date().toISOString()
      store.transaction(() => {
        store.touchProject(existing.id, now)
        this.setLastProjectIdInternal(existing.id)
      })
      return { ...existing, lastOpenedAt: now }
    }

    const now = new Date().toISOString()
    const project = store.transaction(() => {
      const created = store.insertProject({
        name: normalized.name,
        rootPath: normalized.rootPath,
        rootKey: normalized.rootKey,
        createdAt: now
      })
      store.ensureBuiltinRules(created.id, now)
      this.setLastProjectIdInternal(created.id)
      return created
    })
    return project
  }

  /**
   * Copy the bundled beginner sample into userData and open it. This never
   * touches the installed sample directory, so the user can freely apply fixes
   * and reset by loading the sample again.
   */
  loadSampleProject(): Project {
    if (!this.sampleProjectDir) {
      throw new AppError(ERROR_CODES.fileNotFound, '这份安装包没有内置示例工程。', {
        sampleProjectDir: null
      })
    }
    if (!existsSync(this.sampleProjectDir)) {
      throw new AppError(ERROR_CODES.fileNotFound, '内置示例工程文件缺失。', {
        sampleProjectDir: this.sampleProjectDir
      })
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const targetDir = join(this.userDataPath, 'samples', `beginner-sample-${stamp}`)
    try {
      mkdirSync(dirname(targetDir), { recursive: true })
      cpSync(this.sampleProjectDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true
      })
      const project = this.addProjectFromPath(targetDir)
      return this.renameProject(project.id, '新手示例工程')
    } catch (error) {
      try {
        rmSync(targetDir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup only.
      }
      throw new AppError(
        ERROR_CODES.internal,
        `示例工程加载失败：${errorMessage(error)}`,
        { sampleProjectDir: this.sampleProjectDir }
      )
    }
  }

  renameProject(projectId: number, name: string): Project {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    const nextName = this.requireText(name, 'name', MAX_PROJECT_NAME_LENGTH)
    const renamed = store.renameProject(project.id, nextName)
    if (!renamed) {
      throw new AppError(ERROR_CODES.projectNotFound, '项目不存在或已被移除。', { projectId })
    }
    return renamed
  }

  /**
   * Remove a project from the database. Backups on disk are intentionally left
   * behind; the returned info tells the UI where they are.
   */
  removeProject(projectId: number): ProjectRemovalInfo {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    const backupRoot = join(project.rootPath, BACKUP_DIR_NAME)

    const retained = new Set<string>()
    for (const backup of store.listAllBackups(project.id)) {
      if (backup.removed) continue
      if (pathExists(backup.absPath)) retained.add(resolve(backup.absPath))
    }
    for (const name of listDirectoryNames(backupRoot)) {
      if (name.startsWith('.')) continue
      const candidate = join(backupRoot, name)
      if (directoryExists(candidate)) retained.add(candidate)
    }

    store.transaction(() => {
      store.deleteProject(project.id)
      const settings = store.getSettings()
      if (settings.lastProjectId === project.id) {
        store.writeSettings({ ...settings, lastProjectId: null })
      }
    })

    for (const [token, session] of this.scanSessions) {
      if (session.projectId === project.id) this.scanSessions.delete(token)
    }
    this.stopDependencyWatch(project.id)
    this.dependencySnapshots.delete(project.id)

    return {
      projectId: project.id,
      rootPath: project.rootPath,
      backupRoot,
      backupsRetained: [...retained]
    }
  }

  /** Absolute `.pathkeeper-backup` folder for a project. */
  getProjectBackupRoot(projectId: number): string {
    return join(this.requireProject(projectId).rootPath, BACKUP_DIR_NAME)
  }

  /** Resolve an absolute path the user picked to a safe project-relative path. */
  describeProjectPath(projectId: number, absPath: string): SelectedPath {
    const project = this.requireProject(projectId)
    const abs = resolve(this.requireText(absPath, 'absPath', 32_767))
    assertPathInsideProject(project.rootPath, abs)
    const relPath = normalizeRelativePath(relative(resolve(project.rootPath), abs))
    if (!relPath) {
      throw new AppError(ERROR_CODES.pathInvalid, '请选择项目内的文件或文件夹。')
    }
    const kind = detectPathKind(abs)
    if (!kind) {
      throw new AppError(ERROR_CODES.fileNotFound, '所选路径不存在。', { absPath: abs })
    }
    return { absPath: abs, relPath, exists: true, kind }
  }

  /** Resolve a project-relative path for `system.showProjectFile`. */
  resolveProjectFile(projectId: number, relativePath: string): SelectedPath {
    const project = this.requireProject(projectId)
    const { absPath, relPath } = resolveProjectPath(project.rootPath, relativePath)
    const kind = detectPathKind(absPath)
    if (!kind) {
      throw new AppError(ERROR_CODES.fileNotFound, '文件不存在或已被移除。', { relativePath })
    }
    return { absPath, relPath, exists: true, kind }
  }

  /** Bounded, read-only preview used by beginner candidate cards. */
  previewFile(projectId: number, relativePath: string): Promise<FilePreview> {
    const project = this.requireProject(projectId)
    return renderFilePreview(project.rootPath, relativePath)
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  getSettings(): AppSettings {
    const store = this.requireStore()
    const settings = store.getSettings()
    if (settings.lastProjectId !== null && !store.getProject(settings.lastProjectId)) {
      // Self-heal a dangling pointer (e.g. database edited outside the app).
      settings.lastProjectId = null
      store.writeSettings(settings)
    }
    return settings
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const store = this.requireStore()
    if (!isPlainObject(patch)) {
      throw new AppError(ERROR_CODES.settingsInvalid, '设置项无效。')
    }
    const allowedKeys = new Set([
      'lastProjectId',
      'matchModes',
      'caseSensitive',
      'maxFileSizeKb',
      'beginnerMode',
      'dependencyCheckEnabled',
      'dependencyAutoScanOnOpen',
      'dependencyAutoWatch',
      'dependencyAutoRepair'
    ])
    const unknownKeys = Object.keys(patch).filter((key) => !allowedKeys.has(key))
    if (unknownKeys.length > 0) {
      throw new AppError(ERROR_CODES.settingsInvalid, '设置中包含未知字段。', { unknownKeys })
    }

    const current = store.getSettings()
    const patchRecord = patch as Record<string, unknown>
    const merged: AppSettings = {
      lastProjectId:
        patchRecord['lastProjectId'] === undefined
          ? current.lastProjectId
          : this.validateLastProjectId(patchRecord['lastProjectId']),
      matchModes:
        patchRecord['matchModes'] === undefined
          ? current.matchModes
          : this.validateMatchModes(patchRecord['matchModes']),
      caseSensitive:
        patchRecord['caseSensitive'] === undefined
          ? current.caseSensitive
          : this.validateBoolean(patchRecord['caseSensitive'], 'caseSensitive'),
      maxFileSizeKb:
        patchRecord['maxFileSizeKb'] === undefined
          ? current.maxFileSizeKb
          : this.validateMaxFileSizeKb(patchRecord['maxFileSizeKb']),
      beginnerMode:
        patchRecord['beginnerMode'] === undefined
          ? current.beginnerMode
          : this.validateBoolean(patchRecord['beginnerMode'], 'beginnerMode'),
      dependencyCheckEnabled:
        patchRecord['dependencyCheckEnabled'] === undefined
          ? current.dependencyCheckEnabled
          : this.validateBoolean(patchRecord['dependencyCheckEnabled'], 'dependencyCheckEnabled'),
      dependencyAutoScanOnOpen:
        patchRecord['dependencyAutoScanOnOpen'] === undefined
          ? current.dependencyAutoScanOnOpen
          : this.validateBoolean(
              patchRecord['dependencyAutoScanOnOpen'],
              'dependencyAutoScanOnOpen'
            ),
      dependencyAutoWatch:
        patchRecord['dependencyAutoWatch'] === undefined
          ? current.dependencyAutoWatch
          : this.validateBoolean(patchRecord['dependencyAutoWatch'], 'dependencyAutoWatch'),
      dependencyAutoRepair:
        patchRecord['dependencyAutoRepair'] === undefined
          ? current.dependencyAutoRepair
          : this.validateBoolean(patchRecord['dependencyAutoRepair'], 'dependencyAutoRepair')
    }
    store.writeSettings(merged)
    return merged
  }

  private setLastProjectIdInternal(projectId: number | null): void {
    const store = this.requireStore()
    const settings = store.getSettings()
    store.writeSettings({ ...settings, lastProjectId: projectId })
  }

  private validateLastProjectId(value: unknown): number | null {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new AppError(ERROR_CODES.settingsInvalid, 'lastProjectId 必须是项目 ID 或 null。', {
        field: 'lastProjectId'
      })
    }
    const project = this.requireStore().getProject(value)
    if (!project) {
      throw new AppError(ERROR_CODES.projectNotFound, 'lastProjectId 指向的项目不存在。', {
        field: 'lastProjectId',
        projectId: value
      })
    }
    return value
  }

  private validateMatchModes(value: unknown): MatchModes {
    if (!isPlainObject(value)) {
      throw new AppError(ERROR_CODES.settingsInvalid, 'matchModes 必须是对象。', {
        field: 'matchModes'
      })
    }
    const allowedKeys = new Set(['strict', 'basename', 'directory'])
    const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key))
    if (unknownKeys.length > 0) {
      throw new AppError(ERROR_CODES.settingsInvalid, 'matchModes 包含未知字段。', {
        field: 'matchModes',
        unknownKeys
      })
    }
    const strict = this.validateBoolean(value['strict'], 'matchModes.strict')
    const basename = this.validateBoolean(value['basename'], 'matchModes.basename')
    const directory = this.validateBoolean(value['directory'], 'matchModes.directory')
    if (!strict && !basename && !directory) {
      throw new AppError(ERROR_CODES.settingsInvalid, '至少需要启用一种匹配模式。', {
        field: 'matchModes'
      })
    }
    return { strict, basename, directory }
  }

  private validateBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw new AppError(ERROR_CODES.settingsInvalid, `${field} 必须是布尔值。`, { field })
    }
    return value
  }

  private validateMaxFileSizeKb(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_FILE_SIZE_KB_LIMIT
    ) {
      throw new AppError(
        ERROR_CODES.settingsInvalid,
        `最大文件大小必须是 1 到 ${MAX_FILE_SIZE_KB_LIMIT} 之间的整数 KB。`,
        { field: 'maxFileSizeKb' }
      )
    }
    return value
  }

  // ---------------------------------------------------------------------
  // Match rules
  // ---------------------------------------------------------------------

  listMatchRules(projectId: number): MatchRule[] {
    const project = this.requireProject(projectId)
    return this.requireStore().listMatchRules(project.id)
  }

  addMatchRule(projectId: number, input: RuleInput): MatchRule {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    if (!isPlainObject(input)) {
      throw new AppError(ERROR_CODES.ruleInvalid, '匹配规则参数无效。')
    }
    const validated = this.validateRuleInput(input, null)
    const now = new Date().toISOString()
    return store.insertMatchRule({
      projectId: project.id,
      ruleKey: `custom-${randomUUID()}`,
      name: validated.name,
      description: validated.description,
      category: validated.category,
      pattern: validated.pattern,
      flags: validated.flags,
      enabled: validated.enabled,
      builtin: false,
      priority: validated.priority,
      createdAt: now,
      updatedAt: now
    })
  }

  updateMatchRule(ruleId: number, patch: Partial<RuleInput>): MatchRule {
    const store = this.requireStore()
    const existing = store.getMatchRule(this.requireId(ruleId, 'ruleId'))
    if (!existing) {
      throw new AppError(ERROR_CODES.ruleNotFound, '匹配规则不存在。', { ruleId })
    }
    if (!isPlainObject(patch)) {
      throw new AppError(ERROR_CODES.ruleInvalid, '匹配规则参数无效。')
    }
    const merged = this.validateRuleInput(
      {
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        category: patch.category ?? existing.category,
        pattern: patch.pattern ?? existing.pattern,
        flags: patch.flags ?? existing.flags,
        enabled: patch.enabled ?? existing.enabled,
        priority: patch.priority ?? existing.priority
      },
      existing
    )
    const updated = store.updateMatchRule(existing.id, {
      name: merged.name,
      description: merged.description,
      category: merged.category,
      pattern: merged.pattern,
      flags: merged.flags,
      enabled: merged.enabled,
      priority: merged.priority,
      updatedAt: new Date().toISOString()
    })
    if (!updated) {
      throw new AppError(ERROR_CODES.ruleNotFound, '匹配规则不存在。', { ruleId })
    }
    return updated
  }

  removeMatchRule(ruleId: number): void {
    const store = this.requireStore()
    const existing = store.getMatchRule(this.requireId(ruleId, 'ruleId'))
    if (!existing) {
      throw new AppError(ERROR_CODES.ruleNotFound, '匹配规则不存在。', { ruleId })
    }
    if (existing.builtin) {
      throw new AppError(
        ERROR_CODES.ruleBuiltinProtected,
        '内置匹配规则可以编辑或停用，但不能删除。',
        { ruleId }
      )
    }
    if (!store.deleteMatchRule(existing.id)) {
      throw new AppError(ERROR_CODES.ruleNotFound, '匹配规则不存在。', { ruleId })
    }
  }

  resetMatchRules(projectId: number): MatchRule[] {
    const project = this.requireProject(projectId)
    return this.requireStore().resetBuiltinMatchRules(project.id)
  }

  validateMatchRule(pattern: string, flags: string): RuleValidation {
    const patternText = this.requireText(pattern, 'pattern', MAX_RULE_PATTERN_LENGTH)
    return validateMatchRule(patternText, this.sanitizeRuleFlags(flags))
  }

  testMatchRule(pattern: string, flags: string, sample: string): RuleTestResult {
    const patternText = this.requireText(pattern, 'pattern', MAX_RULE_PATTERN_LENGTH)
    if (typeof sample !== 'string') {
      throw new AppError(ERROR_CODES.validation, 'sample 必须是字符串。')
    }
    if (sample.length > 20_000) {
      throw new AppError(ERROR_CODES.validation, '测试样本过长。')
    }
    return testMatchRule(patternText, this.sanitizeRuleFlags(flags), sample)
  }

  private validateRuleInput(
    input: RuleInput,
    existing: MatchRule | null
  ): {
    name: string
    description: string
    category: RuleInput['category']
    pattern: string
    flags: string
    enabled: boolean
    priority: number
  } {
    const name = this.requireText(input.name, 'name', MAX_RULE_NAME_LENGTH)
    const description =
      typeof input.description === 'string' ? input.description.trim().slice(0, 1000) : ''
    const category = input.category
    if (typeof category !== 'string' || !RULE_CATEGORIES.has(category)) {
      throw new AppError(ERROR_CODES.ruleInvalid, '匹配规则分类无效。', {
        field: 'category',
        category
      })
    }
    const pattern = this.requireText(input.pattern, 'pattern', MAX_RULE_PATTERN_LENGTH)
    const flags = this.sanitizeRuleFlags(input.flags ?? '')
    const validation = validateMatchRule(pattern, flags)
    if (!validation.valid) {
      throw new AppError(ERROR_CODES.ruleInvalid, validation.error ?? '正则表达式无效。', {
        field: 'pattern',
        pattern,
        flags,
        captureGroup: validation.captureGroup
      })
    }
    if (typeof input.enabled !== 'boolean') {
      throw new AppError(ERROR_CODES.ruleInvalid, 'enabled 必须是布尔值。', { field: 'enabled' })
    }
    let priority: number
    if (input.priority === undefined) {
      priority = existing ? existing.priority : 50
    } else if (
      typeof input.priority !== 'number' ||
      !Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 10_000
    ) {
      throw new AppError(ERROR_CODES.ruleInvalid, 'priority 必须是 0 到 10000 的整数。', {
        field: 'priority'
      })
    } else {
      priority = input.priority
    }
    return { name, description, category, pattern, flags, enabled: input.enabled, priority }
  }

  private sanitizeRuleFlags(flags: unknown): string {
    if (typeof flags !== 'string') {
      throw new AppError(ERROR_CODES.ruleInvalid, 'flags 必须是字符串。', { field: 'flags' })
    }
    const unsupported = [...flags].filter((flag) => !BASE_RULE_FLAGS.includes(flag) && flag !== 'g' && flag !== 'd')
    if (unsupported.length > 0) {
      throw new AppError(ERROR_CODES.ruleInvalid, 'flags 中包含不支持的标记。', {
        field: 'flags',
        unsupported
      })
    }
    const unique = new Set([...flags].filter((flag) => BASE_RULE_FLAGS.includes(flag)))
    return [...BASE_RULE_FLAGS].filter((flag) => unique.has(flag)).join('')
  }

  // ---------------------------------------------------------------------
  // Ignore rules
  // ---------------------------------------------------------------------

  listIgnoreRules(projectId: number): IgnoreRule[] {
    const project = this.requireProject(projectId)
    return this.requireStore().listIgnoreRules(project.id)
  }

  addIgnoreRule(projectId: number, input: IgnoreInput): IgnoreRule {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    if (!isPlainObject(input)) {
      throw new AppError(ERROR_CODES.ignoreInvalid, '忽略规则参数无效。')
    }
    const validated = this.validateIgnoreInput(input, true)
    const existing = store.listIgnoreRules(project.id)
    const maxSortOrder = existing.reduce((max, rule) => Math.max(max, rule.sortOrder), 0)
    const kind = validated.kind
    const now = new Date().toISOString()
    return store.insertIgnoreRule({
      projectId: project.id,
      ruleKey: `custom-${randomUUID()}`,
      pattern: validated.pattern,
      kind,
      label: validated.label,
      enabled: validated.enabled,
      builtin: false,
      sortOrder: maxSortOrder + 1,
      createdAt: now
    })
  }

  updateIgnoreRule(ruleId: number, patch: Partial<IgnoreInput>): IgnoreRule {
    const store = this.requireStore()
    const existing = store.getIgnoreRule(this.requireId(ruleId, 'ruleId'))
    if (!existing) {
      throw new AppError(ERROR_CODES.ignoreNotFound, '忽略规则不存在。', { ruleId })
    }
    if (!isPlainObject(patch)) {
      throw new AppError(ERROR_CODES.ignoreInvalid, '忽略规则参数无效。')
    }
    const validated = this.validateIgnoreInput(
      {
        pattern: patch.pattern ?? existing.pattern,
        kind: patch.kind ?? existing.kind,
        label: patch.label ?? existing.label,
        enabled: patch.enabled ?? existing.enabled
      },
      false
    )
    const updated = store.updateIgnoreRule(existing.id, {
      pattern: validated.pattern,
      kind: validated.kind,
      label: validated.label,
      enabled: validated.enabled
    })
    if (!updated) {
      throw new AppError(ERROR_CODES.ignoreNotFound, '忽略规则不存在。', { ruleId })
    }
    return updated
  }

  removeIgnoreRule(ruleId: number): void {
    const store = this.requireStore()
    const existing = store.getIgnoreRule(this.requireId(ruleId, 'ruleId'))
    if (!existing) {
      throw new AppError(ERROR_CODES.ignoreNotFound, '忽略规则不存在。', { ruleId })
    }
    if (existing.builtin) {
      throw new AppError(
        ERROR_CODES.ignoreBuiltinProtected,
        '内置忽略规则可以编辑或停用，但不能删除。',
        { ruleId }
      )
    }
    if (!store.deleteIgnoreRule(existing.id)) {
      throw new AppError(ERROR_CODES.ignoreNotFound, '忽略规则不存在。', { ruleId })
    }
  }

  resetIgnoreRules(projectId: number): IgnoreRule[] {
    const project = this.requireProject(projectId)
    return this.requireStore().resetBuiltinIgnoreRules(project.id)
  }

  private validateIgnoreInput(
    input: IgnoreInput,
    requireAll: boolean
  ): { pattern: string; kind: IgnoreKind; label: string; enabled: boolean } {
    const rawPattern = this.requireText(input.pattern, 'pattern', MAX_IGNORE_PATTERN_LENGTH)
    const kind = input.kind
    if (typeof kind !== 'string' || !IGNORE_KINDS.has(kind)) {
      throw new AppError(ERROR_CODES.ignoreInvalid, '忽略规则类型无效。', {
        field: 'kind',
        kind
      })
    }
    let pattern = rawPattern
    if (kind === 'suffix') {
      pattern = pattern.startsWith('.') ? pattern : `.${pattern}`
      if (pattern.length < 2) {
        throw new AppError(ERROR_CODES.ignoreInvalid, '后缀规则必须包含扩展名。', {
          field: 'pattern'
        })
      }
    } else if (kind === 'dir') {
      pattern = pattern.replace(/[\\/]+$/, '')
      if (/[\\/]/.test(pattern)) {
        throw new AppError(ERROR_CODES.ignoreInvalid, '目录规则只能填写目录名称。', {
          field: 'pattern'
        })
      }
    }
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim().slice(0, 200)
        : pattern
    let enabled = true
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') {
        throw new AppError(ERROR_CODES.ignoreInvalid, 'enabled 必须是布尔值。', {
          field: 'enabled'
        })
      }
      enabled = input.enabled
    } else if (requireAll) {
      enabled = true
    }
    return { pattern, kind, label, enabled }
  }

  // ---------------------------------------------------------------------
  // Path preview
  // ---------------------------------------------------------------------

  previewPaths(request: PathPreviewRequest): PathInfo {
    if (!isPlainObject(request)) {
      throw new AppError(ERROR_CODES.validation, '路径预览参数无效。')
    }
    const project = this.requireProject(request.projectId)
    const oldPath = this.requireText(request.oldPath, 'oldPath', 32_767)
    const newPath = this.requireText(request.newPath, 'newPath', 32_767)
    const kind = this.validateKindInput(request.kind)
    return this.resolvePaths(project, oldPath, newPath, kind)
  }

  private resolvePaths(
    project: Project,
    oldPath: string,
    newPath: string,
    kind: PathKindInput
  ): PathInfo {
    try {
      return resolveMigrationPaths(project.rootPath, oldPath, newPath, kind)
    } catch (error) {
      if (isAppError(error)) throw error
      const coreCode = (error as { code?: unknown } | null)?.code
      throw new AppError(ERROR_CODES.pathInvalid, errorMessage(error), {
        oldPath,
        newPath,
        kind,
        ...(typeof coreCode === 'string' ? { coreCode } : {})
      })
    }
  }

  // ---------------------------------------------------------------------
  // Automatic broken-reference check
  // ---------------------------------------------------------------------

  async autoCheck(projectId: number): Promise<AutoCheckResult> {
    const store = this.requireStore()
    const project = this.requireProject(this.requireId(projectId, 'projectId'))
    const settings = this.getSettings()
    const rules = store.listMatchRules(project.id).filter((rule) => rule.enabled)
    if (rules.length === 0) {
      throw new AppError(ERROR_CODES.scanFailed, '没有启用的匹配规则，无法自动检查。', {
        projectId: project.id
      })
    }
    const ignoreRules = store.listIgnoreRules(project.id).filter((rule) => rule.enabled)
    try {
      return await autoCheckProject({
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        rules,
        ignoreRules,
        caseSensitive: settings.caseSensitive,
        maxFileSizeKb: settings.maxFileSizeKb
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw new AppError(ERROR_CODES.scanFailed, '自动检查已取消。', { projectId: project.id })
      }
      const coreCode = (error as { code?: unknown } | null)?.code
      throw new AppError(
        ERROR_CODES.scanFailed,
        `自动检查失败：${errorMessage(error)}`,
        {
          projectId: project.id,
          ...(typeof coreCode === 'string' ? { coreCode } : {})
        }
      )
    }
  }

  private validateKindInput(value: unknown): PathKindInput {
    if (typeof value !== 'string' || !KIND_INPUTS.has(value as PathKindInput)) {
      throw new AppError(ERROR_CODES.validation, '迁移类型必须是 file、directory 或 auto。', {
        field: 'kind',
        kind: value
      })
    }
    return value as PathKindInput
  }

  // ---------------------------------------------------------------------
  // Dependency health
  // ---------------------------------------------------------------------

  async scanDependencies(projectId: number): Promise<DependencyScanResult> {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    const settings = this.getSettings()
    if (!settings.dependencyCheckEnabled) {
      throw new AppError(
        ERROR_CODES.dependencyDisabled,
        '智能检查已在设置中关闭。你可以先打开“智能检查”，或继续使用手动路径迁移。'
      )
    }
    const rules = store.listMatchRules(project.id).filter((rule) => rule.enabled)
    if (rules.length === 0) {
      throw new AppError(ERROR_CODES.scanFailed, '没有启用的匹配规则，无法进行智能检查。', {
        projectId: project.id
      })
    }

    this.activeDependencyScan?.abort()
    const controller = new AbortController()
    this.activeDependencyScan = controller
    try {
      const result = await scanDependencies({
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        rules,
        ignoreRules: store.listIgnoreRules(project.id).filter((rule) => rule.enabled),
        caseSensitive: settings.caseSensitive,
        maxFileSizeKb: settings.maxFileSizeKb,
        ignoredPaths: store.listDependencyIgnores(project.id),
        signal: controller.signal
      })
      this.dependencySnapshots.set(project.id, result)
      this.dependencyWatchSignals.delete(project.id)
      return result
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError(ERROR_CODES.scanCancelled, '体检已取消。')
      }
      throw error
    } finally {
      if (this.activeDependencyScan === controller) this.activeDependencyScan = null
    }
  }

  async checkDependencyChanges(projectId: number): Promise<DependencyChangesResult> {
    const project = this.requireProject(projectId)
    let snapshot = this.dependencySnapshots.get(project.id)
    if (!snapshot) snapshot = await this.scanDependencies(project.id)
    const changes = []
    for (const node of snapshot.nodes) {
      const change = diffDependencyNode(project.rootPath, node)
      if (change) changes.push(change)
    }
    return {
      changed: changes.length > 0,
      changes,
      checkedAt: new Date().toISOString()
    }
  }

  startDependencyWatch(
    projectId: number,
    onChange: (changes: DependencyChangesResult) => void
  ): void {
    const project = this.requireProject(projectId)
    const settings = this.getSettings()
    if (!settings.dependencyCheckEnabled || !settings.dependencyAutoWatch) return
    this.stopDependencyWatch(project.id)
    const timer = setInterval(() => {
      void this.tickDependencyWatch(project.id, onChange)
    }, 4000)
    timer.unref?.()
    this.dependencyWatchers.set(project.id, timer)
  }

  stopDependencyWatch(projectId?: number): void {
    if (typeof projectId === 'number') {
      const timer = this.dependencyWatchers.get(projectId)
      if (timer) clearInterval(timer)
      this.dependencyWatchers.delete(projectId)
      this.dependencyWatchSignals.delete(projectId)
      return
    }
    for (const timer of this.dependencyWatchers.values()) clearInterval(timer)
    this.dependencyWatchers.clear()
    this.dependencyWatchSignals.clear()
  }

  private async tickDependencyWatch(
    projectId: number,
    onChange: (changes: DependencyChangesResult) => void
  ): Promise<void> {
    if (this.closed || this.dependencyWatchBusy.has(projectId)) return
    this.dependencyWatchBusy.add(projectId)
    try {
      // If the user disabled auto-scan and has not run a scan yet, do not let
      // the watcher silently perform the initial scan.
      if (!this.dependencySnapshots.has(projectId)) return
      const changes = await this.checkDependencyChanges(projectId)
      if (!changes.changed) {
        this.dependencyWatchSignals.delete(projectId)
        return
      }
      const signature = changes.changes
        .map((change) => `${change.kind}:${change.path}`)
        .sort()
        .join('|')
      if (this.dependencyWatchSignals.get(projectId) === signature) return
      this.dependencyWatchSignals.set(projectId, signature)
      onChange(changes)
    } catch {
      // A transient scan/watcher failure must never crash the app.
    } finally {
      this.dependencyWatchBusy.delete(projectId)
    }
  }

  validateDependencyFix(request: DependencyValidateFixRequest): DependencyValidation {
    if (!isPlainObject(request)) {
      throw new AppError(ERROR_CODES.validation, '修复参数无效。')
    }
    const project = this.requireProject(request.projectId)
    const oldPath = this.requireText(request.oldPath, 'oldPath', 32_767)
    const newPath = this.requireText(request.newPath, 'newPath', 32_767)
    try {
      const resolved = resolveMigrationPaths(project.rootPath, oldPath, newPath, 'file')
      const errors: string[] = []
      const warnings: string[] = []
      if (!fileExists(resolved.newAbs)) {
        errors.push('新位置里没有找到这个文件。请先确认文件已经移动/复制到项目里。')
      } else {
        const stats = statSync(resolved.newAbs)
        if (!stats.isFile()) {
          errors.push('你选的是文件夹，但这里需要选择一个具体文件。')
        } else if (stats.size === 0) {
          warnings.push('这个文件是空的（0 字节），修复后程序可能仍然读不到内容。')
        }
        try {
          accessSync(resolved.newAbs, fsConstants.R_OK)
        } catch {
          errors.push('这个文件当前没有读取权限，或正被其他程序占用。请关闭相关程序后再试。')
        }
      }
      if (pathExists(resolved.oldAbs)) {
        const oldStats = statSync(resolved.oldAbs)
        if (oldStats.isDirectory()) {
          errors.push('旧位置目前是一个文件夹；这个快速修复只处理单个文件。')
        }
      }
      const oldExt = extname(resolved.oldRel).toLowerCase()
      const newExt = extname(resolved.newRel).toLowerCase()
      if (oldExt && newExt && oldExt !== newExt) {
        warnings.push(`旧文件是 ${oldExt}，新文件是 ${newExt}；请确认扩展名变化是有意的。`)
      }
      return {
        valid: errors.length === 0,
        errors,
        warnings,
        oldPath: resolved.oldRel,
        newPath: resolved.newRel
      }
    } catch (error) {
      return {
        valid: false,
        errors: [`路径检查未通过：${errorMessage(error)}`],
        warnings: [],
        oldPath,
        newPath
      }
    }
  }

  async repairDependencyPath(request: DependencyValidateFixRequest): Promise<DependencyRepairResult> {
    const validation = this.validateDependencyFix(request)
    if (!validation.valid) {
      throw new AppError(
        ERROR_CODES.dependencyPreflightFailed,
        validation.errors[0] ?? '修复前检查未通过。',
        { errors: validation.errors, warnings: validation.warnings }
      )
    }
    const project = this.requireProject(request.projectId)
    const settings = this.getSettings()
    const scan = await this.scan({
      projectId: project.id,
      oldPath: validation.oldPath,
      newPath: validation.newPath,
      kind: 'file',
      modes: settings.matchModes
    })
    if (scan.items.length === 0) {
      throw new AppError(
        ERROR_CODES.dependencyRepairEmpty,
        '没有找到需要修改的引用。可能文件已经被修复，或引用写法不在当前规则范围内。'
      )
    }
    const applied = await this.apply({
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })
    let remainingIssueCount = 0
    try {
      const next = await this.scanDependencies(project.id)
      remainingIssueCount = next.summary.issueCount
    } catch {
      remainingIssueCount = 0
    }
    return {
      fixedIssuePath: validation.oldPath,
      newPath: validation.newPath,
      changedFiles: applied.filesChanged,
      replacements: applied.replacements,
      backupId: applied.backupId,
      backupDir: applied.backupDir,
      remainingIssueCount
    }
  }

  async rebuildDependencyCache(
    projectId: number,
    paths: string[]
  ): Promise<DependencyCacheRebuildResult> {
    const project = this.requireProject(projectId)
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new AppError(ERROR_CODES.validation, '请选择要重建的缓存文件。')
    }
    let snapshot = this.dependencySnapshots.get(project.id)
    if (!snapshot) snapshot = await this.scanDependencies(project.id)
    const byPath = new Map(snapshot.nodes.map((node) => [node.path, node]))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(project.rootPath, BACKUP_DIR_NAME, `dependency-cache-${stamp}`)
    const moved: string[] = []
    for (const pathValue of paths.slice(0, 200)) {
      if (typeof pathValue !== 'string') continue
      const relativePath = normalizeRelativePath(pathValue)
      const node = byPath.get(relativePath)
      if (!node || node.role !== 'cache' || !node.exists) continue
      const absolute = resolve(project.rootPath, ...relativePath.split('/'))
      assertPathInsideProject(project.rootPath, absolute)
      try {
        if (!statSync(absolute).isFile()) continue
      } catch {
        continue
      }
      const destination = join(backupDir, ...relativePath.split('/'))
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(absolute, destination)
      moved.push(relativePath)
    }
    if (moved.length === 0) {
      throw new AppError(
        ERROR_CODES.dependencyCacheFailed,
        '没有可安全移动的缓存文件。缓存文件可能已经不存在，或不属于当前工程。'
      )
    }
    return { movedFiles: moved.length, backupDir, paths: moved }
  }

  ignoreDependency(projectId: number, pathValue: string, ignored: boolean): DependencyIgnoreResult {
    const project = this.requireProject(projectId)
    const relativePath = normalizeRelativePath(this.requireText(pathValue, 'path', 32_767))
    if (!relativePath) {
      throw new AppError(ERROR_CODES.validation, '依赖路径不能为空。')
    }
    const absolute = resolve(project.rootPath, ...relativePath.split('/'))
    assertPathInsideProject(project.rootPath, absolute)
    if (ignored) this.requireStore().addDependencyIgnore(project.id, relativePath)
    else this.requireStore().removeDependencyIgnore(project.id, relativePath)
    return { ignoredPath: relativePath, ignored }
  }

  // ---------------------------------------------------------------------
  // Software scan (“扫描一个软件”)
  // ---------------------------------------------------------------------

  /** Resolve and read the (read-only) metadata of a picked program/directory. */
  async inspectSoftwareTarget(absPath: string): Promise<SoftwareInspectResult> {
    const target = this.requireText(absPath, 'absPath', 32_767)
    try {
      return await inspectSoftware(target)
    } catch (error) {
      if (isSoftwareTargetError(error)) {
        throw new AppError(error.code, error.message)
      }
      if (isAppError(error)) throw error
      throw new AppError(
        ERROR_CODES.softwareInspectFailed,
        `读取这个软件的信息失败：${errorMessage(error)}`
      )
    }
  }

  /**
   * Create (or convert) a project that represents an installed software
   * package. Only local metadata rows are written; the software directory
   * itself is never modified.
   */
  async addSoftwareProject(request: SoftwareAddRequest): Promise<Project> {
    const store = this.requireStore()
    if (!isPlainObject(request)) {
      throw new AppError(ERROR_CODES.validation, '软件信息无效。')
    }
    const rootInput = this.requireText(request.rootPath, 'rootPath', 32_767)
    let parsed: { rootPath: string; entryPath: string | null }
    try {
      parsed = await parseSoftwareTarget(rootInput)
    } catch (error) {
      if (isSoftwareTargetError(error)) throw new AppError(error.code, error.message)
      throw new AppError(
        ERROR_CODES.softwareTargetInvalid,
        `无法识别这个软件位置：${errorMessage(error)}`
      )
    }
    const normalized = this.normalizeProjectRoot(parsed.rootPath)
    const requestedEntry =
      typeof request.entryPath === 'string' ? request.entryPath.trim() : ''
    let entryPath = parsed.entryPath
    if (requestedEntry.length > 0) {
      const resolvedEntry = resolve(requestedEntry)
      if (!isPathInside(normalized.rootPath, resolvedEntry)) {
        throw new AppError(
          ERROR_CODES.softwareTargetInvalid,
          '入口程序必须位于这个软件的安装目录里。'
        )
      }
      if (extname(resolvedEntry).toLowerCase() !== '.exe' || !fileExists(resolvedEntry)) {
        throw new AppError(
          ERROR_CODES.softwareTargetInvalid,
          '入口程序必须是安装目录里真实存在的 .exe 文件。'
        )
      }
      entryPath = resolvedEntry
    }

    const requestedName = typeof request.name === 'string' ? request.name.trim() : ''
    const name = (
      requestedName.length > 0 ? requestedName : this.softwareDisplayName(entryPath, normalized.name)
    ).slice(0, MAX_PROJECT_NAME_LENGTH)
    const now = new Date().toISOString()
    const existing = store.findProjectByRootKey(normalized.rootKey)

    if (existing) {
      return store.transaction(() => {
        const updated = store.updateProjectSoftware(existing.id, 'software', entryPath)
        if (!updated) {
          throw new AppError(ERROR_CODES.projectNotFound, '项目不存在或已被移除。', {
            projectId: existing.id
          })
        }
        if (requestedName.length > 0) store.renameProject(existing.id, name)
        store.touchProject(existing.id, now)
        this.setLastProjectIdInternal(existing.id)
        return store.getProject(existing.id) ?? updated
      })
    }

    return store.transaction(() => {
      const created = store.insertProject({
        name,
        rootPath: normalized.rootPath,
        rootKey: normalized.rootKey,
        createdAt: now,
        kind: 'software',
        entryPath
      })
      store.ensureBuiltinRules(created.id, now)
      this.setLastProjectIdInternal(created.id)
      return created
    })
  }

  private softwareDisplayName(entryPath: string | null, fallback: string): string {
    if (!entryPath) return fallback
    const base = basename(entryPath, extname(entryPath)).trim()
    return base.length > 0 ? base : fallback
  }

  /**
   * Run the read-only software health report: text path references (existing
   * dependency engine) plus, optionally, PE import-table DLL analysis. The
   * target software is never started and nothing is written.
   */
  async scanSoftware(request: SoftwareScanRequest): Promise<SoftwareScanResult> {
    const store = this.requireStore()
    if (!isPlainObject(request)) {
      throw new AppError(ERROR_CODES.validation, '软件体检参数无效。')
    }
    const project = this.requireProject(request.projectId)
    if (project.kind !== 'software') {
      throw new AppError(
        ERROR_CODES.softwareTargetInvalid,
        '当前项目不是软件项目。请先用“扫描一个软件”选择程序或安装目录。'
      )
    }
    const settings = this.getSettings()
    const rules = store.listMatchRules(project.id).filter((rule) => rule.enabled)
    const ignoreRules = store.listIgnoreRules(project.id).filter((rule) => rule.enabled)

    // Inspection is a convenience: if the entry program was moved/uninstalled
    // the text + root-level DLL report is still useful, so never fail here.
    let inspected: SoftwareInspectResult | null = null
    try {
      inspected = await this.inspectSoftwareTarget(project.entryPath ?? project.rootPath)
    } catch {
      inspected = null
    }

    this.activeSoftwareScan?.abort()
    const controller = new AbortController()
    this.activeSoftwareScan = controller
    const textScan =
      request.textScan === 'all' || request.textScan === 'off' ? request.textScan : 'config'
    try {
      return await scanSoftwarePackage({
        projectId: project.id,
        projectName: project.name,
        installRoot: project.rootPath,
        entryPath: project.entryPath,
        includeBinary: request.includeBinary !== false,
        textScan,
        rules,
        ignoreRules,
        caseSensitive: settings.caseSensitive,
        maxFileSizeKb: settings.maxFileSizeKb,
        ignoredPaths: store.listDependencyIgnores(project.id),
        info: inspected?.info ?? null,
        signal: controller.signal
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError(ERROR_CODES.scanCancelled, '软件体检已取消。')
      }
      if (isAppError(error)) throw error
      throw new AppError(
        ERROR_CODES.softwareScanFailed,
        `软件体检失败：${errorMessage(error)}`
      )
    } finally {
      if (this.activeSoftwareScan === controller) this.activeSoftwareScan = null
    }
  }

  // ---------------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------------

  async scan(
    request: ScanRequest,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const store = this.requireStore()
    if (!isPlainObject(request)) {
      throw new AppError(ERROR_CODES.validation, '扫描参数无效。')
    }
    const project = this.requireProject(request.projectId)
    const oldPath = this.requireText(request.oldPath, 'oldPath', 32_767)
    const newPath = this.requireText(request.newPath, 'newPath', 32_767)
    const kind = this.validateKindInput(request.kind)
    const settings = this.getSettings()
    const modes =
      request.modes === undefined ? settings.matchModes : this.validateMatchModes(request.modes)

    const rules = store.listMatchRules(project.id).filter((rule) => rule.enabled)
    if (rules.length === 0) {
      throw new AppError(ERROR_CODES.scanFailed, '没有启用的匹配规则，无法扫描。', {
        projectId: project.id
      })
    }
    const ignoreRules = store.listIgnoreRules(project.id).filter((rule) => rule.enabled)
    const pathInfo = this.resolvePaths(project, oldPath, newPath, kind)

    const emit = (progress: ScanProgress): void => {
      if (!onProgress) return
      try {
        onProgress(progress)
      } catch {
        // A broken progress listener must never abort a scan.
      }
    }

    this.activeScan?.abort()
    const controller = new AbortController()
    this.activeScan = controller

    emit({ phase: 'preparing', filesScanned: 0, filesTotal: 0, currentFile: null, percent: 0 })
    const startedAt = Date.now()

    try {
      const engineResult = await scanProject({
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        oldPath,
        newPath,
        kind,
        modes,
        rules,
        ignoreRules,
        caseSensitive: settings.caseSensitive,
        maxFileSizeKb: settings.maxFileSizeKb,
        signal: controller.signal,
        onProgress: (progress) => emit(progress)
      })

      emit({
        phase: 'finalizing',
        filesScanned: Number(engineResult.scannedFiles ?? 0),
        filesTotal: Number(engineResult.candidateFiles ?? 0),
        currentFile: null,
        percent: 100
      })

      const token = randomUUID()
      const createdAt = new Date().toISOString()
      const result: ScanResult = {
        scanToken: token,
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        oldPathInput: oldPath,
        newPathInput: newPath,
        pathInfo,
        modes,
        items: Array.isArray(engineResult.items) ? engineResult.items : [],
        scannedFiles: Number(engineResult.scannedFiles ?? 0),
        candidateFiles: Number(engineResult.candidateFiles ?? 0),
        skippedFiles: Number(engineResult.skippedFiles ?? 0),
        ignoredFiles: Number(engineResult.ignoredFiles ?? 0),
        durationMs: Number(engineResult.durationMs ?? Date.now() - startedAt),
        warnings: Array.isArray(engineResult.warnings) ? engineResult.warnings : [],
        budgetStopped: (engineResult as { budgetStopped?: unknown }).budgetStopped === true,
        createdAt
      }

      const snapshots = new Map<string, CachedSnapshot>()
      const engineSnapshots = Array.isArray(engineResult.snapshots) ? engineResult.snapshots : []
      for (const snapshot of engineSnapshots) {
        if (!snapshot || typeof snapshot.filePath !== 'string') continue
        // Core reports absolute native paths here; the cache is keyed by the
        // project-relative posix path used by ScanOccurrence.filePath.
        const relPath = this.toProjectRelativePath(project.rootPath, snapshot.filePath)
        if (!relPath) continue
        snapshots.set(relPath, {
          filePath: relPath,
          size: Number(snapshot.size ?? 0),
          mtimeMs: Number(snapshot.mtimeMs ?? 0),
          hash: String(snapshot.hash ?? '')
        })
      }

      this.pruneScanSessions()
      const now = Date.now()
      this.scanSessions.set(token, {
        token,
        result,
        snapshots,
        projectId: project.id,
        projectRoot: project.rootPath,
        createdAtMs: now,
        lastUsedAtMs: now
      })
      this.pruneScanSessions()
      return result
    } catch (error) {
      if (isAppError(error)) throw error
      if (controller.signal.aborted) {
        throw new AppError(ERROR_CODES.scanCancelled, '扫描已取消。')
      }
      const coreCode = (error as { code?: unknown } | null)?.code
      throw new AppError(ERROR_CODES.scanFailed, `扫描失败：${errorMessage(error)}`, {
        cause: errorMessage(error),
        ...(typeof coreCode === 'string' ? { coreCode } : {})
      })
    } finally {
      if (this.activeScan === controller) this.activeScan = null
    }
  }

  /** Normalize an absolute path reported by the core into project-relative posix. */
  private toProjectRelativePath(projectRoot: string, filePath: string): string {
    if (typeof filePath !== 'string' || filePath.length === 0) return ''
    const posix = toPosixPath(filePath)
    const looksAbsolute =
      isAbsolute(filePath) || /^[A-Za-z]:/.test(posix) || posix.startsWith('/')
    if (looksAbsolute) {
      try {
        const rel = relative(resolve(projectRoot), resolve(filePath))
        return normalizeRelativePath(toPosixPath(rel))
      } catch {
        return ''
      }
    }
    return normalizeRelativePath(posix)
  }

  private pruneScanSessions(): void {
    const now = Date.now()
    for (const [token, session] of this.scanSessions) {
      if (now - session.createdAtMs > SCAN_SESSION_TTL_MS) {
        this.scanSessions.delete(token)
      }
    }
    if (this.scanSessions.size <= MAX_SCAN_SESSIONS) return
    const ordered = [...this.scanSessions.entries()].sort(
      (a, b) => a[1].lastUsedAtMs - b[1].lastUsedAtMs
    )
    const overflow = this.scanSessions.size - MAX_SCAN_SESSIONS
    for (let index = 0; index < overflow; index += 1) {
      const entry = ordered[index]
      if (entry) this.scanSessions.delete(entry[0])
    }
  }

  private requireScanSession(token: unknown): ScanSession {
    if (typeof token !== 'string' || token.length === 0) {
      throw new AppError(ERROR_CODES.scanExpired, '扫描结果已失效，请重新扫描。')
    }
    this.pruneScanSessions()
    const session = this.scanSessions.get(token)
    if (!session) {
      throw new AppError(ERROR_CODES.scanExpired, '扫描结果已过期，请重新扫描。', { scanToken: token })
    }
    const project = this.requireProject(session.projectId)
    if (resolve(project.rootPath) !== resolve(session.projectRoot)) {
      this.scanSessions.delete(token)
      throw new AppError(ERROR_CODES.scanExpired, '项目路径已变化，请重新扫描。', {
        scanToken: token
      })
    }
    session.lastUsedAtMs = Date.now()
    return session
  }

  // ---------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------

  apply(request: ApplyRequest): Promise<ApplyResult> {
    return this.runExclusive(() => this.applyInternal(request))
  }

  private async applyInternal(request: ApplyRequest): Promise<ApplyResult> {
    const store = this.requireStore()
    if (!isPlainObject(request)) {
      throw new AppError(ERROR_CODES.validation, '应用参数无效。')
    }
    const occurrenceIds = Array.isArray(request.occurrenceIds)
      ? request.occurrenceIds.filter((id): id is string => typeof id === 'string')
      : []
    if (occurrenceIds.length === 0) {
      throw new AppError(ERROR_CODES.scanEmptySelection, '没有选中任何替换项。')
    }

    const session = this.requireScanSession(request.scanToken)
    const project = this.requireProject(session.projectId)
    const projectRoot = resolve(project.rootPath)
    if (!directoryExists(projectRoot)) {
      throw new AppError(ERROR_CODES.projectRootInvalid, '项目根目录不存在，无法应用。', {
        rootPath: projectRoot
      })
    }

    const selected = this.selectOccurrences(session, occurrenceIds)
    const skipped: SkippedOccurrence[] = []

    // Verify every selected file against its scan snapshot BEFORE any write.
    const candidates = this.verifyFilesFresh(session, projectRoot, selected, skipped)

    // Build the new file contents without touching the disk.
    const prepared: PreparedFile[] = []
    for (const candidate of candidates) {
      const preparedFile = this.prepareFile(candidate, skipped)
      if (preparedFile) prepared.push(preparedFile)
    }

    if (prepared.length === 0) {
      throw new AppError(
        ERROR_CODES.applyNothingToWrite,
        '选中的替换项没有产生可写入的更改。',
        { skipped }
      )
    }

    const createdAt = new Date().toISOString()
    const totalReplacements = prepared.reduce((sum, file) => sum + file.replacements, 0)
    const totalOriginalBytes = prepared.reduce(
      (sum, file) => sum + file.originalBuffer.byteLength,
      0
    )

    const migrationId = store.insertMigration({
      projectId: project.id,
      oldPath: session.result.oldPathInput,
      newPath: session.result.newPathInput,
      kind: session.result.pathInfo.kind,
      modes: session.result.modes,
      status: 'pending',
      createdAt
    })

    // 1) Copy every affected original into a timestamped backup folder.
    const backupDirName = createBackupFolderName(new Date())
    const backupDirAbs = join(projectRoot, BACKUP_DIR_NAME, backupDirName)
    const backupFilesAbs = join(backupDirAbs, BACKUP_FILES_DIR)
    const backupDirRel = `${BACKUP_DIR_NAME}/${backupDirName}`
    try {
      mkdirSync(backupFilesAbs, { recursive: true })
      for (const file of prepared) {
        const target = join(backupFilesAbs, ...splitRelativePath(file.relPath))
        assertPathInsideProject(projectRoot, target)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.originalBuffer)
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_FORMAT_VERSION,
        createdAt,
        projectId: project.id,
        projectName: project.name,
        migrationId,
        oldPath: session.result.oldPathInput,
        newPath: session.result.newPathInput,
        kind: session.result.pathInfo.kind,
        modes: session.result.modes,
        files: prepared.map((file) => ({
          path: file.relPath,
          backupPath: `${BACKUP_FILES_DIR}/${file.relPath}`,
          size: file.originalBuffer.byteLength,
          hash: file.preHash,
          replacements: file.replacements
        }))
      }
      writeFileSync(
        join(backupDirAbs, BACKUP_MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
        'utf8'
      )
    } catch (error) {
      try {
        removeDirectoryRecursive(backupDirAbs)
      } catch {
        // Best effort cleanup of a partial backup folder.
      }
      store.updateMigration(migrationId, {
        status: 'failed',
        error: `备份创建失败：${errorMessage(error)}`
      })
      throw new AppError(
        ERROR_CODES.applyFailed,
        `无法创建备份，本次应用已取消：${errorMessage(error)}`,
        { migrationId }
      )
    }

    // 2) Record the backup and the per-file pre/post hashes.
    let backupId: number
    try {
      backupId = store.transaction(() => {
        const id = store.insertBackup({
          projectId: project.id,
          migrationId,
          dirName: backupDirName,
          absPath: backupDirAbs,
          filesCount: prepared.length,
          sizeBytes: totalOriginalBytes,
          createdAt
        })
        store.updateMigration(migrationId, { backupId: id, backupDir: backupDirRel })
        for (const file of prepared) {
          store.insertMigrationFile({
            migrationId,
            filePath: file.relPath,
            backupPath: `${backupDirRel}/${BACKUP_FILES_DIR}/${file.relPath}`,
            preHash: file.preHash,
            postHash: file.postHash,
            replacements: file.replacements
          })
        }
        return id
      })
    } catch (error) {
      store.updateMigration(migrationId, {
        status: 'failed',
        error: `备份记录写入失败：${errorMessage(error)}`
      })
      throw new AppError(
        ERROR_CODES.applyFailed,
        `无法记录备份信息，本次应用已取消：${errorMessage(error)}`,
        { migrationId, backupDir: backupDirAbs }
      )
    }

    // 3) Write the modified files atomically. On any failure restore what was
    // already written and mark the migration failed.
    const written: PreparedFile[] = []
    try {
      for (const file of prepared) {
        assertPathInsideProject(projectRoot, file.absPath)
        writeFileAtomicSync(file.absPath, file.newBuffer)
        written.push(file)
      }
    } catch (error) {
      const restoreErrors: Array<{ filePath: string; message: string }> = []
      for (const file of [...written].reverse()) {
        try {
          writeFileAtomicSync(file.absPath, file.originalBuffer)
        } catch (restoreError) {
          restoreErrors.push({ filePath: file.relPath, message: errorMessage(restoreError) })
        }
      }
      store.updateMigration(migrationId, {
        status: 'failed',
        filesChanged: 0,
        replacements: 0,
        error: `写入失败：${errorMessage(error)}`
      })
      throw new AppError(
        ERROR_CODES.applyFailed,
        `写入文件失败，已尝试恢复原文件：${errorMessage(error)}`,
        { migrationId, backupId, backupDir: backupDirAbs, restoreErrors }
      )
    }

    // 4) Success: flip the status and expose the real result.
    store.transaction(() => {
      store.updateMigration(migrationId, {
        status: 'applied',
        filesChanged: prepared.length,
        replacements: totalReplacements,
        appliedAt: new Date().toISOString()
      })
      store.updateBackup(backupId, {
        filesCount: prepared.length,
        sizeBytes: totalOriginalBytes
      })
    })

    // The cached scan is stale once files changed; force a rescan.
    this.scanSessions.delete(session.token)

    return {
      migrationId,
      backupId,
      filesChanged: prepared.length,
      replacements: totalReplacements,
      backupDir: backupDirAbs,
      skipped
    }
  }

  private selectOccurrences(session: ScanSession, occurrenceIds: string[]): ScanOccurrence[] {
    const byId = new Map<string, ScanOccurrence>()
    for (const item of session.result.items) {
      byId.set(item.id, item)
    }
    const selected: ScanOccurrence[] = []
    const unknown: string[] = []
    const uniqueIds = new Set<string>()
    for (const id of occurrenceIds) {
      if (uniqueIds.has(id)) continue
      uniqueIds.add(id)
      const item = byId.get(id)
      if (!item) {
        unknown.push(id)
        continue
      }
      selected.push(item)
    }
    if (unknown.length > 0) {
      throw new AppError(
        ERROR_CODES.scanSelectionInvalid,
        '部分选中的结果已不存在，请重新扫描后再应用。',
        { unknownIds: unknown }
      )
    }
    return selected
  }

  private verifyFilesFresh(
    session: ScanSession,
    projectRoot: string,
    selected: ScanOccurrence[],
    skipped: SkippedOccurrence[]
  ): Array<{
    relPath: string
    absPath: string
    originalBuffer: Buffer
    preHash: string
    occurrences: ScanOccurrence[]
  }> {
    const grouped = new Map<string, ScanOccurrence[]>()
    for (const occurrence of selected) {
      const key = snapshotKey(occurrence.filePath)
      if (!key) {
        throw new AppError(ERROR_CODES.scanSelectionInvalid, '扫描结果中的文件路径无效。', {
          filePath: occurrence.filePath
        })
      }
      const list = grouped.get(key)
      if (list) {
        list.push(occurrence)
      } else {
        grouped.set(key, [occurrence])
      }
    }

    const stale: Array<{
      filePath: string
      reason: string
      expectedHash?: string
      actualHash?: string
    }> = []
    const candidates: Array<{
      relPath: string
      absPath: string
      originalBuffer: Buffer
      preHash: string
      occurrences: ScanOccurrence[]
    }> = []

    for (const [relPath, occurrences] of grouped) {
      const snapshot = session.snapshots.get(relPath)
      if (!snapshot) {
        // Very large text files (>16 MB) are reported but intentionally not
        // snapshotted, so they can never be rewritten from this scan. Skip just
        // those occurrences instead of failing the whole apply.
        for (const occurrence of occurrences) {
          skipped.push({
            id: occurrence.id,
            filePath: occurrence.filePath,
            reason: '文件较大，本次只做只读报告，没有自动修复；如需修改请手动处理或换用更小的文件'
          })
        }
        continue
      }
      const { absPath } = resolveProjectPath(projectRoot, relPath)
      if (!fileExists(absPath)) {
        stale.push({ filePath: relPath, reason: 'missing-file', expectedHash: snapshot.hash })
        continue
      }
      let buffer: Buffer
      try {
        buffer = readFileSync(absPath)
      } catch {
        stale.push({ filePath: relPath, reason: 'unreadable', expectedHash: snapshot.hash })
        continue
      }
      const actualHash = sha256Hex(buffer)
      if (actualHash !== snapshot.hash) {
        stale.push({
          filePath: relPath,
          reason: 'changed',
          expectedHash: snapshot.hash,
          actualHash
        })
        continue
      }
      candidates.push({
        relPath,
        absPath,
        originalBuffer: buffer,
        preHash: actualHash,
        occurrences
      })
    }

    if (stale.length > 0) {
      throw new AppError(
        ERROR_CODES.scanStale,
        '扫描后文件内容已发生变化，本次应用已取消，未写入任何文件。请重新扫描。',
        { files: stale }
      )
    }
    return candidates
  }

  private prepareFile(
    candidate: {
      relPath: string
      absPath: string
      originalBuffer: Buffer
      preHash: string
      occurrences: ScanOccurrence[]
    },
    skipped: SkippedOccurrence[]
  ): PreparedFile | null {
    const decoded = decodeTextBuffer(candidate.originalBuffer)
    if (!decoded) {
      for (const occurrence of candidate.occurrences) {
        skipped.push({
          id: occurrence.id,
          filePath: candidate.relPath,
          reason: '文件不是可识别的文本编码'
        })
      }
      return null
    }

    const ordered = [...candidate.occurrences].sort(
      (a, b) => a.offset - b.offset || a.length - b.length
    )
    const usable: ScanOccurrence[] = []
    let lastEnd = -1
    for (const occurrence of ordered) {
      if (
        !Number.isInteger(occurrence.offset) ||
        occurrence.offset < 0 ||
        !Number.isInteger(occurrence.length) ||
        occurrence.length <= 0 ||
        occurrence.offset + occurrence.length > decoded.text.length
      ) {
        skipped.push({ id: occurrence.id, filePath: candidate.relPath, reason: '替换位置无效' })
        continue
      }
      if (occurrence.offset < lastEnd) {
        skipped.push({ id: occurrence.id, filePath: candidate.relPath, reason: '与其他替换项重叠' })
        continue
      }
      if (
        decoded.text.slice(occurrence.offset, occurrence.offset + occurrence.length) !==
        occurrence.oldText
      ) {
        skipped.push({
          id: occurrence.id,
          filePath: candidate.relPath,
          reason: '文件内容与扫描结果不一致'
        })
        continue
      }
      usable.push(occurrence)
      lastEnd = occurrence.offset + occurrence.length
    }

    if (usable.length === 0) return null

    let applied: { text: string; applied: number }
    try {
      applied = applyTextEdits(
        decoded.text,
        usable.map((occurrence) => ({
          offset: occurrence.offset,
          length: occurrence.length,
          oldText: occurrence.oldText,
          newText: occurrence.newText
        }))
      )
    } catch (error) {
      throw new AppError(
        ERROR_CODES.applyFailed,
        `应用替换失败，未写入任何文件：${errorMessage(error)}`,
        { filePath: candidate.relPath }
      )
    }
    if (applied.applied !== usable.length) {
      throw new AppError(
        ERROR_CODES.applyFailed,
        '替换项未能全部应用，本次应用已取消，未写入任何文件。',
        { filePath: candidate.relPath, expected: usable.length, applied: applied.applied }
      )
    }
    if (applied.text === decoded.text) {
      for (const occurrence of usable) {
        skipped.push({
          id: occurrence.id,
          filePath: candidate.relPath,
          reason: '替换后文本没有变化'
        })
      }
      return null
    }

    let newBuffer: Buffer
    try {
      newBuffer = reconcileBom(candidate.originalBuffer, encodeTextBuffer(applied.text, decoded.encoding))
    } catch (error) {
      throw new AppError(
        ERROR_CODES.applyFailed,
        `按原编码重新编码文件失败，未写入任何文件：${errorMessage(error)}`,
        { filePath: candidate.relPath, encoding: decoded.encoding }
      )
    }

    return {
      relPath: candidate.relPath,
      absPath: candidate.absPath,
      originalBuffer: candidate.originalBuffer,
      newBuffer,
      preHash: candidate.preHash,
      postHash: sha256Hex(newBuffer),
      replacements: usable.length
    }
  }

  // ---------------------------------------------------------------------
  // Rollback
  // ---------------------------------------------------------------------

  rollback(migrationId: number): Promise<RollbackResult> {
    return this.runExclusive(() => this.rollbackInternal(migrationId))
  }

  private rollbackInternal(migrationId: number): RollbackResult {
    const store = this.requireStore()
    const id = this.requireId(migrationId, 'migrationId')
    const migration = store.getMigration(id)
    if (!migration) {
      throw new AppError(ERROR_CODES.migrationNotFound, '迁移记录不存在。', { migrationId: id })
    }
    if (migration.status !== 'applied') {
      throw new AppError(
        ERROR_CODES.rollbackNotAllowed,
        migration.status === 'rolled_back'
          ? '该迁移已经回滚过了。'
          : '只有已应用的迁移才能回滚。',
        { migrationId: id, status: migration.status }
      )
    }
    const project = this.requireProject(migration.projectId)
    const projectRoot = resolve(project.rootPath)
    if (!migration.backupId) {
      throw new AppError(ERROR_CODES.backupMissing, '该迁移没有可用的备份，无法回滚。', {
        migrationId: id
      })
    }
    const backup = store.getBackup(migration.backupId)
    if (!backup || backup.removed) {
      throw new AppError(ERROR_CODES.backupMissing, '该迁移的备份已被删除，无法回滚。', {
        migrationId: id,
        backupId: migration.backupId
      })
    }
    const expectedBackupAbs = join(projectRoot, BACKUP_DIR_NAME, backup.dirName)
    if (resolve(backup.absPath) !== resolve(expectedBackupAbs) || !directoryExists(backup.absPath)) {
      throw new AppError(ERROR_CODES.backupMissing, '备份目录不存在，无法回滚。', {
        migrationId: id,
        backupId: backup.id,
        backupDir: backup.absPath
      })
    }
    assertPathInsideProject(projectRoot, backup.absPath)

    const files = store.listMigrationFiles(id)
    if (files.length === 0) {
      throw new AppError(ERROR_CODES.rollbackFailed, '迁移记录中没有文件信息，无法回滚。', {
        migrationId: id
      })
    }

    // Verify first: never restore a subset when one file conflicts.
    const conflicts: Array<{
      filePath: string
      reason: string
      expectedHash?: string
      actualHash?: string
    }> = []
    const toRestore: Array<{ row: MigrationFileRow; absPath: string; backupAbs: string }> = []
    for (const row of files) {
      const { absPath } = resolveProjectPath(projectRoot, row.filePath)
      const backupPath = resolveProjectPath(projectRoot, row.backupPath)
      if (!fileExists(absPath)) {
        conflicts.push({ filePath: row.filePath, reason: '文件已不存在' })
        continue
      }
      if (!fileExists(backupPath.absPath)) {
        conflicts.push({ filePath: row.filePath, reason: '备份文件缺失' })
        continue
      }
      const actualHash = hashFileSync(absPath)
      if (actualHash === row.postHash) {
        toRestore.push({ row, absPath, backupAbs: backupPath.absPath })
        continue
      }
      if (actualHash === row.preHash) {
        // Already restored (e.g. a retry after a partial rollback).
        continue
      }
      conflicts.push({
        filePath: row.filePath,
        reason: '文件在迁移后又被修改',
        expectedHash: row.postHash,
        actualHash
      })
    }
    if (conflicts.length > 0) {
      throw new AppError(
        ERROR_CODES.rollbackConflict,
        '文件在迁移后已被修改，无法安全回滚。请先恢复这些文件或保持现状。',
        { migrationId: id, files: conflicts }
      )
    }

    const restored: string[] = []
    for (const item of toRestore) {
      const backupBytes = readFileSync(item.backupAbs)
      if (sha256Hex(backupBytes) !== item.row.preHash) {
        throw new AppError(ERROR_CODES.rollbackFailed, `备份文件已损坏：${item.row.filePath}`, {
          migrationId: id,
          filePath: item.row.filePath
        })
      }
      assertPathInsideProject(projectRoot, item.absPath)
      writeFileAtomicSync(item.absPath, backupBytes)
      const afterHash = hashFileSync(item.absPath)
      if (afterHash !== item.row.preHash) {
        throw new AppError(ERROR_CODES.rollbackFailed, `恢复后校验失败：${item.row.filePath}`, {
          migrationId: id,
          filePath: item.row.filePath,
          expectedHash: item.row.preHash,
          actualHash: afterHash
        })
      }
      restored.push(item.row.filePath)
    }

    store.updateMigration(id, {
      status: 'rolled_back',
      rolledBackAt: new Date().toISOString()
    })
    this.scanSessions.clear()

    return {
      migrationId: id,
      filesRestored: restored.length,
      backupDir: backup.absPath
    }
  }

  // ---------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------

  listHistory(projectId: number): MigrationRecord[] {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    return store.listMigrations(project.id).map((row) => {
      const backup = row.backupId === null ? null : store.getBackup(row.backupId)
      const backupMissing =
        row.backupId === null
          ? row.status === 'applied' || row.status === 'rolled_back'
          : row.backupRemoved || !backup || backup.removed || !directoryExists(backup.absPath)
      const files = store.listMigrationFiles(row.id).map((file) => ({
        id: file.id,
        migrationId: file.migrationId,
        filePath: file.filePath,
        backupPath: file.backupPath,
        preHash: file.preHash,
        postHash: file.postHash,
        replacements: file.replacements
      }))
      return {
        id: row.id,
        projectId: row.projectId,
        oldPath: row.oldPath,
        newPath: row.newPath,
        kind: row.kind,
        modes: row.modes,
        filesChanged: row.filesChanged,
        replacements: row.replacements,
        status: row.status,
        backupId: row.backupId,
        backupDir: row.backupDir,
        backupRemoved: row.backupRemoved,
        backupMissing,
        error: row.error,
        createdAt: row.createdAt,
        rolledBackAt: row.rolledBackAt,
        files
      }
    })
  }

  /**
   * Delete one migration from history. The backup folder (if any) is kept on
   * disk and turns into an orphan backup that can still be revealed/removed.
   */
  removeHistory(migrationId: number): void {
    const store = this.requireStore()
    const id = this.requireId(migrationId, 'migrationId')
    const migration = store.getMigration(id)
    if (!migration) {
      throw new AppError(ERROR_CODES.migrationNotFound, '迁移记录不存在。', { migrationId: id })
    }
    store.deleteMigration(id)
  }

  // ---------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------

  listBackups(projectId: number): BackupRecord[] {
    const store = this.requireStore()
    const project = this.requireProject(projectId)
    return store.listBackups(project.id).map((row) => this.mapBackupRecord(row))
  }

  getBackupRecord(backupId: number): BackupRecord {
    const store = this.requireStore()
    const id = this.requireId(backupId, 'backupId')
    const row = store.getBackup(id)
    if (!row) {
      throw new AppError(ERROR_CODES.backupNotFound, '备份记录不存在。', { backupId: id })
    }
    return this.mapBackupRecord(row)
  }

  private mapBackupRecord(row: BackupRow): BackupRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      migrationId: row.migrationId,
      dirName: row.dirName,
      absPath: row.absPath,
      filesCount: row.filesCount,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      missing: !directoryExists(row.absPath),
      orphaned: row.migrationId === null
    }
  }

  /**
   * Delete a backup folder from disk and mark the record removed. History is
   * untouched (it will report `backupMissing` afterwards).
   */
  removeBackup(backupId: number): void {
    const store = this.requireStore()
    const id = this.requireId(backupId, 'backupId')
    const row = store.getBackup(id)
    if (!row) {
      throw new AppError(ERROR_CODES.backupNotFound, '备份记录不存在。', { backupId: id })
    }
    const project = this.requireProject(row.projectId)
    const projectRoot = resolve(project.rootPath)
    const expectedAbs = join(projectRoot, BACKUP_DIR_NAME, row.dirName)
    if (resolve(row.absPath) !== resolve(expectedAbs)) {
      throw new AppError(ERROR_CODES.pathOutsideProject, '备份路径不在预期位置，已拒绝删除。', {
        backupId: id,
        backupDir: row.absPath
      })
    }
    assertPathInsideProject(projectRoot, row.absPath)
    removeDirectoryRecursive(row.absPath)
    store.transaction(() => {
      store.updateBackup(id, { removed: true })
      store.markBackupRemovedForMigration(id)
    })
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  private runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private requireProject(projectId: unknown): Project {
    const id = this.requireId(projectId, 'projectId')
    const project = this.requireStore().getProject(id)
    if (!project) {
      throw new AppError(ERROR_CODES.projectNotFound, '项目不存在或已被移除。', {
        projectId: id
      })
    }
    return project
  }

  private requireId(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new AppError(ERROR_CODES.validation, `${field} 必须是正整数。`, { field })
    }
    return value
  }

  private requireText(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new AppError(ERROR_CODES.validation, `${field} 必须是字符串。`, { field })
    }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      throw new AppError(ERROR_CODES.validation, `${field} 不能为空。`, { field })
    }
    if (trimmed.length > maxLength) {
      throw new AppError(ERROR_CODES.validation, `${field} 过长。`, { field, maxLength })
    }
    return trimmed
  }

  private normalizeProjectRoot(rootInput: string): {
    rootPath: string
    rootKey: string
    name: string
  } {
    let rootPath: string
    try {
      rootPath = resolve(rootInput)
    } catch (error) {
      throw new AppError(ERROR_CODES.projectRootInvalid, '项目路径无效。', {
        rootPath: rootInput,
        cause: errorMessage(error)
      })
    }
    try {
      const stats = statSync(rootPath)
      if (!stats.isDirectory()) {
        throw new AppError(ERROR_CODES.projectRootInvalid, '项目路径必须是文件夹。', {
          rootPath
        })
      }
    } catch (error) {
      if (isAppError(error)) throw error
      throw new AppError(ERROR_CODES.projectRootInvalid, '项目文件夹不存在或无法访问。', {
        rootPath,
        cause: errorMessage(error)
      })
    }
    let realRoot = rootPath
    try {
      realRoot = resolve(realpathSync.native(rootPath))
    } catch {
      realRoot = rootPath
    }
    const projectName = basename(realRoot) || basename(rootPath) || realRoot
    const rootKey = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot
    return { rootPath: realRoot, rootKey, name: projectName.slice(0, MAX_PROJECT_NAME_LENGTH) }
  }
}
