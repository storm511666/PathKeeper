/**
 * Match-rule validation and compilation.
 *
 * Rules are JavaScript regular expressions. The scanner always adds the `g`
 * and `d` flags itself so user/seed flags may contain them; the capture used
 * for replacement is the named group `path`, or the first capture group.
 */

import type { RuleTestResult, RuleValidation } from '../../shared/types'
import { CoreError, errorMessage } from './errors'

const ALLOWED_FLAGS: ReadonlySet<string> = new Set(['i', 'm', 's', 'u'])
const FLAG_ORDER = 'imsu'
const MAX_PATTERN_LENGTH = 4000
const MAX_TEST_MATCHES = 500

export interface SanitizedFlags {
  /** Flags safe to pass to `RegExp`, without `g`/`d`. */
  flags: string
  error: string | null
}

/** Strip engine-managed `g`/`d`, de-duplicate and reject unknown flags. */
export function sanitizeRuleFlags(flags: unknown): SanitizedFlags {
  if (flags === undefined || flags === null) return { flags: '', error: null }
  if (typeof flags !== 'string') return { flags: '', error: '正则标志必须是字符串。' }
  const seen = new Set<string>()
  for (const character of flags) {
    if (character === 'g' || character === 'd') continue
    if (!ALLOWED_FLAGS.has(character)) {
      return { flags: '', error: `不支持的正则标志：“${character}”。仅支持 i、m、s、u。` }
    }
    seen.add(character)
  }
  let result = ''
  for (const character of FLAG_ORDER) {
    if (seen.has(character)) result += character
  }
  return { flags: result, error: null }
}

/** Named capture group names declared in a pattern source. */
export function extractNamedGroupNames(pattern: string): string[] {
  if (typeof pattern !== 'string') return []
  const names: string[] = []
  const groupPattern = /\(\?<([A-Za-z_$][\w$]*)>/g
  let match: RegExpExecArray | null
  while ((match = groupPattern.exec(pattern)) !== null) {
    const name = match[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/** Number of capturing groups in a valid pattern (0 when there are none). */
export function countCaptureGroups(pattern: string, flags: string): number {
  try {
    const probe = new RegExp(`${pattern}|`, flags)
    const match = probe.exec('')
    return match === null ? 0 : match.length - 1
  } catch {
    return -1
  }
}

function invalidValidation(error: string): RuleValidation {
  return { valid: false, error, captureGroup: null }
}

/**
 * Validate a rule's pattern and flags. A rule is valid only when it compiles
 * and exposes at least one capture group (preferably a named `path` group).
 */
export function validateMatchRule(pattern: string, flags: string): RuleValidation {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return invalidValidation('正则表达式不能为空。')
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return invalidValidation(`正则表达式过长（最多 ${MAX_PATTERN_LENGTH} 个字符）。`)
  }
  const sanitized = sanitizeRuleFlags(flags)
  if (sanitized.error) return invalidValidation(sanitized.error)

  try {
    // Compile with the engine flags to prove it works in the scan loop.
    new RegExp(pattern, `${sanitized.flags}gd`)
  } catch (error) {
    return invalidValidation(`正则表达式无效：${errorMessage(error)}`)
  }

  const groupCount = countCaptureGroups(pattern, sanitized.flags)
  if (groupCount < 1) {
    return invalidValidation('正则表达式必须包含一个命名捕获组 path，或至少一个捕获组，用于标识要替换的路径。')
  }
  const namedGroups = extractNamedGroupNames(pattern)
  const captureGroup = namedGroups.includes('path') ? 'path' : '1'
  return { valid: true, error: null, captureGroup }
}

export interface CompiledRule {
  regex: RegExp
  /** `'path'` when a named group is used, otherwise the group index as text. */
  captureGroup: string
  captureName: string | null
  captureIndex: number
}

/**
 * Compile a validated rule with engine flags (`g` + `d`). Throws a
 * `CoreError('INVALID_PATTERN')` when the source cannot be compiled; the
 * scanner catches this and degrades to a warning.
 */
export function compileMatchRule(pattern: string, flags: string): CompiledRule {
  const sanitized = sanitizeRuleFlags(flags)
  if (sanitized.error) throw new CoreError('INVALID_PATTERN', sanitized.error)
  const engineFlags = `${sanitized.flags}gd`
  let regex: RegExp
  try {
    regex = new RegExp(pattern, engineFlags)
  } catch (error) {
    throw new CoreError('INVALID_PATTERN', `正则表达式无效：${errorMessage(error)}`)
  }
  const captureGroup = extractNamedGroupNames(pattern).includes('path') ? 'path' : '1'
  return {
    regex,
    captureGroup,
    captureName: captureGroup === 'path' ? 'path' : null,
    captureIndex: captureGroup === 'path' ? 0 : 1
  }
}

/** Test a rule against a sample string: counts and returns captured path text. */
export function testMatchRule(pattern: string, flags: string, sample: string): RuleTestResult {
  const validation = validateMatchRule(pattern, flags)
  if (!validation.valid) {
    return { ...validation, matchCount: 0, matches: [] }
  }
  const compiled = compileMatchRule(pattern, flags)
  const input = typeof sample === 'string' ? sample : ''
  const matches: string[] = []
  const regex = compiled.regex
  regex.lastIndex = 0
  let guard = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(input)) !== null) {
    guard += 1
    if (guard > MAX_TEST_MATCHES * 20) break
    if (match[0].length === 0) {
      if (regex.lastIndex >= input.length) break
      regex.lastIndex += 1
      continue
    }
    const indices = match.indices as RegExpIndicesArray | undefined
    const span = compiled.captureName
      ? indices?.groups?.[compiled.captureName]
      : indices?.[compiled.captureIndex]
    const captured = span ? input.slice(span[0], span[1]) : (match[1] ?? match[0])
    if (typeof captured !== 'string') continue
    const trimmed = captured.trim()
    if (trimmed.length === 0) continue
    matches.push(trimmed)
    if (matches.length >= MAX_TEST_MATCHES) break
  }
  return { ...validation, matchCount: matches.length, matches }
}

/** Capture span of the rule's path group inside a match carrying `d` indices. */
export function captureSpan(
  match: RegExpExecArray,
  compiled: CompiledRule
): { start: number; end: number } | null {
  const indices = match.indices as RegExpIndicesArray | undefined
  if (!indices) return null
  let span: [number, number] | undefined
  if (compiled.captureName) {
    span = indices.groups?.[compiled.captureName]
  } else {
    span = indices[compiled.captureIndex]
  }
  if (!span) return null
  const [start, end] = span
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start, end }
}
