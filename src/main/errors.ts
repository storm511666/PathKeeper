import type { SerializedError } from '../shared/types'

/**
 * Structured application error. Every IPC handler serializes these into the
 * `IpcResponse` error envelope so the renderer can branch on stable codes.
 *
 * Codes are plain strings (not a union) on purpose: the backend may add codes
 * without touching the shared contracts.
 */
export class AppError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (details !== undefined) {
      this.details = details
    }
  }
}

export const ERROR_CODES = {
  validation: 'VALIDATION',
  notFound: 'NOT_FOUND',
  internal: 'INTERNAL',

  projectNotFound: 'PROJECT_NOT_FOUND',
  projectRootInvalid: 'PROJECT_ROOT_INVALID',
  projectNameInvalid: 'PROJECT_NAME_INVALID',

  settingsInvalid: 'SETTINGS_INVALID',
  ruleNotFound: 'RULE_NOT_FOUND',
  ruleInvalid: 'RULE_INVALID',
  ruleBuiltinProtected: 'RULE_BUILTIN_PROTECTED',
  ignoreNotFound: 'IGNORE_NOT_FOUND',
  ignoreInvalid: 'IGNORE_INVALID',
  ignoreBuiltinProtected: 'IGNORE_BUILTIN_PROTECTED',

  pathInvalid: 'PATH_INVALID',
  pathOutsideProject: 'PATH_OUTSIDE_PROJECT',
  fileNotFound: 'FILE_NOT_FOUND',

  scanFailed: 'SCAN_FAILED',
  scanExpired: 'SCAN_EXPIRED',
  scanCancelled: 'SCAN_CANCELLED',
  scanSelectionInvalid: 'SCAN_SELECTION_INVALID',
  scanEmptySelection: 'SCAN_EMPTY_SELECTION',

  softwareTargetInvalid: 'SOFTWARE_TARGET_INVALID',
  softwareSystemDirectory: 'SOFTWARE_SYSTEM_DIRECTORY',
  softwareInspectFailed: 'SOFTWARE_INSPECT_FAILED',
  softwareScanFailed: 'SOFTWARE_SCAN_FAILED',

  dependencyDisabled: 'DEPENDENCY_DISABLED',
  dependencyPreflightFailed: 'DEPENDENCY_PREFLIGHT_FAILED',
  dependencyRepairEmpty: 'DEPENDENCY_REPAIR_EMPTY',
  dependencyCacheFailed: 'DEPENDENCY_CACHE_FAILED',

  applyFailed: 'APPLY_FAILED',
  scanStale: 'SCAN_STALE',
  applyNothingToWrite: 'APPLY_NOTHING_TO_WRITE',
  applyBusy: 'APPLY_BUSY',

  rollbackNotAllowed: 'ROLLBACK_NOT_ALLOWED',
  rollbackConflict: 'ROLLBACK_CONFLICT',
  rollbackFailed: 'ROLLBACK_FAILED',

  migrationNotFound: 'MIGRATION_NOT_FOUND',
  backupNotFound: 'BACKUP_NOT_FOUND',
  backupMissing: 'BACKUP_MISSING',
  backupRemoveFailed: 'BACKUP_REMOVE_FAILED',

  dbNotOpen: 'DB_NOT_OPEN',
  dbError: 'DB_ERROR',
  dbSchemaInvalid: 'DB_SCHEMA_INVALID'
} as const

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

/** Turn any thrown value into a structured, JSON-serializable error. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof AppError) {
    const serialized: SerializedError = { code: error.code, message: error.message }
    if (error.details !== undefined) {
      serialized.details = error.details
    }
    return serialized
  }
  if (error instanceof Error) {
    return {
      code: ERROR_CODES.internal,
      message: error.message || '未知错误。'
    }
  }
  return {
    code: ERROR_CODES.internal,
    message: typeof error === 'string' ? error : '未知错误。'
  }
}

/** Normalize a thrown value into an AppError, preserving existing ones. */
export function toAppError(error: unknown, fallbackCode = ERROR_CODES.internal): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new AppError(fallbackCode, message)
}

/** Human-safe error message for diagnostics stored in the database. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}
