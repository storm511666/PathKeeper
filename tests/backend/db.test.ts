import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_IGNORE_RULES, BUILTIN_MATCH_RULES, DEFAULT_SETTINGS } from '../../src/shared/defaults'
import { PathKeeperDatabase } from '../../src/main/db/database'
import { PathKeeperStore } from '../../src/main/db/store'

interface Harness {
  dir: string
  db: PathKeeperDatabase
  store: PathKeeperStore
}

const created: Harness[] = []

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pathkeeper-db-'))
  const db = new PathKeeperDatabase(dir)
  const store = new PathKeeperStore(db)
  store.initialize()
  const harness: Harness = { dir, db, store }
  created.push(harness)
  return harness
}

afterEach(() => {
  while (created.length > 0) {
    const harness = created.pop()
    if (!harness) continue
    harness.db.close()
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

function readPragma<T>(db: PathKeeperDatabase, pragma: string): T | undefined {
  return db.get<T>(`PRAGMA ${pragma}`)
}

function createProject(store: PathKeeperStore, rootPath: string, name = 'demo') {
  const project = store.insertProject({
    name,
    rootPath,
    rootKey: rootPath.toLowerCase(),
    createdAt: '2026-01-01T00:00:00.000Z'
  })
  store.ensureBuiltinRules(project.id)
  return project
}

describe('database schema', () => {
  it('creates the sqlite file with WAL, foreign keys and a schema version', () => {
    const harness = createHarness()
    expect(existsSync(join(harness.dir, 'pathkeeper.sqlite'))).toBe(true)

    const journal = readPragma<{ journal_mode: string }>(harness.db, 'journal_mode')
    expect(String(journal?.journal_mode).toLowerCase()).toBe('wal')
    const foreignKeys = readPragma<{ foreign_keys: number }>(harness.db, 'foreign_keys')
    expect(Number(foreignKeys?.foreign_keys)).toBe(1)

    const version = harness.db.get<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'schema_version'`
    )
    expect(version?.value).toBe('3')

    const tables = harness.db
      .all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .map((row) => row.name)
    for (const table of [
      'backups',
      'dependency_ignores',
      'ignore_rules',
      'match_rules',
      'meta',
      'migration_files',
      'migrations',
      'projects',
      'settings',
      'software_dependencies'
    ]) {
      expect(tables).toContain(table)
    }
  })

  it('is idempotent: reopening the same directory keeps data and version', () => {
    const first = createHarness()
    const project = createProject(first.store, join(first.dir, 'project-a'))
    const firstSettings = first.store.getSettings()
    first.db.close()

    const secondDb = new PathKeeperDatabase(first.dir)
    const secondStore = new PathKeeperStore(secondDb)
    secondStore.initialize()
    created.push({ dir: first.dir, db: secondDb, store: secondStore })

    expect(secondStore.getProject(project.id)).toBeDefined()
    expect(secondStore.getSettings()).toEqual(firstSettings)
    expect(
      secondDb.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value
    ).toBe('3')
  })

  it('seeds default settings on first initialization only', () => {
    const harness = createHarness()
    expect(harness.store.getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('migrates the legacy 4 MB default to 1 GB exactly once', () => {
    const harness = createHarness()
    // Simulate a 2.0 database: the old default was written before 2.1 started.
    harness.db.run(`UPDATE settings SET value = '4096' WHERE key = 'maxFileSizeKb'`)
    harness.db.run(`DELETE FROM meta WHERE key = 'max_file_size_1gb_migrated'`)

    harness.store.initialize()
    expect(harness.store.getSettings().maxFileSizeKb).toBe(1_048_576)

    // A later deliberate choice (even 4096) must never be overwritten again.
    harness.store.writeSettings({ ...harness.store.getSettings(), maxFileSizeKb: 4096 })
    harness.store.initialize()
    expect(harness.store.getSettings().maxFileSizeKb).toBe(4096)
  })

  it('never touches an explicitly customized file size during migration', () => {
    const harness = createHarness()
    harness.db.run(`UPDATE settings SET value = '256' WHERE key = 'maxFileSizeKb'`)
    harness.db.run(`DELETE FROM meta WHERE key = 'max_file_size_1gb_migrated'`)

    harness.store.initialize()
    expect(harness.store.getSettings().maxFileSizeKb).toBe(256)
  })
})

describe('projects and built-in seeding', () => {
  it('seeds every built-in match and ignore rule for a new project', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-b'))

    const matchRules = harness.store.listMatchRules(project.id)
    expect(matchRules).toHaveLength(BUILTIN_MATCH_RULES.length)
    expect(matchRules.every((rule) => rule.builtin)).toBe(true)
    expect(new Set(matchRules.map((rule) => rule.ruleKey))).toEqual(
      new Set(BUILTIN_MATCH_RULES.map((rule) => rule.key))
    )

    const ignoreRules = harness.store.listIgnoreRules(project.id)
    expect(ignoreRules).toHaveLength(BUILTIN_IGNORE_RULES.length)
    expect(ignoreRules.every((rule) => rule.builtin)).toBe(true)
  })

  it('does not duplicate built-ins when seeding is repeated', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-c'))
    harness.store.ensureBuiltinRules(project.id)
    harness.store.ensureBuiltinRules(project.id)
    expect(harness.store.listMatchRules(project.id)).toHaveLength(BUILTIN_MATCH_RULES.length)
    expect(harness.store.listIgnoreRules(project.id)).toHaveLength(BUILTIN_IGNORE_RULES.length)
    // A project created after initialize() gets repaired on the next startup.
    harness.store.initialize()
    expect(harness.store.listIgnoreRules(project.id)).toHaveLength(BUILTIN_IGNORE_RULES.length)
  })

  it('persists the schema-v3 project kind and software entry path', () => {
    const harness = createHarness()
    const root = join(harness.dir, 'ExampleApp')
    const entry = join(root, 'ExampleApp.exe')
    const created = harness.store.insertProject({
      name: 'Example App',
      rootPath: root,
      rootKey: root.toLowerCase(),
      kind: 'software',
      entryPath: entry
    })
    expect(created.kind).toBe('software')
    expect(created.entryPath).toBe(entry)

    const reverted = harness.store.updateProjectSoftware(created.id, 'project', null)
    expect(reverted?.kind).toBe('project')
    expect(reverted?.entryPath).toBeNull()

    const legacy = harness.store.insertProject({
      name: 'legacy',
      rootPath: join(harness.dir, 'legacy-project'),
      rootKey: join(harness.dir, 'legacy-project').toLowerCase()
    })
    expect(legacy.kind).toBe('project')
    expect(legacy.entryPath).toBeNull()
  })

  it('rejects duplicate project roots and cascades project deletion', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-d'), 'first')
    expect(() =>
      harness.store.insertProject({
        name: 'duplicate',
        rootPath: join(harness.dir, 'project-d'),
        rootKey: join(harness.dir, 'project-d').toLowerCase()
      })
    ).toThrow()

    expect(harness.store.findProjectByRootKey(join(harness.dir, 'project-d').toLowerCase())?.id).toBe(
      project.id
    )
    harness.store.touchProject(project.id, '2026-02-02T00:00:00.000Z')
    expect(harness.store.getProject(project.id)?.lastOpenedAt).toBe('2026-02-02T00:00:00.000Z')

    harness.store.deleteProject(project.id)
    expect(harness.store.getProject(project.id)).toBeUndefined()
    expect(harness.store.listMatchRules(project.id)).toHaveLength(0)
    expect(harness.store.listIgnoreRules(project.id)).toHaveLength(0)
  })
})

describe('settings key/value store', () => {
  it('persists typed settings values', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-e'))
    harness.store.writeSettings({
      lastProjectId: project.id,
      matchModes: { strict: true, basename: false, directory: true },
      caseSensitive: true,
      maxFileSizeKb: 512,
      beginnerMode: false,
      dependencyCheckEnabled: true,
      dependencyAutoScanOnOpen: true,
      dependencyAutoWatch: false,
      dependencyAutoRepair: false
    })
    expect(harness.store.getSettings()).toEqual({
      lastProjectId: project.id,
      matchModes: { strict: true, basename: false, directory: true },
      caseSensitive: true,
      maxFileSizeKb: 512,
      beginnerMode: false,
      dependencyCheckEnabled: true,
      dependencyAutoScanOnOpen: true,
      dependencyAutoWatch: false,
      dependencyAutoRepair: false
    })
  })
})

describe('rules persistence', () => {
  it('orders match rules by priority and supports updates', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-f'))
    const createdAt = '2026-01-01T00:00:00.000Z'
    const custom = harness.store.insertMatchRule({
      projectId: project.id,
      ruleKey: 'custom-test',
      name: 'custom',
      description: '',
      category: 'custom',
      pattern: '"(?<path>x)"',
      flags: 'g',
      enabled: true,
      builtin: false,
      priority: 999,
      createdAt,
      updatedAt: createdAt
    })
    expect(harness.store.listMatchRules(project.id)[0]?.id).toBe(custom.id)

    const updated = harness.store.updateMatchRule(custom.id, {
      name: 'renamed',
      enabled: false,
      updatedAt: '2026-01-02T00:00:00.000Z'
    })
    expect(updated?.name).toBe('renamed')
    expect(updated?.enabled).toBe(false)
    expect(updated?.updatedAt).toBe('2026-01-02T00:00:00.000Z')

    expect(harness.store.deleteMatchRule(custom.id)).toBe(true)
    expect(harness.store.getMatchRule(custom.id)).toBeUndefined()
  })

  it('restores built-in match rules while keeping custom rules', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-g'))
    const builtin = harness.store.listMatchRules(project.id)[0]
    expect(builtin).toBeDefined()
    if (!builtin) return
    harness.store.updateMatchRule(builtin.id, { name: 'edited', enabled: false })
    harness.store.insertMatchRule({
      projectId: project.id,
      ruleKey: 'custom-keep',
      name: 'custom',
      description: '',
      category: 'custom',
      pattern: '"(?<path>x)"',
      flags: '',
      enabled: true,
      builtin: false,
      priority: 10
    })

    const reset = harness.store.resetBuiltinMatchRules(project.id)
    expect(reset).toHaveLength(BUILTIN_MATCH_RULES.length + 1)
    expect(reset.some((rule) => rule.ruleKey === 'custom-keep')).toBe(true)
    expect(reset.find((rule) => rule.ruleKey === builtin.ruleKey)?.enabled).toBe(true)
    expect(reset.find((rule) => rule.ruleKey === builtin.ruleKey)?.name).not.toBe('edited')
  })

  it('persists ignore rule toggles and reset', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-h'))
    const builtin = harness.store.listIgnoreRules(project.id)[0]
    expect(builtin).toBeDefined()
    if (!builtin) return
    harness.store.updateIgnoreRule(builtin.id, { enabled: false })
    expect(harness.store.getIgnoreRule(builtin.id)?.enabled).toBe(false)
    const reset = harness.store.resetBuiltinIgnoreRules(project.id)
    expect(reset).toHaveLength(BUILTIN_IGNORE_RULES.length)
    expect(reset.every((rule) => rule.enabled)).toBe(true)
  })
})

describe('migration and backup persistence', () => {
  it('stores migration files, backups and keeps backups as orphans after history deletion', () => {
    const harness = createHarness()
    const project = createProject(harness.store, join(harness.dir, 'project-i'))
    const migrationId = harness.store.insertMigration({
      projectId: project.id,
      oldPath: 'old.txt',
      newPath: 'new.txt',
      kind: 'file',
      modes: { strict: true, basename: true, directory: false },
      status: 'applied',
      createdAt: '2026-03-01T00:00:00.000Z'
    })
    const backupId = harness.store.insertBackup({
      projectId: project.id,
      migrationId,
      dirName: '2026-03-01T00-00-00-000Z-abcd',
      absPath: join(harness.dir, 'project-i', '.pathkeeper-backup', 'backup-1'),
      filesCount: 1,
      sizeBytes: 12,
      createdAt: '2026-03-01T00:00:00.000Z'
    })
    harness.store.updateMigration(migrationId, { backupId, backupDir: '.pathkeeper-backup/x' })
    harness.store.insertMigrationFile({
      migrationId,
      filePath: 'a/old.txt',
      backupPath: '.pathkeeper-backup/x/files/a/old.txt',
      preHash: 'pre',
      postHash: 'post',
      replacements: 2
    })

    const migration = harness.store.getMigration(migrationId)
    expect(migration?.backupId).toBe(backupId)
    expect(migration?.modes.strict).toBe(true)
    const files = harness.store.listMigrationFiles(migrationId)
    expect(files).toHaveLength(1)
    expect(files[0]?.replacements).toBe(2)

    // Deleting history must not delete the backup row (FK becomes NULL).
    expect(harness.store.deleteMigration(migrationId)).toBe(true)
    const orphan = harness.store.getBackup(backupId)
    expect(orphan).toBeDefined()
    expect(orphan?.migrationId).toBeNull()
    expect(harness.store.listBackups(project.id)).toHaveLength(1)
  })
})
