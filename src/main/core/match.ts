/**
 * Reference analysis, matching and style-preserving replacement generation.
 *
 * A "reference" is the raw text captured by a match rule (normally a single
 * path). The scanner resolves it relative to the source file and to the
 * project root, applies the enabled match modes, and generates a replacement
 * that keeps the original writing style:
 *
 *   - project-root-relative  `assets/logo.png`
 *   - source-relative        `./img/logo.png`, `../assets/logo.png`
 *   - web-root style         `/assets/logo.png`, `\assets\logo.png`
 *   - absolute inside root   `C:\project\assets\logo.png`, `C:/project/assets/logo.png`
 *   - JSON escaped           `C:\\project\\assets\\logo.png`
 *   - bare basename          `logo.png`
 */

import nodePath from 'node:path'
import type { MatchMode, MatchModes, PathKind } from '../../shared/types'
import { isInside, toProjectRelative } from './path'

export interface MigrationTarget {
  /** Absolute native project root. */
  projectRoot: string
  kind: PathKind
  /** POSIX, no leading slash, no trailing slash. */
  oldRel: string
  newRel: string
  oldName: string
  newName: string
  modes: MatchModes
  caseSensitive: boolean
}

/** How the reference is written in the source text. */
export type ReferenceStyle = 'absolute' | 'web-root' | 'source-relative' | 'root-relative' | 'basename'

/** Which directory the reference was anchored to when it matched. */
export type ReferenceBranch = 'absolute' | 'root' | 'source' | 'basename'

export interface AnalyzedReference {
  /** Exact captured text (no surrounding whitespace). */
  raw: string
  /** Path portion only: JSON-unescaped, original separators, no query/hash. */
  logical: string
  /** POSIX-normalized path portion (may keep leading `..` / `/` / drive). */
  posix: string
  style: ReferenceStyle
  /** Separator character used by the original reference. */
  separator: '/' | '\\'
  jsonEscaped: boolean
  escapedSlashes: boolean
  hasDotPrefix: boolean
  hasTrailingSeparator: boolean
  /** Trailing `?query` / `#fragment` preserved verbatim. */
  suffix: string
}

export interface ReferenceMatch {
  matchMode: MatchMode
  branch: ReferenceBranch
  /** New POSIX project-relative path (empty for pure basename fallbacks). */
  targetRel: string
  /** New basename for basename-mode fallbacks, otherwise `null`. */
  basenameOnly: string | null
}

export interface ReferenceEvaluation {
  oldText: string
  newText: string
  matchMode: MatchMode
}

/** URL schemes that are never rewritten. */
const URL_SCHEME = /^(?:https?|data|blob|mailto|ftp|file|javascript|tel|about|chrome|edge|ws|wss):/i
/** Template engines, environment variables and glob wildcards. */
const TEMPLATE_TOKENS: RegExp[] = [
  /\$\{/,
  /\$[A-Za-z_]/,
  /%[A-Za-z_][A-Za-z0-9_]*%/,
  /%\([A-Za-z_][A-Za-z0-9_]*\)s/,
  /\{[^{}]*\}/,
  /<[^<>]*>/,
  /[*?]/
]
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/

function trimPathValue(value: string): string {
  return value.trim()
}

/**
 * Undo JSON string escaping for paths. Only used when the raw text clearly
 * contains escaped sequences (`\\`, `\/`); a plain Windows path such as
 * `C:\new\file.png` is left untouched so `\n` is not mistaken for a newline.
 */
export function unescapeJsonPath(value: string): string {
  let result = ''
  let index = 0
  while (index < value.length) {
    const character = value[index]
    if (character !== '\\') {
      result += character ?? ''
      index += 1
      continue
    }
    const next = value[index + 1]
    if (next === undefined) {
      result += '\\'
      break
    }
    if (next === '\\') {
      result += '\\'
      index += 2
      continue
    }
    if (next === '/') {
      result += '/'
      index += 2
      continue
    }
    if (next === '"') {
      result += '"'
      index += 2
      continue
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) {
      const codePoint = Number.parseInt(value.slice(index + 2, index + 6), 16)
      result += String.fromCharCode(codePoint)
      index += 6
      continue
    }
    if (next === 'n') {
      result += '\n'
      index += 2
      continue
    }
    if (next === 'r') {
      result += '\r'
      index += 2
      continue
    }
    if (next === 't') {
      result += '\t'
      index += 2
      continue
    }
    if (next === 'b') {
      result += '\b'
      index += 2
      continue
    }
    if (next === 'f') {
      result += '\f'
      index += 2
      continue
    }
    // Unknown escape: keep the backslash and continue after it.
    result += '\\'
    index += 1
  }
  return result
}

/** Split a path from a trailing query string / fragment. */
function splitSuffix(value: string): { path: string; suffix: string } {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character !== '?' && character !== '#') continue
    const previous = index > 0 ? value[index - 1] : undefined
    // `assets/?.png` is a glob, not a query string: only treat `?` as a query
    // separator when it follows a path segment character.
    if (character === '?' && (previous === undefined || previous === '/' || previous === '\\')) {
      return { path: value, suffix: '' }
    }
    return { path: value.slice(0, index), suffix: value.slice(index) }
  }
  return { path: value, suffix: '' }
}

