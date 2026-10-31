import { describe, expect, it } from 'vitest'
import { createIgnoreEvaluator, globToRegExp } from '../../src/main/core'
import { BUILTIN_IGNORE_RULES } from '../../src/shared/defaults'
import { makeIgnoreRule } from './helpers'

describe('globToRegExp', () => {
  it('matches basenames with * and ?', () => {
    expect(globToRegExp('*.min.js').test('app.min.js')).toBe(true)
    expect(globToRegExp('*.min.js').test('app.js')).toBe(false)
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true)
    expect(globToRegExp('file?.txt').test('file12.txt')).toBe(false)
  })

  it('treats ** as any depth and * as a single segment', () => {
    expect(globToRegExp('**/generated/*.ts').test('a/b/generated/x.ts')).toBe(true)
    expect(globToRegExp('**/generated/*.ts').test('generated/x.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/x.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/deep/x.ts')).toBe(false)
  })

  it('supports character classes and brace alternatives', () => {
    expect(globToRegExp('[abc].txt').test('b.txt')).toBe(true)
    expect(globToRegExp('{foo,bar}.json').test('bar.json')).toBe(true)
    expect(globToRegExp('{foo,bar}.json').test('baz.json')).toBe(false)
  })

  it('is case-insensitive by default', () => {
    expect(globToRegExp('*.PNG').test('logo.png')).toBe(true)
    expect(globToRegExp('*.PNG', true).test('logo.png')).toBe(false)
  })

  it('never matches for malformed globs', () => {
    expect(globToRegExp('[').test('anything')).toBe(false)
  })
})

describe('createIgnoreEvaluator', () => {
  it('matches directory names case-insensitively', () => {
    const evaluator = createIgnoreEvaluator([
      makeIgnoreRule({ pattern: 'node_modules', kind: 'dir' }),
      makeIgnoreRule({ pattern: 'dist', kind: 'dir', enabled: false })
    ])
    expect(evaluator.isIgnoredDirectory('node_modules', 'node_modules')).toBe(true)
    expect(evaluator.isIgnoredDirectory('NODE_MODULES', 'packages/NODE_MODULES')).toBe(true)
    expect(evaluator.isIgnoredDirectory('node_modules2', 'node_modules2')).toBe(false)
    expect(evaluator.isIgnoredDirectory('dist', 'dist')).toBe(false)
    expect(evaluator.activeRuleCount).toBe(1)
  })

  it('matches file suffixes and ignores disabled rules', () => {
    const evaluator = createIgnoreEvaluator([
      makeIgnoreRule({ pattern: '.exe', kind: 'suffix' }),
      makeIgnoreRule({ pattern: '.png', kind: 'suffix', enabled: false }),
      makeIgnoreRule({ pattern: 'min.js', kind: 'suffix' })
    ])
    expect(evaluator.isIgnoredFile('bin/tool.EXE', 'tool.EXE')).toBe(true)
    expect(evaluator.isIgnoredFile('img/logo.png', 'logo.png')).toBe(false)
    expect(evaluator.isIgnoredFile('assets/app.min.js', 'app.min.js')).toBe(true)
    expect(evaluator.isIgnoredFile('src/main.ts', 'main.ts')).toBe(false)
  })

  it('matches basename globs at any depth', () => {
    const evaluator = createIgnoreEvaluator([makeIgnoreRule({ pattern: '*.min.js', kind: 'glob' })])
    expect(evaluator.isIgnoredFile('assets/js/app.min.js', 'app.min.js')).toBe(true)
    expect(evaluator.isIgnoredFile('app.min.js', 'app.min.js')).toBe(true)
    expect(evaluator.isIgnoredFile('app.js', 'app.js')).toBe(false)
  })

  it('matches path globs with ** and directory pruning', () => {
    const evaluator = createIgnoreEvaluator([
      makeIgnoreRule({ pattern: '**/generated/*.ts', kind: 'glob' }),
      makeIgnoreRule({ pattern: 'dist/**', kind: 'glob' })
    ])
    expect(evaluator.isIgnoredFile('src/generated/schema.ts', 'schema.ts')).toBe(true)
    expect(evaluator.isIgnoredFile('generated/schema.ts', 'schema.ts')).toBe(true)
    expect(evaluator.isIgnoredFile('src/normal/schema.ts', 'schema.ts')).toBe(false)
    expect(evaluator.isIgnoredFile('dist/bundle.js', 'bundle.js')).toBe(true)
    expect(evaluator.isIgnoredDirectory('bundle', 'dist/bundle')).toBe(true)
  })

  it('ignores empty patterns and empty rule lists', () => {
    const evaluator = createIgnoreEvaluator([
      makeIgnoreRule({ pattern: '   ', kind: 'glob' }),
      makeIgnoreRule({ pattern: '.tmp', kind: 'suffix', enabled: false })
    ])
    expect(evaluator.activeRuleCount).toBe(0)
    expect(evaluator.isIgnoredFile('a.tmp', 'a.tmp')).toBe(false)
    expect(createIgnoreEvaluator([]).isIgnoredDirectory('node_modules', 'node_modules')).toBe(false)
  })

  it('honours the built-in ignore seed', () => {
    const evaluator = createIgnoreEvaluator(
      BUILTIN_IGNORE_RULES.map((definition, index) => ({
        id: index + 1,
        projectId: 1,
        pattern: definition.pattern,
        kind: definition.kind,
        label: definition.label,
        enabled: definition.enabled,
        builtin: true,
        sortOrder: definition.sortOrder,
        createdAt: '2024-01-01T00:00:00.000Z'
      }))
    )
    expect(evaluator.isIgnoredDirectory('.git', '.git')).toBe(true)
    expect(evaluator.isIgnoredDirectory('node_modules', 'packages/node_modules')).toBe(true)
    expect(evaluator.isIgnoredDirectory('.pathkeeper-backup', '.pathkeeper-backup')).toBe(true)
    expect(evaluator.isIgnoredFile('bin/app.exe', 'app.exe')).toBe(true)
    expect(evaluator.isIgnoredFile('data/weights.safetensors', 'weights.safetensors')).toBe(true)
    expect(evaluator.isIgnoredFile('src/index.ts', 'index.ts')).toBe(false)
  })

  it('supports case-sensitive evaluation when requested', () => {
    const evaluator = createIgnoreEvaluator(
      [makeIgnoreRule({ pattern: 'Build', kind: 'dir' })],
      { caseSensitive: true }
    )
    expect(evaluator.isIgnoredDirectory('Build', 'Build')).toBe(true)
    expect(evaluator.isIgnoredDirectory('build', 'build')).toBe(false)
  })
})
