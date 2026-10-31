import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScanProgress } from '../../src/shared/types'
import { BUILTIN_MATCH_RULES } from '../../src/shared/defaults'
import { PathKeeperService } from '../../src/main/services/pathkeeper-service'
import type { TestContext } from './helpers'
import {
  NEW_PATH,
  OLD_PATH,
  addProject,
  captureAppError,
  captureAppErrorAsync,
  createTestContext,
  destroyTestContext,
  normalizePath,
  readProjectFile,
  scanFixture,
  writeProjectFile
} from './helpers'

let context: TestContext

beforeEach(async () => {
  context = await createTestContext()
})

afterEach(() => {
  destroyTestContext(context)
})

describe('lifecycle', () => {
  it('initializes the database with defaults and is safe to init/close twice', async () => {
    await context.service.init()
    expect(existsSync(context.service.getDatabasePath())).toBe(true)
    const settings = context.service.getSettings()
    expect(settings.matchModes).toEqual({ strict: true, basename: true, directory: true })
    // 2.1 default: 1 GB per file (1,048,576 KB).
    expect(settings.maxFileSizeKb).toBe(1_048_576)
    expect(settings.lastProjectId).toBeNull()
    context.service.close()
    context.service.close()
  })
})

describe('projects', () => {
  it('adds a project, seeds built-ins, sets lastProjectId and returns lastOpenedAt', () => {
    const project = addProject(context)
    expect(project.rootPath.toLowerCase()).toBe(context.projectRoot.toLowerCase())
    expect(project.name).toBe('project')
    expect(project.lastOpenedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect(context.service.listProjects()).toHaveLength(1)
    expect(context.service.getSettings().lastProjectId).toBe(project.id)
    expect(context.service.listMatchRules(project.id)).toHaveLength(BUILTIN_MATCH_RULES.length)
    expect(context.service.listIgnoreRules(project.id).length).toBeGreaterThan(
      BUILTIN_MATCH_RULES.length
    )
  })

  it('returns the existing project for a duplicate root and keeps one row', () => {
    const first = addProject(context)
    const second = addProject(context)
    expect(second.id).toBe(first.id)
    expect(context.service.listProjects()).toHaveLength(1)
    expect(context.service.getSettings().lastProjectId).toBe(first.id)
  })

  it('rejects invalid project roots and renames projects', () => {
    const missing = captureAppError(() =>
      context.service.addProjectFromPath(`${context.workspace}\\does-not-exist`)
    )
    expect(missing.code).toBe('PROJECT_ROOT_INVALID')

    const project = addProject(context)
    const renamed = context.service.renameProject(project.id, '  新项目  ')
    expect(renamed.name).toBe('新项目')
    expect(captureAppError(() => context.service.renameProject(project.id, '   ')).code).toBe(
      'VALIDATION'
    )
    expect(captureAppError(() => context.service.getProject(9999)).code).toBe('PROJECT_NOT_FOUND')
  })

  it('removes a project but keeps its backups on disk and clears lastProjectId', async () => {
    writeProjectFile(context, 'notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    const project = addProject(context)
    const scan = await scanFixture(context, project)
    expect(scan.items.length).toBeGreaterThan(0)
    const applied = await context.service.apply({
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })
    expect(existsSync(applied.backupDir)).toBe(true)

    const removal = context.service.removeProject(project.id)
    expect(removal.projectId).toBe(project.id)
    expect(removal.backupsRetained).toHaveLength(1)
    expect(existsSync(applied.backupDir)).toBe(true)
    expect(existsSync(`${context.projectRoot}\\.pathkeeper-backup`)).toBe(true)
    expect(context.service.listProjects()).toHaveLength(0)
    expect(context.service.getSettings().lastProjectId).toBeNull()
    expect(captureAppError(() => context.service.listHistory(project.id)).code).toBe(
      'PROJECT_NOT_FOUND'
    )
  })

  it('rejects paths outside the project root and traversal attempts', () => {
    const project = addProject(context)
    const outside = captureAppError(() =>
      context.service.describeProjectPath(project.id, `${context.workspace}\\outside.txt`)
    )
    expect(outside.code).toBe('PATH_OUTSIDE_PROJECT')

    const traversal = captureAppError(() =>
      context.service.resolveProjectFile(project.id, '../outside.txt')
    )
    expect(traversal.code).toBe('PATH_OUTSIDE_PROJECT')

    const absolute = captureAppError(() =>
      context.service.resolveProjectFile(project.id, 'C:\\Windows\\win.ini')
    )
    expect(absolute.code).toBe('PATH_INVALID')

    writeProjectFile(context, 'docs/a.md', '# hi')
    const inside = context.service.resolveProjectFile(project.id, 'docs/a.md')
    expect(inside.relPath).toBe('docs/a.md')
    expect(inside.kind).toBe('file')
  })
})

describe('settings', () => {
  it('updates valid settings and persists them', () => {
    const project = addProject(context)
    const updated = context.service.updateSettings({
      lastProjectId: project.id,
      matchModes: { strict: true, basename: false, directory: true },
      caseSensitive: true,
      maxFileSizeKb: 256
    })
    expect(updated).toEqual({
      lastProjectId: project.id,
      matchModes: { strict: true, basename: false, directory: true },
      caseSensitive: true,
      maxFileSizeKb: 256,
      beginnerMode: true,
      dependencyCheckEnabled: true,
      dependencyAutoScanOnOpen: true,
      dependencyAutoWatch: true,
      dependencyAutoRepair: true
    })
    expect(context.service.getSettings()).toEqual(updated)
  })

  it('validates settings values and unknown fields', () => {
    const project = addProject(context)
    expect(captureAppError(() => context.service.updateSettings({ maxFileSizeKb: 0 })).code).toBe(
      'SETTINGS_INVALID'
    )
    expect(
      captureAppError(() =>
        context.service.updateSettings({ caseSensitive: 'yes' as unknown as boolean })
      ).code
    ).toBe('SETTINGS_INVALID')
    expect(
      captureAppError(() =>
        context.service.updateSettings({
          matchModes: { strict: false, basename: false, directory: false }
        })
      ).code
    ).toBe('SETTINGS_INVALID')
    expect(
      captureAppError(() => context.service.updateSettings({ lastProjectId: 424242 })).code
    ).toBe('PROJECT_NOT_FOUND')
    expect(
      captureAppError(() =>
        context.service.updateSettings({ bogus: true } as unknown as never)
      ).code
    ).toBe('SETTINGS_INVALID')
    expect(context.service.getSettings().lastProjectId).toBe(project.id)
  })

  it('accepts the 1 GB ceiling and rejects one KB above it', () => {
    addProject(context)
    const updated = context.service.updateSettings({ maxFileSizeKb: 1_048_576 })
    expect(updated.maxFileSizeKb).toBe(1_048_576)
    expect(context.service.getSettings().maxFileSizeKb).toBe(1_048_576)
    expect(
      captureAppError(() => context.service.updateSettings({ maxFileSizeKb: 1_048_577 })).code
    ).toBe('SETTINGS_INVALID')
  })

  it('keeps an explicit 4096 KB choice after the default migration already ran', () => {
    addProject(context)
    // The one-time legacy 4096 -> 1 GB migration runs during initialize(); a
    // later deliberate choice must stick instead of being overwritten again.
    const updated = context.service.updateSettings({ maxFileSizeKb: 4096 })
    expect(updated.maxFileSizeKb).toBe(4096)
    expect(context.service.getSettings().maxFileSizeKb).toBe(4096)
  })

  it('persists the 1 GB ceiling across a service restart', async () => {
    addProject(context)
    context.service.updateSettings({ maxFileSizeKb: 1_048_576 })
    const userDataPath = context.service.getUserDataPath()
    context.service.close()

    const restarted = new PathKeeperService(userDataPath)
    await restarted.init()
    context.service = restarted
    expect(restarted.getSettings().maxFileSizeKb).toBe(1_048_576)

    // A real write/read cycle through the new instance keeps it too.
    restarted.updateSettings({ caseSensitive: true })
    expect(restarted.getSettings().maxFileSizeKb).toBe(1_048_576)
  })
})

describe('match rules', () => {
  it('lists built-ins, adds a custom rule and validates regexes', () => {
    const project = addProject(context)
    const builtins = context.service.listMatchRules(project.id)
    expect(builtins.length).toBe(BUILTIN_MATCH_RULES.length)
    expect(builtins.every((rule) => rule.builtin)).toBe(true)

    const custom = context.service.addMatchRule(project.id, {
      name: '自定义',
      description: 'test rule',
      category: 'custom',
      pattern: '"(?<path>[^"]+)"',
      flags: 'g',
      enabled: true
    })
    expect(custom.builtin).toBe(false)
    expect(custom.ruleKey.startsWith('custom-')).toBe(true)
    expect(context.service.listMatchRules(project.id)).toHaveLength(builtins.length + 1)

    expect(context.service.validateMatchRule('"(?<path>[^"]+)"', 'g')).toMatchObject({
      valid: true
    })
    expect(context.service.validateMatchRule('([unclosed', '')).toMatchObject({ valid: false })
    expect(
      captureAppError(() => context.service.updateMatchRule(custom.id, { pattern: '([bad' })).code
    ).toBe('RULE_INVALID')
    expect(
      captureAppError(() =>
        context.service.addMatchRule(project.id, {
          name: 'bad',
          description: '',
          category: 'custom',
          pattern: '([bad',
          flags: '',
          enabled: true
        })
      ).code
    ).toBe('RULE_INVALID')
  })

  it('tests a rule against a sample', () => {
    const result = context.service.testMatchRule('"(?<path>[^"]+)"', '', 'a "b.txt" c')
    expect(result.valid).toBe(true)
    expect(result.matchCount).toBe(1)
    expect(result.matches[0]).toBe('b.txt')
  })

  it('allows editing built-ins but protects them from deletion; reset restores edits', () => {
    const project = addProject(context)
    const builtin = context.service.listMatchRules(project.id)[0]
    expect(builtin).toBeDefined()
    if (!builtin) return

    const updated = context.service.updateMatchRule(builtin.id, {
      enabled: false,
      name: '已停用'
    })
    expect(updated.enabled).toBe(false)
    expect(updated.name).toBe('已停用')

    expect(captureAppError(() => context.service.removeMatchRule(builtin.id)).code).toBe(
      'RULE_BUILTIN_PROTECTED'
    )

    const custom = context.service.addMatchRule(project.id, {
      name: '临时',
      description: '',
      category: 'custom',
      pattern: '"(?<path>[^"]+)"',
      flags: '',
      enabled: true
    })
    context.service.removeMatchRule(custom.id)
    expect(context.service.listMatchRules(project.id).some((rule) => rule.id === custom.id)).toBe(
      false
    )

    const reset = context.service.resetMatchRules(project.id)
    const restored = reset.find((rule) => rule.ruleKey === builtin.ruleKey)
    expect(restored?.enabled).toBe(true)
    expect(restored?.name).toBe(builtin.name)
    expect(reset).toHaveLength(BUILTIN_MATCH_RULES.length)
  })
})

describe('ignore rules', () => {
  it('adds, updates, resets and protects built-in ignore rules', () => {
    const project = addProject(context)
    const before = context.service.listIgnoreRules(project.id)

    const custom = context.service.addIgnoreRule(project.id, {
      pattern: 'log',
      kind: 'suffix',
      label: '日志'
    })
    expect(custom.pattern).toBe('.log')
    expect(custom.builtin).toBe(false)
    expect(custom.enabled).toBe(true)
    expect(context.service.listIgnoreRules(project.id)).toHaveLength(before.length + 1)

    const toggled = context.service.updateIgnoreRule(custom.id, { enabled: false })
    expect(toggled.enabled).toBe(false)
    context.service.removeIgnoreRule(custom.id)
    expect(context.service.listIgnoreRules(project.id)).toHaveLength(before.length)

    const builtin = before.find((rule) => rule.builtin)
    expect(builtin).toBeDefined()
    if (!builtin) return
    context.service.updateIgnoreRule(builtin.id, { enabled: false })
    expect(
      context.service.listIgnoreRules(project.id).find((rule) => rule.id === builtin.id)?.enabled
    ).toBe(false)
    expect(captureAppError(() => context.service.removeIgnoreRule(builtin.id)).code).toBe(
      'IGNORE_BUILTIN_PROTECTED'
    )
    const reset = context.service.resetIgnoreRules(project.id)
    const restoredBuiltin = reset.find(
      (rule) => rule.builtin && rule.pattern === builtin.pattern && rule.kind === builtin.kind
    )
    expect(restoredBuiltin?.enabled).toBe(true)
  })

  it('rejects invalid ignore rules', () => {
    const project = addProject(context)
    expect(
      captureAppError(() =>
        context.service.addIgnoreRule(project.id, { pattern: 'a/b', kind: 'dir' })
      ).code
    ).toBe('IGNORE_INVALID')
    expect(
      captureAppError(() =>
        context.service.addIgnoreRule(project.id, { pattern: 'x', kind: 'weird' as never })
      ).code
    ).toBe('IGNORE_INVALID')
  })
})

describe('path preview', () => {
  it('resolves old/new project-relative posix paths', () => {
    const project = addProject(context)
    const info = context.service.previewPaths({
      projectId: project.id,
      oldPath: OLD_PATH,
      newPath: NEW_PATH,
      kind: 'file'
    })
    expect(info.kind).toBe('file')
    expect(info.oldRel).toBe(OLD_PATH)
    expect(info.newRel).toBe(NEW_PATH)
    expect(normalizePath(info.oldRel)).not.toContain('\\')
  })

  it('maps core path errors to structured AppErrors', () => {
    const project = addProject(context)
    const same = captureAppError(() =>
      context.service.previewPaths({
        projectId: project.id,
        oldPath: OLD_PATH,
        newPath: OLD_PATH,
        kind: 'file'
      })
    )
    expect(same.code).toBe('PATH_INVALID')
    expect((same.details as { coreCode?: string } | undefined)?.coreCode).toBe('SAME_PATH')

    const outside = captureAppError(() =>
      context.service.previewPaths({
        projectId: project.id,
        oldPath: 'C:\\Windows\\win.ini',
        newPath: NEW_PATH,
        kind: 'file'
      })
    )
    expect(outside.code).toBe('PATH_INVALID')
    expect((outside.details as { coreCode?: string } | undefined)?.coreCode).toBe(
      'PATH_OUTSIDE_PROJECT'
    )
  })
})

describe('scan', () => {
  it('finds occurrences and emits preparing/finalizing progress', async () => {
    writeProjectFile(context, 'notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    const project = addProject(context)
    const progress: ScanProgress[] = []
    const scan = await context.service.scan(
      { projectId: project.id, oldPath: OLD_PATH, newPath: NEW_PATH, kind: 'file' },
      (event) => progress.push(event)
    )

    expect(scan.items.length).toBeGreaterThan(0)
    expect(progress[0]?.phase).toBe('preparing')
    expect(progress[progress.length - 1]?.phase).toBe('finalizing')
    expect(progress.every((event) => typeof event.percent === 'number')).toBe(true)

    const item = scan.items[0]
    expect(item).toBeDefined()
    if (!item) return
    expect(item.filePath).toBe('notes/readme.txt')
    expect(item.filePath).not.toContain('\\')
    expect(item.ruleKey.length).toBeGreaterThan(0)
    expect(item.oldText.length).toBeGreaterThan(0)
    expect(item.newText).not.toBe(item.oldText)
    expect(scan.scanToken.length).toBeGreaterThan(0)
    expect('snapshots' in scan).toBe(false)
    expect(scan.budgetStopped).toBe(false)
    expect(scan.projectRoot.toLowerCase()).toBe(context.projectRoot.toLowerCase())
  })

  it('honors custom ignore rules toggled through the service', async () => {
    writeProjectFile(context, 'notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    writeProjectFile(context, 'keep/other.txt', `Move ${OLD_PATH} now.\n`)
    const project = addProject(context)
    const initial = await scanFixture(context, project)
    expect(initial.items.some((item) => item.filePath === 'notes/readme.txt')).toBe(true)
    expect(initial.items.some((item) => item.filePath === 'keep/other.txt')).toBe(true)

    const ignore = context.service.addIgnoreRule(project.id, { pattern: 'notes', kind: 'dir' })
    const filtered = await scanFixture(context, project)
    expect(filtered.items.some((item) => item.filePath === 'notes/readme.txt')).toBe(false)
    expect(filtered.items.some((item) => item.filePath === 'keep/other.txt')).toBe(true)

    context.service.updateIgnoreRule(ignore.id, { enabled: false })
    const restored = await scanFixture(context, project)
    expect(restored.items.some((item) => item.filePath === 'notes/readme.txt')).toBe(true)
  })

  it('honors the maxFileSizeKb setting by skipping large files', async () => {
    writeProjectFile(context, 'notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    const padding = 'x'.repeat(4096)
    writeProjectFile(context, 'large/big.txt', `Move ${OLD_PATH} now.\n${padding}\n`)
    const project = addProject(context)
    const before = await scanFixture(context, project)
    expect(before.items.some((item) => item.filePath === 'large/big.txt')).toBe(true)

    context.service.updateSettings({ maxFileSizeKb: 1 })
    const after = await scanFixture(context, project)
    expect(after.items.some((item) => item.filePath === 'large/big.txt')).toBe(false)
    expect(after.items.some((item) => item.filePath === 'notes/readme.txt')).toBe(true)
  })

  it('skips applying occurrences from report-only large files instead of failing', async () => {
    writeProjectFile(context, 'notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    // >16 MB text file: scanned streaming, occurrences reported, no snapshot.
    const filler = 'x'.repeat(1024)
    const lines: string[] = [`Move ${OLD_PATH} now.`]
    for (let index = 0; index < 17 * 1024; index += 1) lines.push(filler)
    writeProjectFile(context, 'large/huge.txt', `${lines.join('\n')}\n`)
    const project = addProject(context)

    const scan = await scanFixture(context, project)
    const largeItem = scan.items.find((item) => item.filePath === 'large/huge.txt')
    expect(largeItem).toBeDefined()

    const error = await captureAppErrorAsync(
      context.service.apply({
        scanToken: scan.scanToken,
        occurrenceIds: [largeItem?.id ?? '']
      })
    )
    expect(error.code).toBe('APPLY_NOTHING_TO_WRITE')
    const skipped = (error.details as { skipped?: Array<{ reason: string }> } | undefined)?.skipped
    expect(skipped?.[0]?.reason).toContain('只读报告')

    // Nothing was written and the large file keeps its original content.
    expect(readProjectFile(context, 'large/huge.txt')).toContain(`Move ${OLD_PATH} now.`)
    expect(existsSync(`${context.projectRoot}\\.pathkeeper-backup`)).toBe(false)
  })

  it('caps the in-memory scan cache and expires the oldest tokens', async () => {
    writeProjectFile(context, 'notes/readme.txt', `Move ${OLD_PATH} now.\n`)
    const project = addProject(context)
    const tokens: string[] = []
    for (let index = 0; index < 13; index += 1) {
      const result = await scanFixture(context, project)
      tokens.push(result.scanToken)
    }
    const oldest = tokens[0]
    const newest = tokens[tokens.length - 1]
    expect(oldest).toBeDefined()
    expect(newest).toBeDefined()
    if (!oldest || !newest) return

    const expired = await captureAppErrorAsync(
      context.service.apply({ scanToken: oldest, occurrenceIds: ['some-id'] })
    )
    expect(expired.code).toBe('SCAN_EXPIRED')

    // The newest session is still cached (fails on selection, not on token).
    const stillCached = await captureAppErrorAsync(
      context.service.apply({ scanToken: newest, occurrenceIds: ['some-id'] })
    )
    expect(stillCached.code).toBe('SCAN_SELECTION_INVALID')
  })

  it('returns an empty result for a project without matching references and rejects unknown projects', async () => {
    const project = addProject(context)
    const empty = await scanFixture(context, project)
    expect(empty.items).toHaveLength(0)
    await expect(
      context.service.scan({ projectId: 9999, oldPath: OLD_PATH, newPath: NEW_PATH, kind: 'file' })
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    expect(
      captureAppError(() =>
        context.service.previewPaths({
          projectId: project.id,
          oldPath: '   ',
          newPath: NEW_PATH,
          kind: 'file'
        })
      ).code
    ).toBe('VALIDATION')
  })
})