function normalizePosixPath(value: string): string {
  const slashNormalized = value.replace(/\\/g, '/')
  let posix = nodePath.posix.normalize(slashNormalized)
  posix = posix.replace(/^\.\//, '')
  if (posix.length > 1) posix = posix.replace(/\/+$/, '')
  return posix
}

/**
 * Decide whether a captured span uses JSON string escaping. A UNC path such as
 * `\\server\share\x.png` also starts with two backslashes but is *not* JSON
 * escaped, so require every backslash run to be even-length and at least one
 * run to contain a doubled backslash.
 */
function detectJsonEscaped(value: string): boolean {
  if (!value.includes('\\')) return false
  const withoutEscapedSlashes = value.replace(/\\\//g, '')
  let index = 0
  let sawDouble = false
  while (index < withoutEscapedSlashes.length) {
    if (withoutEscapedSlashes[index] !== '\\') {
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < withoutEscapedSlashes.length && withoutEscapedSlashes[runEnd] === '\\') {
      runEnd += 1
    }
    const runLength = runEnd - index
    if (runLength % 2 !== 0) return false
    if (runLength >= 2) sawDouble = true
    index = runEnd
  }
  return sawDouble
}

/**
 * Analyze raw captured text. Returns `null` for anything that must never be
 * rewritten: URLs, templates, environment variables, globs, empty or
 * control-filled strings and degenerate paths.
 */
export function analyzeReference(raw: string): AnalyzedReference | null {
  if (typeof raw !== 'string') return null
  const trimmed = trimPathValue(raw)
  if (trimmed.length === 0) return null
  if (trimmed !== raw) return null
  if (CONTROL_CHARACTERS.test(trimmed)) return null

  const jsonEscaped = detectJsonEscaped(trimmed)
  const escapedSlashes = /\\\//.test(trimmed)
  const unescaped = jsonEscaped ? unescapeJsonPath(trimmed) : trimmed
  if (CONTROL_CHARACTERS.test(unescaped)) return null
  if (URL_SCHEME.test(unescaped)) return null

  const { path: pathPartRaw, suffix } = splitSuffix(unescaped)
  const pathPart = pathPartRaw.trim()
  if (pathPart.length === 0) return null
  if (CONTROL_CHARACTERS.test(pathPart)) return null
  for (const token of TEMPLATE_TOKENS) {
    if (token.test(pathPart)) return null
  }

  // Protocol-relative URLs (`//cdn.example.com/x.png`) are not paths.
  if (/^\/\//.test(pathPart)) return null

  let style: ReferenceStyle
  if (/^[A-Za-z]:[\\/]/.test(pathPart) || /^\\\\/.test(pathPart)) {
    style = 'absolute'
  } else if (/^[\\/]/.test(pathPart)) {
    style = 'web-root'
  } else if (/^(?:\.[\\/]|\.\.[\\/])/.test(pathPart)) {
    style = 'source-relative'
  } else if (pathPart === '.' || pathPart === '..') {
    return null
  } else if (pathPart.includes('/') || pathPart.includes('\\')) {
    style = 'root-relative'
  } else {
    style = 'basename'
  }

  const posix = normalizePosixPath(pathPart)
  if (posix.length === 0 || posix === '.' || posix === '/' || /^\.+$/.test(posix)) return null

  const hasBackslash = pathPart.includes('\\')
  const hasForwardSlash = pathPart.includes('/')
  const separator: '/' | '\\' = hasBackslash && !hasForwardSlash ? '\\' : '/'

  return {
    raw,
    logical: pathPart,
    posix,
    style,
    separator,
    jsonEscaped,
    escapedSlashes,
    hasDotPrefix: /^\.[\\/]/.test(pathPart),
    hasTrailingSeparator: /[\\/]$/.test(pathPart),
    suffix
  }
}

function sourceDirName(sourceFileRel: string): string {
  const normalized = sourceFileRel.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

/** Normalize a resolved relative path; `null` when it escapes the project. */
function normalizeRelative(relative: string): string | null {
  if (typeof relative !== 'string') return null
  let value = nodePath.posix.normalize(relative.replace(/\\/g, '/'))
  value = value.replace(/^\.\//, '')
  if (value.length > 1) value = value.replace(/\/+$/, '')
  if (value.length === 0 || value === '.') return null
  if (value.startsWith('/')) return null
  if (value === '..' || value.startsWith('../')) return null
  return value
}

function absoluteReferenceToProjectRelative(
  logical: string,
  projectRootAbs: string
): string | null {
  const native = logical.split(/[\\/]/).join(nodePath.sep)
  const absolute = nodePath.resolve(native)
  if (!isInside(projectRootAbs, absolute)) return null
  const relative = toProjectRelative(projectRootAbs, absolute)
  return relative.length === 0 ? null : relative
}

interface ResolutionCandidate {
  branch: 'absolute' | 'root' | 'source'
  rel: string
}

/** Resolve a reference against the source directory and/or the project root. */
export function resolveReferenceCandidates(
  analysis: AnalyzedReference,
  sourceFileRel: string,
  projectRoot: string
): ResolutionCandidate[] {
  const projectRootAbs = nodePath.resolve(projectRoot)
  const sourceDir = sourceDirName(sourceFileRel)
  const joinFromSource = (value: string): string | null =>
    normalizeRelative(nodePath.posix.join(sourceDir === '' ? '.' : sourceDir, value))

  const candidates: ResolutionCandidate[] = []
  switch (analysis.style) {
    case 'absolute': {
      const relative = absoluteReferenceToProjectRelative(analysis.logical, projectRootAbs)
      if (relative !== null) candidates.push({ branch: 'absolute', rel: relative })
      break
    }
    case 'web-root': {
      const rootRelative = normalizeRelative(analysis.posix.replace(/^\/+/, ''))
      if (rootRelative !== null) candidates.push({ branch: 'root', rel: rootRelative })
      // On POSIX an absolute path that lives inside the project is valid too.
      if (nodePath.sep === '/') {
        const absoluteRelative = absoluteReferenceToProjectRelative(analysis.logical, projectRootAbs)
        if (absoluteRelative !== null && absoluteRelative !== rootRelative) {
          candidates.unshift({ branch: 'absolute', rel: absoluteRelative })
        }
      }
      break
    }
    case 'source-relative': {
      const relative = joinFromSource(analysis.posix)
      if (relative !== null) candidates.push({ branch: 'source', rel: relative })
      break
    }
    case 'root-relative': {
      const rootRelative = normalizeRelative(analysis.posix)
      const sourceRelative = joinFromSource(analysis.posix)
      if (rootRelative !== null) candidates.push({ branch: 'root', rel: rootRelative })
      if (sourceRelative !== null && sourceRelative !== rootRelative) {
        candidates.push({ branch: 'source', rel: sourceRelative })
      }
      break
    }
    case 'basename': {
      const sourceRelative = joinFromSource(analysis.posix)
      const rootRelative = normalizeRelative(analysis.posix)
      if (sourceRelative !== null) candidates.push({ branch: 'source', rel: sourceRelative })
      if (rootRelative !== null && rootRelative !== sourceRelative) {
        candidates.push({ branch: 'root', rel: rootRelative })
      }
      break
    }
  }
  return candidates
}

function pathsEqual(left: string, right: string, caseSensitive: boolean): boolean {
  return caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase()
}

function isBelowDirectory(candidate: string, directory: string, caseSensitive: boolean): boolean {
  const prefix = `${directory}/`
  if (candidate.length <= prefix.length) return false
  return caseSensitive
    ? candidate.startsWith(prefix)
    : candidate.toLowerCase().startsWith(prefix.toLowerCase())
}

function lastSegment(posix: string): string | null {
  const index = posix.lastIndexOf('/')
  const segment = index === -1 ? posix : posix.slice(index + 1)
  if (segment.length === 0 || segment === '.' || segment === '..') return null
  return segment
}

/**
 * Apply the enabled match modes. Mode precedence is strict, then directory,
 * then the smart basename fallback. Disabled modes never match.
 */
export function matchReference(
  analysis: AnalyzedReference,
  sourceFileRel: string,
  target: MigrationTarget
): ReferenceMatch | null {
  const modes = target.modes
  const candidates = resolveReferenceCandidates(analysis, sourceFileRel, target.projectRoot)

  if (modes.strict) {
    for (const candidate of candidates) {
      if (pathsEqual(candidate.rel, target.oldRel, target.caseSensitive)) {
        return {
          matchMode: 'strict',
          branch: candidate.branch,
          targetRel: target.newRel,
          basenameOnly: null
        }
      }
    }
  }

  if (modes.directory && target.kind === 'directory') {
    for (const candidate of candidates) {
      // A reference to the moved directory itself (config `dataset_root:
      // "datasets/raw"`) is remapped when directory mode is enabled, even if
      // strict mode is off.
      if (pathsEqual(candidate.rel, target.oldRel, target.caseSensitive)) {
        return {
          matchMode: 'directory',
          branch: candidate.branch,
          targetRel: target.newRel,
          basenameOnly: null
        }
      }
      if (isBelowDirectory(candidate.rel, target.oldRel, target.caseSensitive)) {
        const suffix = candidate.rel.slice(target.oldRel.length + 1)
        return {
          matchMode: 'directory',
          branch: candidate.branch,
          targetRel: suffix.length === 0 ? target.newRel : `${target.newRel}/${suffix}`,
          basenameOnly: null
        }
      }
    }
  }

  if (modes.basename) {
    // A basename fallback is only safe for references that plausibly live in
    // the project (at least one resolution candidate stays inside the root).
    if (candidates.length === 0) return null
    const segment = lastSegment(analysis.posix)
    if (segment === null) return null
    if (!pathsEqual(segment, target.oldName, target.caseSensitive)) return null
    return {
      matchMode: 'basename',
      branch: 'basename',
      targetRel: target.newRel,
      basenameOnly: target.newName
    }
  }

  return null
}

function formatWithSeparator(pathValue: string, separator: '/' | '\\'): string {
  return separator === '\\' ? pathValue.replace(/\//g, '\\') : pathValue.replace(/\\/g, '/')
}

/** Recompute a full new path for a basename-mode match, by reference style. */
function formatBasenameReplacement(
  analysis: AnalyzedReference,
  sourceFileRel: string,
  target: MigrationTarget
): string | null {
  if (analysis.style === 'basename') {
    // A pure basename reference carries no directory information: only the
    // final segment can be rewritten.
    return target.newName
  }
  if (analysis.style === 'absolute') {
    const native = nodePath.join(target.projectRoot, ...target.newRel.split('/'))
    return formatWithSeparator(native, analysis.separator)
  }
  if (analysis.style === 'web-root') {
    const lead = analysis.separator === '\\' ? '\\' : '/'
    return lead + formatWithSeparator(target.newRel, analysis.separator)
  }
  if (analysis.style === 'source-relative') {
    const sourceDir = sourceDirName(sourceFileRel)
    const from = sourceDir === '' ? '.' : sourceDir
    let relative = nodePath.posix.relative(from, target.newRel)
    if (relative.length === 0) relative = target.newRel
    if (analysis.hasDotPrefix && !relative.startsWith('../')) relative = `./${relative}`
    return formatWithSeparator(relative, analysis.separator)
  }
  // Root-relative: the reference is anchored at the project root.
  return formatWithSeparator(target.newRel, analysis.separator)
}

/**
 * Generate the replacement text while preserving the original style. Returns
 * `null` when no meaningful replacement could be computed.
 */
export function formatReplacement(
  analysis: AnalyzedReference,
  match: ReferenceMatch,
  sourceFileRel: string,
  target: MigrationTarget
): string | null {
  let base: string | null
  if (match.matchMode === 'basename') {
    base = formatBasenameReplacement(analysis, sourceFileRel, target)
  } else if (match.branch === 'absolute') {
    const native = nodePath.join(target.projectRoot, ...match.targetRel.split('/'))
    base = formatWithSeparator(native, analysis.separator)
  } else if (match.branch === 'root') {
    const lead = analysis.style === 'web-root' ? (analysis.separator === '\\' ? '\\' : '/') : ''
    base = lead + formatWithSeparator(match.targetRel, analysis.separator)
  } else if (match.branch === 'source') {
    const sourceDir = sourceDirName(sourceFileRel)
    const from = sourceDir === '' ? '.' : sourceDir
    let relative = nodePath.posix.relative(from, match.targetRel)
    if (relative.length === 0) relative = match.targetRel
    if (analysis.hasDotPrefix && !relative.startsWith('../')) relative = `./${relative}`
    base = formatWithSeparator(relative, analysis.separator)
  } else {
    base = formatWithSeparator(match.targetRel, analysis.separator)
  }
  if (base === null || base.length === 0) return null

  if (analysis.hasTrailingSeparator && !/[\\/]$/.test(base)) {
    base += analysis.separator
  }
  base += analysis.suffix
  if (analysis.jsonEscaped) {
    let escaped = base.replace(/\\/g, '\\\\')
    if (analysis.escapedSlashes) escaped = escaped.replace(/\//g, '\\/')
    base = escaped
  }
  return base
}

/**
 * Full pipeline for a captured reference: analyze, match, and format. Returns
 * `null` when rejected, unmatched, or when the replacement would be identical
 * to the original text (such rows must never be shown as changes).
 */
export function evaluateReference(
  raw: string,
  sourceFileRel: string,
  target: MigrationTarget
): ReferenceEvaluation | null {
  const analysis = analyzeReference(raw)
  if (analysis === null) return null
  const match = matchReference(analysis, sourceFileRel, target)
  if (match === null) return null
  const newText = formatReplacement(analysis, match, sourceFileRel, target)
  if (newText === null || newText.length === 0 || newText === raw) return null
  return { oldText: raw, newText, matchMode: match.matchMode }
}
