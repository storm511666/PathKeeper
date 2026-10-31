import type {
  AppSettings,
  IgnoreKind,
  IgnoreRule,
  MatchModes,
  MatchRule,
  MigrationStatus,
  PathKind,
  Project,
  ProjectKind,
  RuleCategory
} from '../../shared/types'
import {
  BUILTIN_IGNORE_RULES,
  BUILTIN_MATCH_RULES,
  DEFAULT_SETTINGS
} from '../../shared/defaults'
import type { PathKeeperDatabase, SqlParam } from './database'

const ISO_NOW = (): string => new Date().toISOString()

/** 1 GiB expressed in KB — the 2.1 single-file scan ceiling. */
const UPGRADED_MAX_FILE_SIZE_KB = 1_048_576

const FALLBACK_MODES: MatchModes = { ...DEFAULT_SETTINGS.matchModes }

export interface ProjectRow {
  id: number
  name: string
  root_path: string
  root_key: string
  created_at: string
  last_opened_at: string | null
  kind: string | null
  entry_path: string | null
}

interface MatchRuleRow {
  id: number
  project_id: number
  rule_key: string
  name: string
  description: string
  category: string
  pattern: string
  flags: string
  enabled: number
  builtin: number
  priority: number
  created_at: string
  updated_at: string
}

interface IgnoreRuleRow {
  id: number
  project_id: number
  rule_key: string
  pattern: string
  kind: string
  label: string
  enabled: number
  builtin: number
  sort_order: number
  created_at: string
}

export interface MigrationRow {
  id: number
  projectId: number
  oldPath: string
  newPath: string
  kind: PathKind
  modes: MatchModes
  filesChanged: number
  replacements: number
  status: MigrationStatus
  backupId: number | null
  backupDir: string | null
  backupRemoved: boolean
  error: string | null
  createdAt: string
  appliedAt: string | null
  rolledBackAt: string | null
}

interface MigrationDbRow {
  id: number
  project_id: number
  old_path: string
  new_path: string
  kind: string
  modes: string
  files_changed: number
  replacements: number
  status: string
  backup_id: number | null
  backup_dir: string | null
  backup_removed: number
  error: string | null
  created_at: string
  applied_at: string | null
  rolled_back_at: string | null
}

export interface MigrationFileRow {
  id: number
  migrationId: number
  filePath: string
  backupPath: string
  preHash: string
  postHash: string
  replacements: number
}

interface MigrationFileDbRow {
  id: number
  migration_id: number
  file_path: string
  backup_path: string
  pre_hash: string
  post_hash: string
  replacements: number
}

export interface BackupRow {
  id: number
  projectId: number
  migrationId: number | null
  dirName: string
  absPath: string
  filesCount: number
  sizeBytes: number
  createdAt: string
  removed: boolean
}

interface BackupDbRow {
  id: number
  project_id: number
  migration_id: number | null
  dir_name: string
  abs_path: string
  files_count: number
  size_bytes: number
  created_at: string
  removed: number
}

export interface CreateProjectInput {
  name: string
  rootPath: string
  rootKey: string
  createdAt?: string
  kind?: ProjectKind
  entryPath?: string | null
}

export interface CreateMatchRuleInput {
  projectId: number
  ruleKey: string
  name: string
  description: string
  category: RuleCategory
  pattern: string
  flags: string
  enabled: boolean
  builtin: boolean
  priority: number
  createdAt?: string
  updatedAt?: string
}

export interface UpdateMatchRuleInput {
  name?: string
  description?: string
  category?: RuleCategory
  pattern?: string
  flags?: string
  enabled?: boolean
  priority?: number
  updatedAt?: string
}

export interface CreateIgnoreRuleInput {
  projectId: number
  ruleKey: string
  pattern: string
  kind: IgnoreKind
  label: string
  enabled: boolean
  builtin: boolean
  sortOrder: number
  createdAt?: string
}

export interface UpdateIgnoreRuleInput {
  pattern?: string
  kind?: IgnoreKind
  label?: string
  enabled?: boolean
  sortOrder?: number
}

export interface CreateMigrationInput {
  projectId: number
  oldPath: string
  newPath: string
  kind: PathKind
  modes: MatchModes
  status: MigrationStatus
  createdAt?: string
}

