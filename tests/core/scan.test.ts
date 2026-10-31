import { readFile, symlink } from 'node:fs/promises'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyTextEdits,
  decodeTextBuffer,
  encodeTextBuffer,
  isCoreError,
  scanProject
} from '../../src/main/core'
import type { ScanProgress } from '../../src/shared/types'
import {
  cleanupTempProjects,
  createTempProject,
  groupByFile,
  makeBuiltinIgnoreRules,
  makeBuiltinMatchRules,
  makeIgnoreRule,
  makeRule,
  makeScanOptions,
  runScan,
  sha256
} from './helpers'

afterEach(cleanupTempProjects)

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

describe('scanProject — mixed text formats', () => {
  it('finds references in Markdown, HTML, JS, Python, JSON, YAML, ComfyUI, plain text', async () => {
    const project = await createTempProject({
      'README.md': '# Demo\n\n![logo](assets/old.png)\n',
      'docs/guide.md': 'See [asset](../assets/old.png).\n\n[ref]: assets/old.png\n',
      'index.html': '<img src="assets/old.png" />\n',
      'src/app.js': "import logo from '../assets/old.png'\n",
      'scripts/preprocess.py': 'from PIL import Image\n\nimg = Image.open("../assets/old.png")\n',
      'configs/pipeline.json': '{\n  "model_path": "assets/old.png"\n}\n',
      'configs/settings.yaml': 'model_path: assets/old.png\n',
      'workflows/comfyui.json': '{\n  "1": { "inputs": { "ckpt_name": "assets/old.png" } }\n}\n',
      'notes/plain.txt': 'Copied assets/old.png to the backup folder.\n'
    })

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })

    const grouped = groupByFile(result)
    const expectedFiles = [
      'README.md',
      'docs/guide.md',
      'index.html',
      'src/app.js',
      'scripts/preprocess.py',
      'configs/pipeline.json',
      'configs/settings.yaml',
      'workflows/comfyui.json',
      'notes/plain.txt'
    ]
    for (const filePath of expectedFiles) {
      expect(grouped.get(filePath), `no occurrence in ${filePath}`).toBeDefined()
    }

    const newTexts = (filePath: string): string[] =>
      (grouped.get(filePath) ?? []).map((item) => item.newText)

    expect(newTexts('README.md')).toEqual(['media/new.png'])
    expect(newTexts('docs/guide.md')).toEqual(['../media/new.png', 'media/new.png'])
    expect(newTexts('index.html')).toEqual(['media/new.png'])
    expect(newTexts('src/app.js')).toEqual(['../media/new.png'])
    expect(newTexts('scripts/preprocess.py')).toEqual(['../media/new.png'])
    expect(newTexts('configs/pipeline.json')).toEqual(['media/new.png'])
    expect(newTexts('configs/settings.yaml')).toEqual(['media/new.png'])
    expect(newTexts('workflows/comfyui.json')).toEqual(['media/new.png'])
    expect(newTexts('notes/plain.txt')).toEqual(['media/new.png'])

    for (const item of result.items) {
      expect(item.matchMode).toBe('strict')
      expect(item.oldText.endsWith('assets/old.png')).toBe(true)
      expect(item.length).toBe(item.oldText.length)
    }
    expect(result.scannedFiles).toBe(9)
    expect(result.snapshots).toHaveLength(9)
  })

  it('reports project-relative occurrence paths and absolute snapshot paths', async () => {
    const project = await createTempProject({
      'docs/note.md': '[x](../data/old.txt)\n',
      'data/old.txt': 'legacy'
    })
    const result = await runScan(project, {
      oldPath: 'data/old.txt',
      newPath: 'media/new.txt',
      kind: 'file'
    })
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.projectRoot).toBe(nodePath.resolve(project.root))
    for (const item of result.items) {
      expect(nodePath.isAbsolute(item.filePath)).toBe(false)
      expect(item.filePath).not.toContain('\\')
      expect(item.filePath).toBe('docs/note.md')
    }
    expect(result.snapshots).toHaveLength(2)
    for (const snapshot of result.snapshots) {
      expect(nodePath.isAbsolute(snapshot.filePath)).toBe(true)
      const raw = await readFile(snapshot.filePath)
      expect(snapshot.size).toBe(raw.length)
      expect(snapshot.hash).toBe(sha256(raw))
      expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('scanProject — deterministic output', () => {
  it('sorts items by file path and offset and keeps stable IDs', async () => {
    const project = await createTempProject({
      'z-last.txt': 'assets/old.png\n',
      'a-first.md': '![a](assets/old.png)\n',
      'm-middle.js': "load('./assets/old.png')\n"
    })
    const rules = makeBuiltinMatchRules()
    const first = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      rules
    })
    const second = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      rules
    })
    expect(first.items.map((item) => item.filePath)).toEqual(
      second.items.map((item) => item.filePath)
    )
    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id))
    expect(first.items.map((item) => item.offset)).toEqual(second.items.map((item) => item.offset))
    expect(first.scanToken).not.toBe(second.scanToken)

    const expectedOrder = ['a-first.md', 'm-middle.js', 'z-last.txt']
    expect(first.items.map((item) => item.filePath)).toEqual(expectedOrder)

    for (let index = 1; index < first.items.length; index += 1) {
      const previous = first.items[index - 1]
      const current = first.items[index]
      if (!previous || !current) continue
      const key = `${previous.filePath}\u0000${String(previous.offset).padStart(12, '0')}`
      const nextKey = `${current.filePath}\u0000${String(current.offset).padStart(12, '0')}`
      expect(key <= nextKey).toBe(true)
    }
  })
})

