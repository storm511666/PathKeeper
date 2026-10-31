import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppError, ERROR_CODES } from '../errors'
import { applyMigrations } from './schema'

/** Values accepted by node:sqlite prepared statements. */
export type SqlParam = null | number | bigint | string | Uint8Array

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

/**
 * Thin, typed wrapper around `node:sqlite`'s DatabaseSync.
 *
 * One synchronous connection is shared by the whole main process. WAL mode
 * keeps reads cheap and foreign keys are enforced for every connection. The
 * database lives at `<userDataPath>/pathkeeper.sqlite`.
 */
export class PathKeeperDatabase {
  readonly filePath: string
  private database: DatabaseSync | null
  private transactionDepth = 0

  constructor(userDataPath: string) {
    if (typeof userDataPath !== 'string' || userDataPath.trim().length === 0) {
      throw new AppError(ERROR_CODES.validation, '用户数据目录无效。')
    }
    mkdirSync(userDataPath, { recursive: true })
    this.filePath = join(resolve(userDataPath), 'pathkeeper.sqlite')
    this.database = new DatabaseSync(this.filePath)
    try {
      // WAL + NORMAL is the safe/fast default for a single-process local app.
      this.database.exec('PRAGMA journal_mode = WAL')
      this.database.exec('PRAGMA foreign_keys = ON')
      this.database.exec('PRAGMA busy_timeout = 5000')
      this.database.exec('PRAGMA synchronous = NORMAL')
      applyMigrations(this.database)
    } catch (error) {
      try {
        this.database.close()
      } catch {
        // ignore cleanup failure
      }
      this.database = null
      throw error
    }
  }

  get isOpen(): boolean {
    return this.database !== null
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) {
      throw new AppError(ERROR_CODES.dbNotOpen, '数据库已关闭。')
    }
    return this.database
  }

  exec(sql: string): void {
    this.requireDatabase().exec(sql)
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    const statement = this.requireDatabase().prepare(sql)
    return statement.get(...params) as unknown as T | undefined
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    const statement = this.requireDatabase().prepare(sql)
    return statement.all(...params) as unknown as T[]
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const result = this.requireDatabase().prepare(sql).run(...params)
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid)
    }
  }

  /**
   * Run `fn` inside an immediate transaction. Nested calls join the outer
   * transaction so repository helpers can be composed safely.
   */
  transaction<T>(fn: () => T): T {
    const db = this.requireDatabase()
    if (this.transactionDepth > 0) {
      return fn()
    }
    db.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Ignore rollback failures; surface the original error.
      }
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  close(): void {
    if (!this.database) return
    const db = this.database
    this.database = null
    try {
      if (this.transactionDepth > 0) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // ignore
        }
        this.transactionDepth = 0
      }
      db.close()
    } catch {
      // Closing twice or closing a failed connection must never throw during
      // app shutdown.
    }
  }
}
