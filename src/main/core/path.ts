/**
 * Path normalization and migration-path resolution.
 *
 * Everything here is pure Node: no Electron, no DB, no network. Inputs may use
 * either separator style and may be absolute (inside the project) or
 * project-relative; outputs are stable, OS-relative POSIX project paths.
 */

import nodePath from 'node:path'
import { statSync } from 'node:fs'
import type { PathInfo, PathKind, PathKindInput } from '../../shared/types'
import { CoreError } from './errors'

/** `C:/...` or `C:\...` */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
/** `\\server\share\...` or `//server/share/...` (UNC) */
const UNC_ABSOLUTE = /^[\\/]{2}[^\\/]/
/** Trailing separator, used to infer directory kind for unsaved inputs. */
const TRAILING_SEPARATOR = /[\\/]+$/

/**
 * Convert every separator to `/`, collapse repeated separators and drop a
 * trailing separator (except for a filesystem root). Leading `//` of a UNC
 * path is preserved.
 */
export function normalizeSlashes(value: string): string {
  if (typeof value !== 'string') return ''
  let result = value.replace(/\\/g, '/')
  const isUnc = result.startsWith('//')
  result = result.replace(/\/{2,}/g, '/')
  if (isUnc) result = `/${result}`
  if (result.length > 1 && result.endsWith('/') && !/^[A-Za-z]:\/$/.test(result)) {
    result = result.replace(/\/+$/, '')
  }
  return result
}