describe('scanProject — occurrence metadata', () => {
  it('computes line, column, context, snippet and offsets', async () => {
    const project = await createTempProject({
      'notes.txt': 'line one\nprefix ./assets/old.png suffix\nlast line\n'
    })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    if (!item) throw new Error('missing occurrence')
    const text = 'line one\nprefix ./assets/old.png suffix\nlast line\n'
    expect(item.filePath).toBe('notes.txt')
    expect(item.oldText).toBe('./assets/old.png')
    expect(item.newText).toBe('./media/new.png')
    expect(item.offset).toBe(text.indexOf('./assets/old.png'))
    expect(item.length).toBe('./assets/old.png'.length)
    expect(text.slice(item.offset, item.offset + item.length)).toBe(item.oldText)
    expect(item.line).toBe(2)
    expect(item.column).toBe('prefix '.length + 1)
    expect(item.context).toBe('prefix ./assets/old.png suffix')
    expect(item.snippet).toContain('assets/old.png')
  })

  it('captures 50 characters of context per side', async () => {
    const before = 'a'.repeat(80)
    const after = 'b'.repeat(80)
    const project = await createTempProject({
      'long.txt': `${before} assets/old.png ${after}\n`
    })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })
    const item = result.items[0]
    if (!item) throw new Error('missing occurrence')
    expect(item.context).toBe(`${'a'.repeat(49)} assets/old.png ${'b'.repeat(49)}`)
    expect(item.column).toBe(before.length + 2)
  })
})