export interface UpdateMigrationInput {
  status?: MigrationStatus
  backupId?: number | null
  backupDir?: string | null
  backupRemoved?: boolean
  filesChanged?: number
  replacements?: number
  error?: string | null
  appliedAt?: string | null
  rolledBackAt?: string | null
}

export interface CreateMigrationFileInput {
  migrationId: number
  filePath: string
  backupPath: string
  preHash: string
  postHash: string
  replacements: number
}

export interface CreateBackupInput {
  projectId: number
  migrationId: number | null
  dirName: string
  absPath: string
  filesCount: number
  sizeBytes: number
  createdAt?: string
}

export interface UpdateBackupInput {
  migrationId?: number | null
  filesCount?: number
  sizeBytes?: number
  removed?: boolean
}

function asBoolean(value: number | null | undefined): boolean {
  return Number(value) === 1
}

function parseModes(raw: string): MatchModes {
  try {
    const parsed = JSON.parse(raw) as Partial<MatchModes>
    return {
      strict: parsed.strict !== false,
      basename: parsed.basename !== false,
      directory: parsed.directory !== false
    }
  } catch {
    return { ...FALLBACK_MODES }
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: Number(row.id),
    name: row.name,
    rootPath: row.root_path,
    entryPath: row.entry_path ?? null,
    kind: row.kind === 'software' ? 'software' : 'project',
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at
  }
}

function mapMatchRule(row: MatchRuleRow): MatchRule {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    ruleKey: row.rule_key,
    name: row.name,
    description: row.description,
    category: row.category as RuleCategory,
    pattern: row.pattern,
    flags: row.flags,
    enabled: asBoolean(row.enabled),
    builtin: asBoolean(row.builtin),
    priority: Number(row.priority),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapIgnoreRule(row: IgnoreRuleRow): IgnoreRule {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    pattern: row.pattern,
    kind: row.kind as IgnoreKind,
    label: row.label,
    enabled: asBoolean(row.enabled),
    builtin: asBoolean(row.builtin),
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at
  }
}

function mapMigration(row: MigrationDbRow): MigrationRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    oldPath: row.old_path,
    newPath: row.new_path,
    kind: row.kind as PathKind,
    modes: parseModes(row.modes),
    filesChanged: Number(row.files_changed),
    replacements: Number(row.replacements),
    status: row.status as MigrationStatus,
    backupId: row.backup_id === null ? null : Number(row.backup_id),
    backupDir: row.backup_dir,
    backupRemoved: asBoolean(row.backup_removed),
    error: row.error,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at
  }
}

function mapMigrationFile(row: MigrationFileDbRow): MigrationFileRow {
  return {
    id: Number(row.id),
    migrationId: Number(row.migration_id),
    filePath: row.file_path,
    backupPath: row.backup_path,
    preHash: row.pre_hash,
    postHash: row.post_hash,
    replacements: Number(row.replacements)
  }
}

function mapBackup(row: BackupDbRow): BackupRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    migrationId: row.migration_id === null ? null : Number(row.migration_id),
    dirName: row.dir_name,
    absPath: row.abs_path,
    filesCount: Number(row.files_count),
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    removed: asBoolean(row.removed)
  }
}

const SETTINGS_KEYS = [
  'lastProjectId',
  'matchModes',
  'caseSensitive',
  'maxFileSizeKb',
  'beginnerMode',
  'dependencyCheckEnabled',
  'dependencyAutoScanOnOpen',
  'dependencyAutoWatch',
  'dependencyAutoRepair'
] as const
type KnownSettingKey = (typeof SETTINGS_KEYS)[number]

/**
 * All SQL lives here. The service layer owns validation and the filesystem;
 * this store owns persistence, mappings and seeding of built-in rules.
 */
export class PathKeeperStore {
  constructor(private readonly db: PathKeeperDatabase) {}

