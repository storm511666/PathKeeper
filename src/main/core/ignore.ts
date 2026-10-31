/**
 * Ignore-rule handling: directory names, file suffixes and gitignore-style
 * globs. Walkers prune ignored directories before descending and skip ignored
 * files before reading them.
 */

import type { IgnoreRule } from '../../shared/types'
import { normalizeSlashes } from './path'

export interface IgnoreEvaluator {
  /** True when the whole directory may be pruned. */
  isIgnoredDirectory(name: string, relativePath: string): boolean
  /** True when the file should not be read. */
  isIgnoredFile(relativePath: string, baseName: string): boolean
  /** Number of enabled rules that contributed matchers. */
  readonly activeRuleCount: number
}

export interface IgnoreEvaluatorOptions {
  /** Defaults to false (Windows filesystems are case-insensitive). */
  caseSensitive?: boolean
}

const REGEXP_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

function escapeRegExpCharacter(character: string): string {
  return REGEXP_SPECIAL.has(character) ? `\\${character}` : character
}

/**
 * Translate a glob to an anchored regular expression.
 *
 * Supported syntax: `*` (no directory separator), `**` (any depth), `?`
 * (single non-separator character), `[abc]` character classes and `{a,b}`.
 * Paths are compared with `/` separators.
 */
export function globToRegExp(glob: string, caseSensitive = false): RegExp {
  const pattern = normalizeSlashes(glob.trim())
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === undefined) break
    if (character === '*') {
      const next = pattern[index + 1]
      if (next === '*') {
        const after = pattern[index + 2]
        if (after === '/') {
          // `**/` matches zero or more directories.
          source += '(?:[^/]+/)*'
          index += 3
          continue
        }
        source += '.*'
        index += 2
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (character === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (character === '[') {
      const close = pattern.indexOf(']', index + 1)
      if (close !== -1) {
        let body = pattern.slice(index + 1, close)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        source += `[${body.replace(/\\/g, '\\\\')}]`
        index = close + 1
        continue
      }
    }
    if (character === '{') {
      const close = pattern.indexOf('}', index + 1)
      if (close !== -1) {
        const body = pattern.slice(index + 1, close)
        const alternatives = body.split(',').map((part) => escapeRegExpCharacter(part))
        if (alternatives.length > 1) {
          source += `(?:${alternatives.join('|')})`
          index = close + 1
          continue
        }
      }
    }
    source += escapeRegExpCharacter(character)
    index += 1
  }
  try {
    return new RegExp(`^${source}$`, caseSensitive ? '' : 'i')
  } catch {
    // A malformed glob must never crash the walker: match nothing.
    return /(?!)/ 
  }
}

function normalizeComparison(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase()
}

interface GlobMatcher {
  regex: RegExp
  matchesPath: boolean
}

function createGlobMatcher(glob: string, caseSensitive: boolean): GlobMatcher {
  const normalized = normalizeSlashes(glob)
  return {
    regex: globToRegExp(normalized, caseSensitive),
    matchesPath: normalized.includes('/')
  }
}

/** Build a fast evaluator over the enabled ignore rules of a project. */
export function createIgnoreEvaluator(
  rules: readonly IgnoreRule[],
  options: IgnoreEvaluatorOptions = {}
): IgnoreEvaluator {
  const caseSensitive = options.caseSensitive === true
  const directoryNames = new Set<string>()
  const directoryGlobs: Array<{ regex: RegExp; source: string }> = []
  const suffixMatchers: string[] = []
  const fileGlobs: GlobMatcher[] = []
  let activeRuleCount = 0

  for (const rule of rules ?? []) {
    if (!rule || rule.enabled !== true) continue
    const rawPattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : ''
    if (rawPattern.length === 0) continue
    activeRuleCount += 1

    if (rule.kind === 'dir') {
      if (/[*?[\]{]/.test(rawPattern)) {
        const normalized = normalizeSlashes(rawPattern)
        directoryGlobs.push({
          regex: globToRegExp(normalized, caseSensitive),
          source: normalized
        })
      } else {
        const normalized = normalizeSlashes(rawPattern)
        if (!normalized.includes('/')) {
          directoryNames.add(normalizeComparison(normalized, caseSensitive))
        }
      }
      continue
    }
    if (rule.kind === 'suffix') {
      suffixMatchers.push(normalizeComparison(normalizeSlashes(rawPattern), caseSensitive))
      continue
    }
    if (rule.kind === 'glob') {
      fileGlobs.push(createGlobMatcher(rawPattern, caseSensitive))
    }
  }

  const isIgnoredDirectory = (name: string, relativePath: string): boolean => {
    const relative = normalizeSlashes(relativePath)
    const comparedName = normalizeComparison(name, caseSensitive)
    if (directoryNames.has(comparedName)) return true
    for (const directoryGlob of directoryGlobs) {
      if (directoryGlob.regex.test(comparedName) || directoryGlob.regex.test(relative)) return true
    }
    for (const glob of fileGlobs) {
      if (glob.regex.test(relative)) return true
    }
    return false
  }

  const isIgnoredFile = (relativePath: string, baseName: string): boolean => {
    const relative = normalizeSlashes(relativePath)
    const base = normalizeComparison(baseName, caseSensitive)
    for (const suffix of suffixMatchers) {
      if (base.endsWith(suffix)) return true
    }
    for (const glob of fileGlobs) {
      const target = glob.matchesPath ? relative : base
      if (glob.regex.test(target)) return true
    }
    return false
  }

  return {
    isIgnoredDirectory,
    isIgnoredFile,
    activeRuleCount
  }
}