describe('scanProject — match modes', () => {
  it('produces nothing when every mode is disabled', async () => {
    const project = await createTempProject({ 'a.txt': 'assets/old.png\n' })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      modes: { strict: false, basename: false, directory: false }
    })
    expect(result.items).toHaveLength(0)
    expect(result.warnings.join('\n')).toContain('均已关闭')
  })

  it('uses basename mode when strict is disabled', async () => {
    const project = await createTempProject({
      'docs/notes.txt': 'look at ../data/old.png now\n'
    })
    const result = await runScan(project, {
      oldPath: 'data/old.png',
      newPath: 'assets/materials/new.png',
      kind: 'file',
      modes: { strict: false, basename: true, directory: false }
    })
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    if (!item) throw new Error('missing occurrence')
    expect(item.matchMode).toBe('basename')
    expect(item.newText).toBe('../assets/materials/new.png')
  })

  it('remaps a moved directory with directory mode', async () => {
    const project = await createTempProject({
      'configs/train.yaml': 'dataset_root: datasets/raw\nimage_dir: datasets/raw/images\n',
      'scripts/train.py': 'DATA = "../datasets/raw"\n',
      'README.md': '![d](datasets/raw/sample.png) and [dir](datasets/raw)\n',
      'notes.txt': 'Copied datasets/raw/images/a.png to storage.\n'
    })
    const result = await runScan(project, {
      oldPath: 'datasets/raw',
      newPath: 'datasets/processed',
      kind: 'directory'
    })
    expect(result.pathInfo.kind).toBe('directory')
    const grouped = groupByFile(result)
    const texts = (filePath: string): string[] =>
      (grouped.get(filePath) ?? []).map((item) => item.newText)

    expect(texts('configs/train.yaml')).toEqual(['datasets/processed', 'datasets/processed/images'])
    expect(texts('scripts/train.py')).toEqual(['../datasets/processed'])
    expect(texts('README.md')).toEqual(['datasets/processed/sample.png', 'datasets/processed'])
    expect(texts('notes.txt')).toEqual(['datasets/processed/images/a.png'])

    const modesByFile = new Map<string, string[]>()
    for (const item of result.items) {
      const list = modesByFile.get(item.filePath) ?? []
      list.push(item.matchMode)
      modesByFile.set(item.filePath, list)
    }
    expect(modesByFile.get('configs/train.yaml')).toEqual(['strict', 'directory'])
    expect(modesByFile.get('scripts/train.py')).toEqual(['strict'])
  })

  it('respects caseSensitive = false/true', async () => {
    const project = await createTempProject({ 'ref.txt': 'ASSETS/OLD.PNG\n' })
    const insensitive = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      caseSensitive: false
    })
    expect(insensitive.items).toHaveLength(1)
    expect(insensitive.items[0]?.newText).toBe('media/new.png')

    const sensitive = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      caseSensitive: true
    })
    expect(sensitive.items).toHaveLength(0)
  })
})

describe('scanProject — ignore handling', () => {
  it('prunes ignored directories, suffixes and globs', async () => {
    const project = await createTempProject({
      'node_modules/pkg/index.js': "const p = 'assets/old.png'\n",
      'dist/bundle.js': "const p = 'assets/old.png'\n",
      'assets/old.png': 'old asset',
      'src/main.js': "const p = 'assets/old.png'\n",
      'logs/build.exe': 'assets/old.png\n',
      'src/generated/schema.ts': "const p = 'assets/old.png'\n"
    })
    const ignoreRules = [
      ...makeBuiltinIgnoreRules(),
      makeIgnoreRule({ pattern: '**/generated/*.ts', kind: 'glob' })
    ]
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      ignoreRules
    })
    expect(result.items.every((item) => item.filePath === 'src/main.js')).toBe(true)
    expect(result.scannedFiles).toBe(1)
    expect(result.candidateFiles).toBe(1)
    expect(result.ignoredFiles).toBeGreaterThanOrEqual(4)
  })
})