  /** Run `fn` in an immediate transaction (joins an outer transaction if any). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  // ---------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------

  /**
   * Idempotent startup work: seed default settings once, and make sure every
   * project has all currently known built-in rules (new versions may add
   * rules; deleted built-ins are not possible, so this repairs missing rows).
   */
  initialize(): void {
    const settingsCount = this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM settings')
    if (!settingsCount || Number(settingsCount.count) === 0) {
      this.db.transaction(() => {
        this.setSetting('lastProjectId', DEFAULT_SETTINGS.lastProjectId)
        this.setSetting('matchModes', { ...DEFAULT_SETTINGS.matchModes })
        this.setSetting('caseSensitive', DEFAULT_SETTINGS.caseSensitive)
        this.setSetting('maxFileSizeKb', DEFAULT_SETTINGS.maxFileSizeKb)
        this.setSetting('beginnerMode', DEFAULT_SETTINGS.beginnerMode)
        this.setSetting('dependencyCheckEnabled', DEFAULT_SETTINGS.dependencyCheckEnabled)
        this.setSetting('dependencyAutoScanOnOpen', DEFAULT_SETTINGS.dependencyAutoScanOnOpen)
        this.setSetting('dependencyAutoWatch', DEFAULT_SETTINGS.dependencyAutoWatch)
        this.setSetting('dependencyAutoRepair', DEFAULT_SETTINGS.dependencyAutoRepair)
      })
    }

    // One-shot 2.0 -> 2.1 default upgrade. Runs before any project work so the
    // very first settings read already returns the new 1 GB ceiling.
    this.applyLegacyMaxFileSizeMigration()

    const projects = this.listProjects()
    if (projects.length > 0) {
      const now = ISO_NOW()
      this.db.transaction(() => {
        for (const project of projects) {
          this.ensureBuiltinRules(project.id, now)
        }
      })
    }
  }

  // ---------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------

  listProjects(): Project[] {
    const rows = this.db.all<ProjectRow>(
      `SELECT * FROM projects
       ORDER BY COALESCE(last_opened_at, created_at) DESC, id DESC`
    )
    return rows.map(mapProject)
  }

