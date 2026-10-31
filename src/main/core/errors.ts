/**
 * Typed, serializable errors for the PathKeeper core engine.
 *
 * The backend / IPC layer maps `CoreError.code` onto an `AppError`-style
 * `{ code, message }` envelope, so keep these codes stable.
 */

export interface CoreErrorCode {
  /** A path input was empty after trimming. */
  EMPTY_PATH: 'EMPTY_PATH'
  /** A path/option was malformed in a way the specific codes do not cover. */
  INVALID_PATH: 'INVALID_PATH'
  /** The project root is empty or could not be resolved. */
  INVALID_PROJECT_ROOT: 'INVALID_PROJECT_ROOT'
  /** The user supplied a kind that is not file/directory/auto. */
  INVALID_KIND: 'INVALID_KIND'
  /** The migration path is not inside the project root. */
  PATH_OUTSIDE_PROJECT: 'PATH_OUTSIDE_PROJECT'
  /** The migration path points at the project root itself. */
  PATH_IS_PROJECT_ROOT: 'PATH_IS_PROJECT_ROOT'
  /** Old and new paths resolve to the same location. */
  SAME_PATH: 'SAME_PATH'
  /** A match rule regular expression could not be compiled. */
  INVALID_PATTERN: 'INVALID_PATTERN'
  /** The automatic broken-reference check has no enabled rules to use. */
  NO_RULES: 'NO_RULES'
  /** The automatic broken-reference check failed unexpectedly. */
  AUTO_CHECK_FAILED: 'AUTO_CHECK_FAILED'
  /** The scan was aborted through its AbortSignal. */
  SCAN_ABORTED: 'SCAN_ABORTED'
}

export type CoreErrorCodeValue = CoreErrorCode[keyof CoreErrorCode]

/** Error thrown by core helpers when an input is unusable. */
export class CoreError extends Error {
  readonly code: CoreErrorCodeValue

  constructor(code: CoreErrorCodeValue, message: string) {
    super(message)
    this.name = 'CoreError'
    this.code = code
  }
}

export function isCoreError(value: unknown): value is CoreError {
  return value instanceof CoreError
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * A cancelled scan throws an Error whose `name` is `AbortError` so callers can
 * detect cancellation without importing DOMException.
 */
export function createAbortError(message = '扫描已取消。'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name?: unknown }).name === 'AbortError'
  )
}

export { errorMessage }
