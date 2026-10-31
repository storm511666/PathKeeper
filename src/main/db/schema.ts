import type { DatabaseSync } from 'node:sqlite'
import { AppError, ERROR_CODES } from '../errors'

/**
 * Schema version stored in the `meta` table. Bump this whenever a new
 * migration is appended to MIGRATIONS; existing databases are upgraded in
 * order and the whole upgrade for one version runs in a transaction.
 */
export const SCHEMA_VERSION = 3

export interface SchemaMigration {
  version: number
  up: (db: DatabaseSync) => void
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, rule_key)
);
CREATE INDEX IF NOT EXISTS idx_match_rules_project ON match_rules(project_id);

CREATE TABLE IF NOT EXISTS ignore_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  pattern TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, rule_key)
);
CREATE INDEX IF NOT EXISTS idx_ignore_rules_project ON ignore_rules(project_id);

CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  old_path TEXT NOT NULL,
  new_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  modes TEXT NOT NULL,
  files_changed INTEGER NOT NULL DEFAULT 0,
  replacements INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  backup_id INTEGER REFERENCES backups(id) ON DELETE SET NULL,
  backup_dir TEXT,
  backup_removed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  rolled_back_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_migrations_project ON migrations(project_id);

CREATE TABLE IF NOT EXISTS migration_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id INTEGER NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  pre_hash TEXT NOT NULL,
  post_hash TEXT NOT NULL,
  replacements INTEGER NOT NULL DEFAULT 0,
  UNIQUE(migration_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_migration_files_migration ON migration_files(migration_id);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  migration_id INTEGER REFERENCES migrations(id) ON DELETE SET NULL,
  dir_name TEXT NOT NULL,
  abs_path TEXT NOT NULL,
  files_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_backups_project ON backups(project_id);
`

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS dependency_ignores (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_dependency_ignores_project ON dependency_ignores(project_id);
`

/**
 * v3 — “扫描一个软件” support. Projects gain an explicit kind plus the selected
 * program entry point. Existing rows keep the `project` default, so the upgrade
 * is behavior-preserving for every 2.0 database.
 */
const SCHEMA_V3 = `
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project';
ALTER TABLE projects ADD COLUMN entry_path TEXT;

CREATE TABLE IF NOT EXISTS software_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  resolved_path TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_software_dependencies_project ON software_dependencies(project_id);
`

/** Ordered list of schema migrations. Never edit an already released entry. */
export const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1)
    }
  },
  {
    version: 2,
    up: (db) => {
      db.exec(SCHEMA_V2)
    }
  },
  {
    version: 3,
    up: (db) => {
      db.exec(SCHEMA_V3)
    }
  }
]

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value?: unknown }
    | undefined
  if (!row || row.value === undefined || row.value === null) return 0
  const parsed = Number(row.value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(ERROR_CODES.dbSchemaInvalid, '数据库版本信息无效，无法安全启动。', {
      storedVersion: row.value
    })
  }
  return parsed
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(version))
}

/**
 * Create or upgrade the schema. Idempotent: running it against an up-to-date
 * database is a no-op, and every pending migration runs in its own transaction.
 */
export function applyMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`)

  let current = readSchemaVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new AppError(
      ERROR_CODES.dbSchemaInvalid,
      `数据库版本高于当前程序支持的版本（${current} > ${SCHEMA_VERSION}），请升级 PathKeeper。`
    )
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      writeSchemaVersion(db, migration.version)
      db.exec('COMMIT')
      current = migration.version
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite; ignore.
      }
      throw error
    }
  }

  if (current === 0) {
    // Fresh database where no migration ran because the table set is empty.
    writeSchemaVersion(db, SCHEMA_VERSION)
  }
}