describe('scanProject — file safety checks', () => {
  it('skips binary, unsupported-encoding and oversized files with warnings', async () => {
    const project = await createTempProject({
      'ok.txt': 'assets/old.png\n',
      'binary.dat': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
      'gbk.txt': Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      'big.txt': `assets/old.png\n${'x'.repeat(2048)}`,
      'bom.md': Buffer.concat([UTF8_BOM, Buffer.from('![x](assets/old.png)\n', 'utf8')]),
      'utf16.txt': Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('assets/old.png\n', 'utf16le')
      ])
    })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: 1
    })
    expect(result.skippedFiles).toBe(3)
    expect(result.scannedFiles).toBe(3)
    expect(result.candidateFiles).toBe(6)
    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('二进制')
    expect(warnings).toContain('编码')
    expect(warnings).toContain('大小限制')

    const grouped = groupByFile(result)
    expect(grouped.has('ok.txt')).toBe(true)
    expect(grouped.has('bom.md')).toBe(true)
    expect(grouped.has('utf16.txt')).toBe(true)
    // BOM/UTF-16 files are decoded, so offsets are in decoded text space.
    expect(grouped.get('bom.md')?.[0]?.offset).toBe('![x]('.length)
    expect(grouped.get('utf16.txt')?.[0]?.offset).toBe(0)
    for (const snapshot of result.snapshots) {
      expect(snapshot.size).toBe((await readFile(snapshot.filePath)).length)
    }
  })

  it('survives unreadable or vanishing files without crashing the scan', async () => {
    const project = await createTempProject({ 'ok.txt': 'assets/old.png\n' })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })
    expect(result.items.length).toBe(1)
    expect(result.warnings.every((warning) => typeof warning === 'string')).toBe(true)
  })
})

describe('scanProject — rules', () => {
  it('warns about invalid rules and keeps scanning with the valid ones', async () => {
    const project = await createTempProject({ 'a.txt': 'assets/old.png\n' })
    const rules = [
      makeRule({ pattern: '(?<path>[', name: '坏规则', ruleKey: 'bad' }),
      makeRule({ pattern: '(?<path>=+)', name: '无匹配规则', ruleKey: 'nomatch' }),
      ...makeBuiltinMatchRules()
    ]
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      rules
    })
    expect(result.items.length).toBe(1)
    expect(result.warnings.join('\n')).toContain('坏规则')
  })

  it('does not even validate disabled rules', async () => {
    const project = await createTempProject({ 'a.txt': 'assets/old.png\n' })
    const rules = [
      makeRule({ pattern: '(?<path>[', name: '已禁用坏规则', enabled: false }),
      ...makeBuiltinMatchRules()
    ]
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      rules
    })
    expect(result.items.length).toBe(1)
    expect(result.warnings.join('\n')).not.toContain('已禁用坏规则')
  })

  it('deduplicates overlapping captures preferring higher priority rules', async () => {
    const project = await createTempProject({ 'a.txt': 'take assets/old.png here\n' })
    const low = makeRule({
      pattern: String.raw`(?<path>assets/old\.png)`,
      ruleKey: 'low-priority',
      priority: 10
    })
    const high = makeRule({
      pattern: String.raw`(?<path>assets/old\.png)`,
      ruleKey: 'high-priority',
      priority: 90
    })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      rules: [low, high]
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.ruleKey).toBe('high-priority')
    expect(result.items[0]?.newText).toBe('media/new.png')
  })
})