  getProject(projectId: number): Project | undefined {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId)
    return row ? mapProject(row) : undefined
  }

  findProjectByRootKey(rootKey: string): Project | undefined {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE root_key = ?', rootKey)
    return row ? mapProject(row) : undefined
  }

  insertProject(input: CreateProjectInput): Project {
    const createdAt = input.createdAt ?? ISO_NOW()
    const kind: ProjectKind = input.kind === 'software' ? 'software' : 'project'
    const result = this.db.run(
      `INSERT INTO projects (name, root_path, root_key, created_at, last_opened_at, kind, entry_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.rootPath,
      input.rootKey,
      createdAt,
      createdAt,
      kind,
      input.entryPath ?? null
    )
    const project = this.getProject(result.lastInsertRowid)
    if (!project) {
      throw new Error('插入项目后无法读取项目记录。')
    }
    return project
  }

  /**
   * Mark an existing project as a software package (or back to a plain
   * project) and store the selected program entry point.
   */
  updateProjectSoftware(
    projectId: number,
    kind: ProjectKind,
    entryPath: string | null
  ): Project | undefined {
    const changes = this.db.run(
      'UPDATE projects SET kind = ?, entry_path = ? WHERE id = ?',
      kind === 'software' ? 'software' : 'project',
      entryPath,
      projectId
    ).changes
    return changes > 0 ? this.getProject(projectId) : undefined
  }

  renameProject(projectId: number, name: string): Project | undefined {
    const changes = this.db.run('UPDATE projects SET name = ? WHERE id = ?', name, projectId).changes
    return changes > 0 ? this.getProject(projectId) : undefined
  }

  touchProject(projectId: number, at: string = ISO_NOW()): void {
    this.db.run('UPDATE projects SET last_opened_at = ? WHERE id = ?', at, projectId)
  }

  deleteProject(projectId: number): void {
    this.db.run('DELETE FROM projects WHERE id = ?', projectId)
  }

  // ---------------------------------------------------------------------
  // Dependency ignores
  // ---------------------------------------------------------------------

  listDependencyIgnores(projectId: number): string[] {
    const rows = this.db.all<{ path: string }>(
      'SELECT path FROM dependency_ignores WHERE project_id = ? ORDER BY path',
      projectId
    )
    return rows.map((row) => row.path)
  }

  addDependencyIgnore(projectId: number, relativePath: string): void {
    this.db.run(
      `INSERT INTO dependency_ignores (project_id, path, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id, path) DO NOTHING`,
      projectId,
      relativePath,
      ISO_NOW()
    )
  }

  removeDependencyIgnore(projectId: number, relativePath: string): void {
    this.db.run(
      'DELETE FROM dependency_ignores WHERE project_id = ? AND path = ?',
      projectId,
      relativePath
    )
  }

  clearDependencyIgnores(projectId: number): void {
    this.db.run('DELETE FROM dependency_ignores WHERE project_id = ?', projectId)
  }

  // ---------------------------------------------------------------------
  // Small durable flags (meta table, e.g. one-shot settings migrations)
  // ---------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value
    )
  }

  // ---------------------------------------------------------------------
  // Settings (key/value, JSON encoded)
  // ---------------------------------------------------------------------

  private readSetting<K extends KnownSettingKey>(key: K): unknown {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as unknown
    } catch {
      return undefined
    }
  }

  private setSetting(key: KnownSettingKey, value: unknown): void {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value)
    )
  }

  getSettings(): AppSettings {
    const lastProjectId = this.readSetting('lastProjectId')
    const matchModes = this.readSetting('matchModes')
    const caseSensitive = this.readSetting('caseSensitive')
    const maxFileSizeKb = this.readSetting('maxFileSizeKb')
    const beginnerMode = this.readSetting('beginnerMode')
    const dependencyCheckEnabled = this.readSetting('dependencyCheckEnabled')
    const dependencyAutoScanOnOpen = this.readSetting('dependencyAutoScanOnOpen')
    const dependencyAutoWatch = this.readSetting('dependencyAutoWatch')
    const dependencyAutoRepair = this.readSetting('dependencyAutoRepair')

    return {
      lastProjectId:
        typeof lastProjectId === 'number' && Number.isInteger(lastProjectId) ? lastProjectId : null,
      matchModes:
        typeof matchModes === 'object' && matchModes !== null
          ? {
              strict: (matchModes as MatchModes).strict !== false,
              basename: (matchModes as MatchModes).basename !== false,
              directory: (matchModes as MatchModes).directory !== false
            }
          : { ...DEFAULT_SETTINGS.matchModes },
      caseSensitive:
        typeof caseSensitive === 'boolean' ? caseSensitive : DEFAULT_SETTINGS.caseSensitive,
      maxFileSizeKb:
        typeof maxFileSizeKb === 'number' && Number.isInteger(maxFileSizeKb) && maxFileSizeKb > 0
          ? maxFileSizeKb
          : DEFAULT_SETTINGS.maxFileSizeKb,
      beginnerMode:
        typeof beginnerMode === 'boolean' ? beginnerMode : DEFAULT_SETTINGS.beginnerMode,
      dependencyCheckEnabled:
        typeof dependencyCheckEnabled === 'boolean'
          ? dependencyCheckEnabled
          : DEFAULT_SETTINGS.dependencyCheckEnabled,
      dependencyAutoScanOnOpen:
        typeof dependencyAutoScanOnOpen === 'boolean'
          ? dependencyAutoScanOnOpen
          : DEFAULT_SETTINGS.dependencyAutoScanOnOpen,
      dependencyAutoWatch:
        typeof dependencyAutoWatch === 'boolean'
          ? dependencyAutoWatch
          : DEFAULT_SETTINGS.dependencyAutoWatch,
      dependencyAutoRepair:
        typeof dependencyAutoRepair === 'boolean'
          ? dependencyAutoRepair
          : DEFAULT_SETTINGS.dependencyAutoRepair
    }
  }

  /**
   * One-shot upgrade of the 2.0 default (4 MB) to the 2.1 default (1 GB).
   *
   * Runs once at startup. Only the exact old default is migrated, and the
   * `meta` flag records that the migration ran, so a later deliberate choice
   * (including setting it back to 4096 KB) is never overwritten again.
   */
  private applyLegacyMaxFileSizeMigration(): void {
    const LEGACY_DEFAULT_KB = 4096
    const MIGRATION_FLAG = 'max_file_size_1gb_migrated'
    if (this.getMeta(MIGRATION_FLAG) === '1') return
    this.db.transaction(() => {
      const stored = this.readSetting('maxFileSizeKb')
      if (stored === LEGACY_DEFAULT_KB) {
        this.setSetting('maxFileSizeKb', UPGRADED_MAX_FILE_SIZE_KB)
      }
      this.setMeta(MIGRATION_FLAG, '1')
    })
  }

  /** Persist a fully validated settings object. */
  writeSettings(settings: AppSettings): void {
    this.db.transaction(() => {
      this.setSetting('lastProjectId', settings.lastProjectId)
      this.setSetting('matchModes', { ...settings.matchModes })
      this.setSetting('caseSensitive', settings.caseSensitive)
      this.setSetting('maxFileSizeKb', settings.maxFileSizeKb)
      this.setSetting('beginnerMode', settings.beginnerMode)
      this.setSetting('dependencyCheckEnabled', settings.dependencyCheckEnabled)
      this.setSetting('dependencyAutoScanOnOpen', settings.dependencyAutoScanOnOpen)
      this.setSetting('dependencyAutoWatch', settings.dependencyAutoWatch)
      this.setSetting('dependencyAutoRepair', settings.dependencyAutoRepair)
    })
  }

  // ---------------------------------------------------------------------
  // Match rules
  // ---------------------------------------------------------------------

  listMatchRules(projectId: number): MatchRule[] {
    const rows = this.db.all<MatchRuleRow>(
      `SELECT * FROM match_rules WHERE project_id = ?
       ORDER BY priority DESC, id ASC`,
      projectId
    )
    return rows.map(mapMatchRule)
  }

  getMatchRule(ruleId: number): MatchRule | undefined {
    const row = this.db.get<MatchRuleRow>('SELECT * FROM match_rules WHERE id = ?', ruleId)
    return row ? mapMatchRule(row) : undefined
  }

  insertMatchRule(input: CreateMatchRuleInput): MatchRule {
    const createdAt = input.createdAt ?? ISO_NOW()
    const updatedAt = input.updatedAt ?? createdAt
    const result = this.db.run(
      `INSERT INTO match_rules
        (project_id, rule_key, name, description, category, pattern, flags, enabled, builtin, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.ruleKey,
      input.name,
      input.description,
      input.category,
      input.pattern,
      input.flags,
      input.enabled ? 1 : 0,
      input.builtin ? 1 : 0,
      input.priority,
      createdAt,
      updatedAt
    )
    const rule = this.getMatchRule(result.lastInsertRowid)
    if (!rule) {
      throw new Error('插入匹配规则后无法读取规则记录。')
    }
    return rule
  }

  updateMatchRule(ruleId: number, patch: UpdateMatchRuleInput): MatchRule | undefined {
    const columns: Record<string, SqlParam | undefined> = {
      name: patch.name,
      description: patch.description,
      category: patch.category,
      pattern: patch.pattern,
      flags: patch.flags,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
      priority: patch.priority,
      updated_at: patch.updatedAt ?? ISO_NOW()
    }
    const changed = this.updateColumns('match_rules', ruleId, columns)
    return changed > 0 ? this.getMatchRule(ruleId) : undefined
  }

  deleteMatchRule(ruleId: number): boolean {
    return this.db.run('DELETE FROM match_rules WHERE id = ?', ruleId).changes > 0
  }

  /** Built-in match rules are toggled/edited, never permanently deleted. */
  resetBuiltinMatchRules(projectId: number): MatchRule[] {
    const now = ISO_NOW()
    this.db.transaction(() => {
      this.db.run('DELETE FROM match_rules WHERE project_id = ? AND builtin = 1', projectId)
      for (const definition of BUILTIN_MATCH_RULES) {
        this.insertMatchRule({
          projectId,
          ruleKey: definition.key,
          name: definition.name,
          description: definition.description,
          category: definition.category,
          pattern: definition.pattern,
          flags: definition.flags,
          enabled: definition.enabled,
          builtin: true,
          priority: definition.priority,
          createdAt: now,
          updatedAt: now
        })
      }
    })
    return this.listMatchRules(projectId)
  }

  // ---------------------------------------------------------------------
  // Ignore rules
  // ---------------------------------------------------------------------

  listIgnoreRules(projectId: number): IgnoreRule[] {
    const rows = this.db.all<IgnoreRuleRow>(
      `SELECT * FROM ignore_rules WHERE project_id = ?
       ORDER BY sort_order ASC, id ASC`,
      projectId
    )
    return rows.map(mapIgnoreRule)
  }

  getIgnoreRule(ruleId: number): IgnoreRule | undefined {
    const row = this.db.get<IgnoreRuleRow>('SELECT * FROM ignore_rules WHERE id = ?', ruleId)
    return row ? mapIgnoreRule(row) : undefined
  }

  insertIgnoreRule(input: CreateIgnoreRuleInput): IgnoreRule {
    const createdAt = input.createdAt ?? ISO_NOW()
    const result = this.db.run(
      `INSERT INTO ignore_rules
        (project_id, rule_key, pattern, kind, label, enabled, builtin, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.ruleKey,
      input.pattern,
      input.kind,
      input.label,
      input.enabled ? 1 : 0,
      input.builtin ? 1 : 0,
      input.sortOrder,
      createdAt
    )
    const rule = this.getIgnoreRule(result.lastInsertRowid)
    if (!rule) {
      throw new Error('插入忽略规则后无法读取规则记录。')
    }
    return rule
  }

  updateIgnoreRule(ruleId: number, patch: UpdateIgnoreRuleInput): IgnoreRule | undefined {
    const columns: Record<string, SqlParam | undefined> = {
      pattern: patch.pattern,
      kind: patch.kind,
      label: patch.label,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
      sort_order: patch.sortOrder
    }
    const changed = this.updateColumns('ignore_rules', ruleId, columns)
    return changed > 0 ? this.getIgnoreRule(ruleId) : undefined
  }

  deleteIgnoreRule(ruleId: number): boolean {
    return this.db.run('DELETE FROM ignore_rules WHERE id = ?', ruleId).changes > 0
  }

  resetBuiltinIgnoreRules(projectId: number): IgnoreRule[] {
    const now = ISO_NOW()
    this.db.transaction(() => {
      this.db.run('DELETE FROM ignore_rules WHERE project_id = ? AND builtin = 1', projectId)
      for (const definition of BUILTIN_IGNORE_RULES) {
        this.insertIgnoreRule({
          projectId,
          ruleKey: definition.key,
          pattern: definition.pattern,
          kind: definition.kind,
          label: definition.label,
          enabled: definition.enabled,
          builtin: true,
          sortOrder: definition.sortOrder,
          createdAt: now
        })
      }
    })
    return this.listIgnoreRules(projectId)
  }

  /** Insert only the built-in rules a project is missing; existing rows are untouched. */
  ensureBuiltinRules(projectId: number, now: string = ISO_NOW()): void {
    const existingRules = new Set(
      this.db
        .all<{ rule_key: string }>('SELECT rule_key FROM match_rules WHERE project_id = ?', projectId)
        .map((row) => row.rule_key)
    )
    for (const definition of BUILTIN_MATCH_RULES) {
      if (existingRules.has(definition.key)) continue
      this.insertMatchRule({
        projectId,
        ruleKey: definition.key,
        name: definition.name,
        description: definition.description,
        category: definition.category,
        pattern: definition.pattern,
        flags: definition.flags,
        enabled: definition.enabled,
        builtin: true,
        priority: definition.priority,
        createdAt: now,
        updatedAt: now
      })
    }

    const existingIgnores = new Set(
      this.db
        .all<{ rule_key: string }>('SELECT rule_key FROM ignore_rules WHERE project_id = ?', projectId)
        .map((row) => row.rule_key)
    )
    for (const definition of BUILTIN_IGNORE_RULES) {
      if (existingIgnores.has(definition.key)) continue
      this.insertIgnoreRule({
        projectId,
        ruleKey: definition.key,
        pattern: definition.pattern,
        kind: definition.kind,
        label: definition.label,
        enabled: definition.enabled,
        builtin: true,
        sortOrder: definition.sortOrder,
        createdAt: now
      })
    }
  }

  // ---------------------------------------------------------------------
  // Migrations
  // ---------------------------------------------------------------------

  insertMigration(input: CreateMigrationInput): number {
    const result = this.db.run(
      `INSERT INTO migrations
        (project_id, old_path, new_path, kind, modes, files_changed, replacements, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      input.projectId,
      input.oldPath,
      input.newPath,
      input.kind,
      JSON.stringify(input.modes),
      input.status,
      input.createdAt ?? ISO_NOW()
    )
    return result.lastInsertRowid
  }

  updateMigration(migrationId: number, patch: UpdateMigrationInput): void {
    const columns: Record<string, SqlParam | undefined> = {
      status: patch.status,
      backup_id: patch.backupId,
      backup_dir: patch.backupDir,
      backup_removed:
        patch.backupRemoved === undefined ? undefined : patch.backupRemoved ? 1 : 0,
      files_changed: patch.filesChanged,
      replacements: patch.replacements,
      error: patch.error,
      applied_at: patch.appliedAt,
      rolled_back_at: patch.rolledBackAt
    }
    this.updateColumns('migrations', migrationId, columns)
  }

  getMigration(migrationId: number): MigrationRow | undefined {
    const row = this.db.get<MigrationDbRow>('SELECT * FROM migrations WHERE id = ?', migrationId)
    return row ? mapMigration(row) : undefined
  }

  listMigrations(projectId: number): MigrationRow[] {
    const rows = this.db.all<MigrationDbRow>(
      'SELECT * FROM migrations WHERE project_id = ? ORDER BY id DESC',
      projectId
    )
    return rows.map(mapMigration)
  }

  deleteMigration(migrationId: number): boolean {
    return this.db.run('DELETE FROM migrations WHERE id = ?', migrationId).changes > 0
  }

  markBackupRemovedForMigration(backupId: number): void {
    this.db.run('UPDATE migrations SET backup_removed = 1 WHERE backup_id = ?', backupId)
  }

  insertMigrationFile(input: CreateMigrationFileInput): number {
    const result = this.db.run(
      `INSERT INTO migration_files
        (migration_id, file_path, backup_path, pre_hash, post_hash, replacements)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.migrationId,
      input.filePath,
      input.backupPath,
      input.preHash,
      input.postHash,
      input.replacements
    )
    return result.lastInsertRowid
  }

  listMigrationFiles(migrationId: number): MigrationFileRow[] {
    const rows = this.db.all<MigrationFileDbRow>(
      'SELECT * FROM migration_files WHERE migration_id = ? ORDER BY id ASC',
      migrationId
    )
    return rows.map(mapMigrationFile)
  }

  // ---------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------

  insertBackup(input: CreateBackupInput): number {
    const result = this.db.run(
      `INSERT INTO backups
        (project_id, migration_id, dir_name, abs_path, files_count, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.migrationId,
      input.dirName,
      input.absPath,
      input.filesCount,
      input.sizeBytes,
      input.createdAt ?? ISO_NOW()
    )
    return result.lastInsertRowid
  }

  updateBackup(backupId: number, patch: UpdateBackupInput): void {
    const columns: Record<string, SqlParam | undefined> = {
      migration_id: patch.migrationId,
      files_count: patch.filesCount,
      size_bytes: patch.sizeBytes,
      removed: patch.removed === undefined ? undefined : patch.removed ? 1 : 0
    }
    this.updateColumns('backups', backupId, columns)
  }

  getBackup(backupId: number): BackupRow | undefined {
    const row = this.db.get<BackupDbRow>('SELECT * FROM backups WHERE id = ?', backupId)
    return row ? mapBackup(row) : undefined
  }

  listBackups(projectId: number): BackupRow[] {
    const rows = this.db.all<BackupDbRow>(
      'SELECT * FROM backups WHERE project_id = ? AND removed = 0 ORDER BY id DESC',
      projectId
    )
    return rows.map(mapBackup)
  }

  listAllBackups(projectId: number): BackupRow[] {
    const rows = this.db.all<BackupDbRow>(
      'SELECT * FROM backups WHERE project_id = ? ORDER BY id DESC',
      projectId
    )
    return rows.map(mapBackup)
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private updateColumns(
    table: 'match_rules' | 'ignore_rules' | 'migrations' | 'backups',
    id: number,
    columns: Record<string, SqlParam | undefined>
  ): number {
    const entries = Object.entries(columns).filter((entry): entry is [string, SqlParam] => {
      const value = entry[1]
      return value !== undefined
    })
    if (entries.length === 0) return 0
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
    const params: SqlParam[] = entries.map(([, value]) => value)
    params.push(id)
    return this.db.run(`UPDATE ${table} SET ${assignments} WHERE id = ?`, ...params).changes
  }
}
