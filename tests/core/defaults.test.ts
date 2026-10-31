import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_IGNORE_RULES,
  BUILTIN_MATCH_RULES,
  DEFAULT_MATCH_MODES,
  DEFAULT_SETTINGS,
  isValidMaxFileSizeKb,
  MAX_FILE_SIZE_KB_LIMIT
} from '../../src/shared/defaults'
import { formatFileSizeKb } from '../../src/renderer/src/lib/format'
import { groupByFile, makeBuiltinIgnoreRules, makeBuiltinMatchRules } from './helpers'
import { scanProject } from '../../src/main/core'

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/mixed-project', import.meta.url))

const EXPECTED_FILES = [
  'README.md',
  'configs/pipeline.json',
  'configs/settings.yaml',
  'docs/guide.md',
  'index.html',
  'notes/plain.txt',
  'scripts/preprocess.py',
  'src/App.vue',
  'src/app.js',
  'workflows/comfyui.json'
]

const EXPECTED_NEW_TEXTS: Record<string, string[]> = {
  'README.md': ['media/new.png'],
  'configs/pipeline.json': ['media/new.png'],
  'configs/settings.yaml': ['media/new.png'],
  'docs/guide.md': ['../media/new.png', '../media/new.png'],
  'index.html': ['media/new.png', '/media/new.png'],
  'notes/plain.txt': ['media/new.png'],
  'scripts/preprocess.py': ['../media/new.png', '../media/new.png'],
  'src/App.vue': ['../media/new.png', '../media/new.png'],
  'src/app.js': ['../media/new.png'],
  'workflows/comfyui.json': ['media/new.png', 'media/new.png']
}

function sortTexts(values: string[]): string[] {
  return [...values].sort()
}

describe('built-in defaults — shape and validity', () => {
  it('keeps the documented exported defaults', () => {
    expect(DEFAULT_MATCH_MODES).toEqual({ strict: true, basename: true, directory: true })
    expect(DEFAULT_SETTINGS.matchModes).toEqual(DEFAULT_MATCH_MODES)
    expect(DEFAULT_SETTINGS.caseSensitive).toBe(false)
    // 2.1 raises the per-file ceiling to 1 GB (1,048,576 KB).
    expect(DEFAULT_SETTINGS.maxFileSizeKb).toBe(1_048_576)
    expect(DEFAULT_SETTINGS.lastProjectId).toBeNull()
  })

  it('shares one 1 GB limit between settings UI and backend validation', () => {
    expect(MAX_FILE_SIZE_KB_LIMIT).toBe(1_048_576)
    // UI accepts 1,048,576 KB (plan B2 acceptance) ...
    expect(isValidMaxFileSizeKb(1_048_576)).toBe(true)
    // ... and rejects 1,048,577 KB.
    expect(isValidMaxFileSizeKb(1_048_577)).toBe(false)
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1048576']) {
      expect(isValidMaxFileSizeKb(invalid)).toBe(false)
    }
    // The settings hint renders the ceiling through formatFileSizeKb.
    expect(formatFileSizeKb(MAX_FILE_SIZE_KB_LIMIT)).toBe('1.0 GB')
  })

  it('exposes uniquely keyed, ordered match rules with valid categories', () => {
    const keys = BUILTIN_MATCH_RULES.map((rule) => rule.key)
    expect(new Set(keys).size).toBe(keys.length)
    const categories = new Set(['markdown', 'code', 'config', 'web', 'workflow', 'text', 'custom'])
    for (const rule of BUILTIN_MATCH_RULES) {
      expect(rule.name.length).toBeGreaterThan(0)
      expect(rule.description.length).toBeGreaterThan(0)
      expect(categories.has(rule.category)).toBe(true)
      expect(typeof rule.priority).toBe('number')
      expect(rule.enabled).toBe(true)
      expect(rule.pattern).toContain('(?<path>')
    }
  })

  it('covers the required formats with dedicated rules', () => {
    const keys = new Set(BUILTIN_MATCH_RULES.map((rule) => rule.key))
    expect(keys.has('markdown-link')).toBe(true)
    expect(keys.has('markdown-reference')).toBe(true)
    expect(keys.has('web-assets')).toBe(true)
    expect(keys.has('code-import-path')).toBe(true)
    expect(keys.has('code-file-api')).toBe(true)
    expect(keys.has('config-path-field')).toBe(true)
    expect(keys.has('config-path-unquoted')).toBe(true)
    expect(keys.has('workflow-comfyui')).toBe(true)
    expect(keys.has('plain-path-token')).toBe(true)
    expect(keys.has('web-css-url')).toBe(true)
  })

  it('exposes unique ignore rules including the essential built-ins', () => {
    const keys = BUILTIN_IGNORE_RULES.map((rule) => rule.key)
    expect(new Set(keys).size).toBe(keys.length)
    const patterns = new Set(BUILTIN_IGNORE_RULES.map((rule) => rule.pattern))
    for (const pattern of ['.git', 'node_modules', '.pathkeeper-backup', '.exe', '.png']) {
      expect(patterns.has(pattern)).toBe(true)
    }
    for (const rule of BUILTIN_IGNORE_RULES) {
      expect(['dir', 'suffix', 'glob']).toContain(rule.kind)
      expect(rule.label.length).toBeGreaterThan(0)
      expect(typeof rule.sortOrder).toBe('number')
    }
  })
})