/** Convert `/` and `\` to the running platform separator. */
export function toNativeSeparators(value: string): string {
  if (nodePath.sep === '/') return value.replace(/\\/g, '/')
  return value.replace(/\//g, '\\')
}

/** Format a path with an explicit separator character. */
export function formatWithSeparator(pathValue: string, separator: '/' | '\\'): string {
  return separator === '\\' ? pathValue.replace(/\//g, '\\') : pathValue.replace(/\\/g, '/')
}

/** True when the path text looks absolute (drive letter or UNC). */
export function looksAbsolutePath(value: string): boolean {
  return DRIVE_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value)
}

/** Remove one pair of wrapping single/double/backtick quotes. */
function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'" || first === '`') && last === first) {
      return value.slice(1, -1)
    }
  }
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the configured project root to an absolute native path. */
export function resolveProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new CoreError('INVALID_PROJECT_ROOT', '项目根目录不能为空。')
  }
  const cleaned = stripWrappingQuotes(projectRoot.trim())
  if (cleaned.length === 0) {
    throw new CoreError('INVALID_PROJECT_ROOT', '项目根目录不能为空。')
  }
  const normalised = toNativeSeparators(cleaned)
  if (UNC_ABSOLUTE.test(cleaned) || DRIVE_ABSOLUTE.test(cleaned) || nodePath.isAbsolute(normalised)) {
    return nodePath.resolve(normalised)
  }
  return nodePath.resolve(normalised)
}

/**
 * Resolve a user-typed migration path to an absolute native path.
 *
 * A single leading `/` (or `\`) is treated as "project-relative" because the
 * app is project scoped and the renderer may receive hand-written web-root
 * style paths. Drive-letter, UNC and Windows-absolute inputs are used as is.
 */
export function resolveUserPath(projectRootAbs: string, input: string): string {
  if (typeof input !== 'string') {
    throw new CoreError('EMPTY_PATH', '路径不能为空。')
  }
  const trimmed = stripWrappingQuotes(input.trim())
  if (trimmed.length === 0) {
    throw new CoreError('EMPTY_PATH', '路径不能为空。')
  }
  const normalised = toNativeSeparators(trimmed)
  if (DRIVE_ABSOLUTE.test(trimmed) || UNC_ABSOLUTE.test(trimmed)) {
    return nodePath.resolve(normalised)
  }
  if (/^[\\/]/.test(trimmed)) {
    const relative = toNativeSeparators(trimmed).replace(/^[\\/]+/, '')
    return nodePath.resolve(projectRootAbs, relative)
  }
  return nodePath.resolve(projectRootAbs, normalised)
}

/** True when `candidate` is the same as, or beneath, `root`. */
export function isInside(root: string, candidate: string): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  const rootAbs = nodePath.resolve(root)
  const candidateAbs = nodePath.resolve(candidate)
  const relative = nodePath.relative(rootAbs, candidateAbs)
  if (relative === '') return true
  if (nodePath.isAbsolute(relative)) return false
  return !(relative === '..' || relative.startsWith(`..${nodePath.sep}`))
}

/**
 * Convert an absolute path to a POSIX project-relative path.
 * The project root itself maps to `''`. Paths outside the project keep their
 * `../` segments; use {@link isInside} when containment matters.
 */
export function toProjectRelative(root: string, absPath: string): string {
  const rootAbs = nodePath.resolve(root)
  const absolute = nodePath.resolve(absPath)
  const relative = nodePath.relative(rootAbs, absolute)
  if (relative === '') return ''
  return normalizeSlashes(relative)
}

/** POSIX basename of a project-relative path. */
export function relativeBaseName(relativePath: string): string {
  const normalized = normalizeSlashes(relativePath)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/** POSIX dirname of a project-relative path (`''` for root-level files). */
export function relativeDirName(relativePath: string): string {
  const normalized = normalizeSlashes(relativePath)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

function statKind(absolute: string): PathKind | null {
  try {
    const stats = statSync(absolute)
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
  } catch {
    // Path does not exist (yet) or is inaccessible: fall through to heuristics.
  }
  return null
}

/**
 * Decide file vs. directory for `kind: 'auto'`.
 *
 * Preference order: existing old path, existing new path, trailing separator on
 * the raw input, extension heuristic. Warnings are collected when the result
 * had to be guessed.
 */
function resolveKind(
  projectRootAbs: string,
  oldInput: string,
  newInput: string,
  oldAbs: string,
  newAbs: string,
  kindInput: PathKindInput,
  warnings: string[]
): PathKind {
  if (kindInput === 'file' || kindInput === 'directory') {
    const actualOld = statKind(oldAbs)
    const actualNew = statKind(newAbs)
    if (actualOld && actualOld !== kindInput) {
      warnings.push(`旧路径实际是${actualOld === 'directory' ? '目录' : '文件'}，与所选类型不一致。`)
    }
    if (!actualOld && actualNew && actualNew !== kindInput) {
      warnings.push(`新路径实际是${actualNew === 'directory' ? '目录' : '文件'}，与所选类型不一致。`)
    }
    return kindInput
  }
  if (kindInput !== 'auto') {
    throw new CoreError('INVALID_KIND', '无法识别的路径类型，只能是 file、directory 或 auto。')
  }

  const oldStat = statKind(oldAbs)
  if (oldStat) return oldStat
  const newStat = statKind(newAbs)
  if (newStat) {
    warnings.push('原始路径不存在，已根据新路径推断类型。')
    return newStat
  }

  const oldTrimmed = stripWrappingQuotes(oldInput.trim())
  const newTrimmed = stripWrappingQuotes(newInput.trim())
  if (TRAILING_SEPARATOR.test(oldTrimmed) || TRAILING_SEPARATOR.test(newTrimmed)) return 'directory'

  const extension = nodePath.extname(newAbs || oldAbs)
  if (extension.length > 1 && extension.length <= 13) return 'file'

  warnings.push('无法确定路径类型，已按目录处理；可在界面中手动切换。')
  return 'directory'
}

/**
 * Resolve the user's old/new migration inputs against the project root and
 * validate containment. Both paths must live inside the project; the old path
 * is allowed to be missing already (it was moved away).
 */
export function resolveMigrationPaths(
  projectRoot: string,
  oldInput: string,
  newInput: string,
  kindInput: PathKindInput
): PathInfo {
  const projectRootAbs = resolveProjectRoot(projectRoot)
  const oldAbs = resolveUserPath(projectRootAbs, oldInput)
  const newAbs = resolveUserPath(projectRootAbs, newInput)

  if (!isInside(projectRootAbs, oldAbs)) {
    throw new CoreError('PATH_OUTSIDE_PROJECT', '旧路径必须位于项目目录内。')
  }
  if (!isInside(projectRootAbs, newAbs)) {
    throw new CoreError('PATH_OUTSIDE_PROJECT', '新路径必须位于项目目录内。')
  }

  const oldRel = toProjectRelative(projectRootAbs, oldAbs)
  const newRel = toProjectRelative(projectRootAbs, newAbs)
  if (oldRel === '' || newRel === '') {
    throw new CoreError('PATH_IS_PROJECT_ROOT', '迁移路径不能是项目根目录。')
  }
  if (oldRel === newRel || oldAbs === newAbs) {
    throw new CoreError('SAME_PATH', '旧路径与新路径相同，无需迁移。')
  }

  const warnings: string[] = []
  let oldExists = false
  let newExists = false
  try {
    oldExists = statSync(oldAbs).isFile() || statSync(oldAbs).isDirectory()
  } catch {
    oldExists = false
  }
  try {
    newExists = statSync(newAbs).isFile() || statSync(newAbs).isDirectory()
  } catch {
    newExists = false
  }
  if (!oldExists) {
    warnings.push(`旧路径当前不存在（可能已经移动）：${oldRel}`)
  }
  if (!newExists) {
    warnings.push(`新路径当前不存在（移动尚未完成或输入有误）：${newRel}`)
  }

  const kind = resolveKind(projectRootAbs, oldInput, newInput, oldAbs, newAbs, kindInput, warnings)

  return {
    kind,
    oldRel,
    newRel,
    oldName: relativeBaseName(oldRel),
    newName: relativeBaseName(newRel),
    oldAbs,
    newAbs,
    warnings
  }
}

/** Small helper used by diagnostics/tests; never throws. */
export function tryStatKind(absolute: string): PathKind | null {
  return statKind(absolute)
}

export { errorText }
