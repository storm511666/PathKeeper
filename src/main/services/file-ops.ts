import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AppError, ERROR_CODES, errorMessage } from '../errors'

/** Convert Windows separators to posix; every path stored/returned is posix. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Normalize a project-relative path to posix without a leading `./`. */
export function normalizeRelativePath(value: string): string {
  return toPosixPath(value)
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hashFileSync(absPath: string): string {
  return sha256Hex(readFileSync(absPath))
}

export function fileExists(absPath: string): boolean {
  try {
    return statSync(absPath).isFile()
  } catch {
    return false
  }
}

export function directoryExists(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory()
  } catch {
    return false
  }
}

export function pathExists(absPath: string): boolean {
  try {
    statSync(absPath)
    return true
  } catch {
    return false
  }
}

/** Kind of an existing path, or `null` when the path does not exist. */
export function detectPathKind(absPath: string): 'file' | 'directory' | null {
  try {
    const stats = statSync(absPath)
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

function comparablePath(value: string): string {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Lexical containment check. Handles Windows case-insensitivity and the
 * trailing-separator edge (a path that is the root itself counts as inside).
 */
export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root)
  const normalizedCandidate = comparablePath(candidate)
  if (normalizedRoot === normalizedCandidate) return true
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep
  return normalizedCandidate.startsWith(prefix)
}

/**
 * Defend both against `..` traversal and against symlink/junction escapes.
 * Every write targets a path that may not exist yet, so we resolve real paths
 * for the closest existing ancestor and append the missing segments.
 */
export function assertPathInsideProject(root: string, target: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    throw new AppError(ERROR_CODES.pathOutsideProject, '目标路径位于项目根目录之外，操作已拒绝。', {
      projectRoot: resolvedRoot,
      target: resolvedTarget
    })
  }

  const realRoot = safeRealpath(resolvedRoot)
  let probe = resolvedTarget
  const missingSegments: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    missingSegments.unshift(basename(probe))
    probe = parent
  }
  const realProbe = safeRealpath(probe)
  const realTarget =
    missingSegments.length > 0 ? join(realProbe, ...missingSegments) : realProbe
  if (!isPathInside(realRoot, realTarget)) {
    throw new AppError(
      ERROR_CODES.pathOutsideProject,
      '目标路径通过链接指向了项目根目录之外，操作已拒绝。',
      { projectRoot: realRoot, target: realTarget }
    )
  }
}

function safeRealpath(value: string): string {
  try {
    return realpathSync.native(value)
  } catch {
    return resolve(value)
  }
}

/**
 * Resolve a project-relative path to an absolute path, rejecting absolute
 * inputs, traversal and symlink escapes. Returns posix relative form.
 */
export function resolveProjectPath(
  root: string,
  relativePath: string
): { absPath: string; relPath: string } {
  if (typeof relativePath !== 'string') {
    throw new AppError(ERROR_CODES.pathInvalid, '路径必须是字符串。')
  }
  const trimmed = relativePath.trim()
  if (trimmed.length === 0) {
    throw new AppError(ERROR_CODES.pathInvalid, '路径不能为空。')
  }
  if (trimmed.includes('\0')) {
    throw new AppError(ERROR_CODES.pathInvalid, '路径包含非法字符。', { relativePath })
  }
  const posix = toPosixPath(trimmed)
  if (isAbsolute(posix) || /^[A-Za-z]:/.test(posix) || posix.startsWith('/') || posix.startsWith('//')) {
    throw new AppError(ERROR_CODES.pathInvalid, '必须提供项目相对路径。', { relativePath })
  }
  const projectRoot = resolve(root)
  const absPath = resolve(projectRoot, posix)
  assertPathInsideProject(projectRoot, absPath)
  return {
    absPath,
    relPath: normalizeRelativePath(relative(projectRoot, absPath))
  }
}

/**
 * Atomic-ish write: write to a sibling temp file, then rename over the target.
 * On Windows rename replaces an existing file. If the rename fails the temp
 * file is cleaned up and the original file is untouched.
 */
export function writeFileAtomicSync(targetAbsPath: string, data: Uint8Array): void {
  const directory = dirname(targetAbsPath)
  mkdirSync(directory, { recursive: true })
  const tempPath = join(directory, `.pathkeeper-${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, data, { flag: 'wx' })
    renameSync(tempPath, targetAbsPath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // Temp file may not have been created; ignore.
    }
    throw new AppError(
      ERROR_CODES.internal,
      `无法写入文件 ${basename(targetAbsPath)}：${errorMessage(error)}`,
      { filePath: targetAbsPath }
    )
  }
}

/** Safe recursive delete used only for directories the app itself created. */
export function removeDirectoryRecursive(absPath: string): void {
  if (!pathExists(absPath)) return
  try {
    rmSync(absPath, { recursive: true, force: true })
  } catch (error) {
    throw new AppError(
      ERROR_CODES.backupRemoveFailed,
      `无法删除备份目录：${errorMessage(error)}`,
      { path: absPath }
    )
  }
}

/** Names of entries inside a directory, or `[]` when it does not exist. */
export function listDirectoryNames(absPath: string): string[] {
  try {
    if (!statSync(absPath).isDirectory()) return []
    return readdirSync(absPath).sort()
  } catch {
    return []
  }
}

export function safeLstat(absPath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(absPath)
  } catch {
    return null
  }
}

/**
 * `<ISO timestamp>-<random>` used as the backup folder name. ISO strings are
 * made filename-safe on Windows by replacing `:` and `.` with `-`.
 */
export function createBackupFolderName(date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(4).toString('hex')
  return `${stamp}-${suffix}`
}

/** Split a posix relative path into safe path segments. */
export function splitRelativePath(relativePath: string): string[] {
  return normalizeRelativePath(relativePath)
    .split('/')
    .filter((segment) => segment.length > 0)
}

/** Join posix relative segments into an absolute path below `root`. */
export function joinBelow(root: string, ...relativeSegments: string[]): string {
  return join(resolve(root), ...relativeSegments)
}