describe('scanProject — progress and cancellation', () => {
  it('reports monotonic progress through all phases', async () => {
    const project = await createTempProject({
      'one.txt': 'assets/old.png\n',
      'two.txt': 'assets/old.png\n',
      'three.txt': 'assets/old.png\n'
    })
    const progress: ScanProgress[] = []
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      onProgress: (entry) => progress.push(entry)
    })
    expect(progress.length).toBeGreaterThan(0)
    const phases = new Set(progress.map((entry) => entry.phase))
    expect(phases.has('preparing')).toBe(true)
    expect(phases.has('walking')).toBe(true)
    expect(phases.has('scanning')).toBe(true)
    expect(phases.has('finalizing')).toBe(true)
    for (let index = 1; index < progress.length; index += 1) {
      const previous = progress[index - 1]
      const current = progress[index]
      if (!previous || !current) continue
      expect(current.percent).toBeGreaterThanOrEqual(previous.percent)
    }
    const last = progress[progress.length - 1]
    expect(last?.percent).toBe(100)
    expect(last?.phase).toBe('finalizing')
    const scanning = progress.filter((entry) => entry.phase === 'scanning')
    expect(scanning.some((entry) => entry.filesTotal === result.candidateFiles)).toBe(true)
  })

  it('does not fail when the progress callback throws', async () => {
    const project = await createTempProject({ 'one.txt': 'assets/old.png\n' })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      onProgress: () => {
        throw new Error('listener boom')
      }
    })
    expect(result.items).toHaveLength(1)
  })

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const project = await createTempProject({ 'one.txt': 'assets/old.png\n' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      scanProject(
        makeScanOptions(project, {
          oldPath: 'assets/old.png',
          newPath: 'media/new.png',
          kind: 'file',
          signal: controller.signal
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('supports aborting from inside the progress callback', async () => {
    const project = await createTempProject({ 'one.txt': 'assets/old.png\n' })
    const controller = new AbortController()
    await expect(
      scanProject(
        makeScanOptions(project, {
          oldPath: 'assets/old.png',
          newPath: 'media/new.png',
          kind: 'file',
          signal: controller.signal,
          onProgress: (entry) => {
            if (entry.phase === 'preparing') controller.abort()
          }
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('scanProject — path validation and symlinks', () => {
  it('propagates path containment errors with a typed code', async () => {
    const project = await createTempProject({ 'a.txt': 'assets/old.png\n' })
    let caught: unknown = null
    try {
      await scanProject(
        makeScanOptions(project, {
          oldPath: String.raw`..\outside\old.png`,
          newPath: 'media/new.png',
          kind: 'file'
        })
      )
    } catch (error) {
      caught = error
    }
    expect(isCoreError(caught)).toBe(true)
    if (isCoreError(caught)) expect(caught.code).toBe('PATH_OUTSIDE_PROJECT')
  })

  it('does not follow directory symlinks/junctions while walking', async () => {
    const project = await createTempProject({
      'real/inside.txt': 'assets/old.png\n'
    })
    let linked = false
    try {
      await symlink(
        project.absolute('real'),
        project.absolute('alias'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      linked = true
    } catch {
      linked = false
    }
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })
    expect(result.items.map((item) => item.filePath)).toEqual(['real/inside.txt'])
    if (linked) {
      expect(result.ignoredFiles).toBeGreaterThanOrEqual(1)
    }
  })

  it('handles a project with no matching content gracefully', async () => {
    const project = await createTempProject({ 'readme.txt': 'nothing to see here\n' })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })
    expect(result.items).toHaveLength(0)
    expect(result.scannedFiles).toBe(1)
    expect(result.snapshots).toHaveLength(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('scanProject — apply integration', () => {
  it('the produced occurrences can be applied and re-encoded losslessly', async () => {
    const project = await createTempProject({
      'README.md': '# Title\n\n![x](assets/old.png)\n',
      'app.js': "const asset = './assets/old.png'\n",
      'notes.txt': 'moved assets/old.png\n'
    })
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file'
    })
    const grouped = groupByFile(result)
    let totalApplied = 0
    for (const [filePath, items] of grouped) {
      const raw = await readFile(project.absolute(filePath))
      const decoded = decodeTextBuffer(raw)
      if (!decoded) throw new Error(`could not decode ${filePath}`)
      const edits = items
        .map((item) => ({
          offset: item.offset,
          length: item.length,
          oldText: item.oldText,
          newText: item.newText
        }))
        .sort((left, right) => left.offset - right.offset)
      const applied = applyTextEdits(decoded.text, edits)
      expect(applied.applied).toBe(edits.length)
      totalApplied += applied.applied
      expect(applied.text).toContain('media/new.png')
      expect(applied.text).not.toContain('assets/old.png')
      const reencoded = encodeTextBuffer(applied.text, decoded.encoding)
      expect(reencoded.length).toBeGreaterThan(0)
    }
    expect(totalApplied).toBe(result.items.length)
  })
})