describe('built-in rules — real fixture project scan', () => {
  it('scans Markdown, HTML, JS, Vue, Python, JSON, YAML, ComfyUI and plain text', async () => {
    const result = await scanProject({
      projectId: 7,
      projectName: '混合格式夹具',
      projectRoot: FIXTURE_ROOT,
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      modes: { strict: true, basename: true, directory: true },
      rules: makeBuiltinMatchRules(),
      ignoreRules: makeBuiltinIgnoreRules(),
      caseSensitive: false,
      maxFileSizeKb: 4096
    })

    const grouped = groupByFile(result)
    expect([...grouped.keys()].sort()).toEqual(EXPECTED_FILES)
    expect(result.scannedFiles).toBe(EXPECTED_FILES.length)
    expect(result.candidateFiles).toBe(EXPECTED_FILES.length)

    for (const filePath of EXPECTED_FILES) {
      const items = grouped.get(filePath) ?? []
      expect(items.length, `${filePath} occurrence count`).toBe(
        EXPECTED_NEW_TEXTS[filePath]?.length ?? 0
      )
      expect(sortTexts(items.map((item) => item.newText))).toEqual(
        sortTexts(EXPECTED_NEW_TEXTS[filePath] ?? [])
      )
    }

    // Every replacement is a style-preserved new path; URLs, templates and
    // unrelated files are never rewritten.
    for (const item of result.items) {
      expect(item.newText).not.toContain('http')
      expect(item.newText).not.toContain('${')
      expect(item.oldText).not.toContain('http')
      expect(item.oldText).not.toContain('${')
      expect(item.oldText).toContain('assets/old.png')
      expect(item.newText).toMatch(/media\/new\.png/)
      expect(item.line).toBeGreaterThanOrEqual(1)
      expect(item.column).toBeGreaterThanOrEqual(1)
      expect(item.context).toContain('assets/old.png')
    }
    expect(result.items.some((item) => item.filePath === 'notes/plain.txt')).toBe(true)
    expect(result.snapshots).toHaveLength(EXPECTED_FILES.length)
  })

  it('does not rewrite remote URLs or template placeholders in the fixture', async () => {
    const result = await scanProject({
      projectId: 7,
      projectName: '混合格式夹具',
      projectRoot: FIXTURE_ROOT,
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      modes: { strict: true, basename: true, directory: true },
      rules: makeBuiltinMatchRules(),
      ignoreRules: [],
      caseSensitive: false,
      maxFileSizeKb: 4096
    })
    const readmeItems = result.items.filter((item) => item.filePath === 'README.md')
    expect(readmeItems).toHaveLength(1)
    expect(readmeItems[0]?.oldText).toBe('assets/old.png')
    const allOldTexts = result.items.map((item) => item.oldText)
    expect(allOldTexts).not.toContain('https://example.com/assets/old.png')
    expect(allOldTexts.some((text) => text.includes('${PROJECT_ROOT}'))).toBe(false)
    // `assets/other.png` must never be rewritten.
    expect(allOldTexts.some((text) => text.includes('other.png'))).toBe(false)
  })
})
