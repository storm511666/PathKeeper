import { describe, expect, it } from 'vitest'
import {
  captureSpan,
  compileMatchRule,
  countCaptureGroups,
  extractNamedGroupNames,
  isCoreError,
  sanitizeRuleFlags,
  testMatchRule,
  validateMatchRule
} from '../../src/main/core'
import { BUILTIN_MATCH_RULES } from '../../src/shared/defaults'

describe('sanitizeRuleFlags', () => {
  it('strips engine-managed g/d flags and de-duplicates', () => {
    expect(sanitizeRuleFlags('gid')).toEqual({ flags: 'i', error: null })
    expect(sanitizeRuleFlags('gim')).toEqual({ flags: 'im', error: null })
    expect(sanitizeRuleFlags('iig')).toEqual({ flags: 'i', error: null })
    expect(sanitizeRuleFlags('sd')).toEqual({ flags: 's', error: null })
  })

  it('rejects unsupported flags', () => {
    const result = sanitizeRuleFlags('x')
    expect(result.error).not.toBeNull()
    expect(result.flags).toBe('')
    expect(sanitizeRuleFlags('gg').error).toBeNull()
  })

  it('accepts missing flags', () => {
    expect(sanitizeRuleFlags(undefined)).toEqual({ flags: '', error: null })
    expect(sanitizeRuleFlags(null)).toEqual({ flags: '', error: null })
  })
})

describe('validateMatchRule', () => {
  it('validates every built-in rule with a named path group', () => {
    for (const definition of BUILTIN_MATCH_RULES) {
      const validation = validateMatchRule(definition.pattern, definition.flags)
      expect(validation.valid, `${definition.key}: ${validation.error}`).toBe(true)
      expect(validation.captureGroup).toBe('path')
      expect(validation.error).toBeNull()
    }
  })

  it('rejects invalid regular expressions', () => {
    const validation = validateMatchRule('(?<path>[', 'g')
    expect(validation.valid).toBe(false)
    expect(validation.error).toContain('无效')
    expect(validation.captureGroup).toBeNull()
  })

  it('rejects unsupported flags', () => {
    const validation = validateMatchRule('(?<path>.+)', 'x')
    expect(validation.valid).toBe(false)
    expect(validation.error).toContain('标志')
  })

  it('rejects empty patterns and patterns without capture groups', () => {
    expect(validateMatchRule('', '')).toMatchObject({ valid: false, captureGroup: null })
    expect(validateMatchRule('   ', '')).toMatchObject({ valid: false })
    expect(validateMatchRule(String.raw`\d+`, '')).toMatchObject({ valid: false })
    expect(validateMatchRule(String.raw`\d+`, '').error).toContain('捕获组')
  })

  it('accepts a first capture group when there is no path group', () => {
    const validation = validateMatchRule(String.raw`asset: ([^\s]+\.png)`, '')
    expect(validation.valid).toBe(true)
    expect(validation.captureGroup).toBe('1')
  })

  it('accepts a pattern whose compile needs the engine flags', () => {
    const validation = validateMatchRule('(?<path>.+)', 'gm')
    expect(validation.valid).toBe(true)
  })

  it('rejects absurdly long patterns', () => {
    expect(validateMatchRule('a'.repeat(5000), '').valid).toBe(false)
  })
})

describe('compileMatchRule and captureSpan', () => {
  it('compiles with global and indices flags and extracts named spans', () => {
    const compiled = compileMatchRule(String.raw`see (?<path>[a-z/]+\.png)`, 'i')
    expect(compiled.regex.flags).toContain('g')
    expect(compiled.regex.flags).toContain('d')
    expect(compiled.captureGroup).toBe('path')
    const text = 'see ASSETS/OLD.PNG and see assets/new.png'
    const match = compiled.regex.exec(text)
    expect(match).not.toBeNull()
    if (!match) return
    const span = captureSpan(match, compiled)
    expect(span).not.toBeNull()
    if (!span) return
    expect(text.slice(span.start, span.end)).toBe('ASSETS/OLD.PNG')
  })

  it('uses the first capture group when no path group exists', () => {
    const compiled = compileMatchRule(String.raw`file: ([^\s]+)`, '')
    const text = 'file: assets/old.png trailing'
    const match = compiled.regex.exec(text)
    if (!match) throw new Error('no match')
    const span = captureSpan(match, compiled)
    if (!span) throw new Error('no span')
    expect(text.slice(span.start, span.end)).toBe('assets/old.png')
  })

  it('returns null when the optional path group did not participate', () => {
    const compiled = compileMatchRule('(?<path>a+)?b', '')
    const match = compiled.regex.exec('b')
    if (!match) throw new Error('no match')
    expect(captureSpan(match, compiled)).toBeNull()
  })

  it('throws a CoreError for an uncompilable pattern', () => {
    let caught: unknown = null
    try {
      compileMatchRule('(?<path>[', '')
    } catch (error) {
      caught = error
    }
    expect(isCoreError(caught)).toBe(true)
    if (isCoreError(caught)) expect(caught.code).toBe('INVALID_PATTERN')
  })
})

describe('countCaptureGroups', () => {
  it('counts capturing groups only', () => {
    expect(countCaptureGroups('abc', '')).toBe(0)
    expect(countCaptureGroups('(a)', '')).toBe(1)
    expect(countCaptureGroups('(?<path>a)(b)', '')).toBe(2)
    expect(countCaptureGroups('(?:a)(?=b)', '')).toBe(0)
    expect(countCaptureGroups('(a)(\\(b\\))', '')).toBe(2)
  })
})

describe('extractNamedGroupNames', () => {
  it('finds named groups and ignores lookbehinds', () => {
    expect(extractNamedGroupNames('(?<=prefix)(?<path>x)(?<other>y)')).toEqual(['path', 'other'])
    expect(extractNamedGroupNames('(?:plain)')).toEqual([])
  })
})

describe('testMatchRule', () => {
  it('returns captured matches and counts', () => {
    const result = testMatchRule(String.raw`"(?<path>[^"]+\.(?:png|jpg))"`, 'g', '"a.png" "b.jpg"')
    expect(result.valid).toBe(true)
    expect(result.matchCount).toBe(2)
    expect(result.matches).toEqual(['a.png', 'b.jpg'])
    expect(result.captureGroup).toBe('path')
  })

  it('returns an empty result for invalid rules', () => {
    const result = testMatchRule('[', '', 'sample')
    expect(result.valid).toBe(false)
    expect(result.matchCount).toBe(0)
    expect(result.matches).toEqual([])
  })

  it('is safe for zero-length matches', () => {
    const result = testMatchRule('(?<path>a*)', 'g', 'aaa')
    expect(result.valid).toBe(true)
    expect(result.matchCount).toBeGreaterThanOrEqual(1)
    expect(result.matchCount).toBeLessThanOrEqual(2)
  })

  it('trims captured values and skips empty captures', () => {
    const result = testMatchRule(String.raw`<(?:path)>|(?<path>\S+)`, '', 'alpha beta')
    expect(result.valid).toBe(true)
    expect(result.matches).toEqual(['alpha', 'beta'])
  })

  it('uses first-group capture values when no path group exists', () => {
    const result = testMatchRule('open\\("([^"]+)"\\)', 'g', 'open("a.png") open("b.png")')
    expect(result.matches).toEqual(['a.png', 'b.png'])
  })
})
