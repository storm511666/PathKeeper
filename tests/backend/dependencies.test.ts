import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PathKeeperService } from '../../src/main/services/pathkeeper-service'
import {
  addProject,
  createTestContext,
  destroyTestContext,
  readProjectFile,
  writeProjectFile,
  type TestContext
} from './helpers'

let context: TestContext | null = null

afterEach(() => {
  if (context) destroyTestContext(context)
  context = null
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

describe('PathKeeperService dependency APIs', () => {
  it('validates, repairs, skips and rebuilds cache safely', async () => {
    context = await createTestContext()
    writeProjectFile(context, 'README.md', '![old](assets/old.png)\n')
    writeProjectFile(context, 'assets/new/old.png', PNG)
    writeProjectFile(context, 'cache/stale.tmp', Buffer.alloc(0))
    writeProjectFile(context, 'scripts/run.py', [
      'open("../assets/old.png", "rb")',
      'open("../cache/stale.tmp", "rb")'
    ].join('\n'))
    const project = addProject(context)

    const first = await context.service.scanDependencies(project.id)
    expect(first.summary.issueCount).toBeGreaterThan(0)
    const missing = first.issues.find((issue) => issue.path === 'assets/old.png')
    expect(missing?.canAutoFix).toBe(true)

    const invalid = context.service.validateDependencyFix({
      projectId: project.id,
      oldPath: 'assets/old.png',
      newPath: 'assets/nope.png'
    })
    expect(invalid.valid).toBe(false)
    expect(invalid.errors[0]).toBeTruthy()

    const fixed = await context.service.repairDependencyPath({
      projectId: project.id,
      oldPath: 'assets/old.png',
      newPath: 'assets/new/old.png'
    })
    expect(fixed.changedFiles).toBeGreaterThanOrEqual(2)
    expect(fixed.replacements).toBeGreaterThanOrEqual(2)
    expect(fixed.backupDir.length).toBeGreaterThan(0)
    expect(readProjectFile(context, 'README.md')).toContain('assets/new/old.png')
    expect(readProjectFile(context, 'scripts/run.py')).toContain('assets/new/old.png')

    const after = await context.service.scanDependencies(project.id)
    expect(after.issues.some((issue) => issue.path === 'assets/old.png')).toBe(false)

    const cacheIssue = after.issues.find((issue) => issue.role === 'cache')
    if (cacheIssue) {
      expect(cacheIssue.canRebuildCache).toBe(true)
      const cacheResult = await context.service.rebuildDependencyCache(project.id, [
        cacheIssue.path
      ])
      expect(cacheResult.movedFiles).toBe(1)
      expect(existsSync(join(cacheResult.backupDir, ...cacheIssue.path.split('/')))).toBe(true)
    }

    // Skip persistence: create another broken file and skip it.
    writeProjectFile(context, 'MORE.md', '![skip](assets/skip.png)\n')
    const withSkip = await context.service.scanDependencies(project.id)
    const skipIssue = withSkip.issues.find((issue) => issue.path === 'assets/skip.png')
    expect(skipIssue).toBeDefined()
    if (skipIssue) {
      context.service.ignoreDependency(project.id, skipIssue.path, true)
      const skipped = await context.service.scanDependencies(project.id)
      expect(skipped.issues.some((issue) => issue.path === skipIssue.path)).toBe(false)
      expect(skipped.summary.ignoredCount).toBeGreaterThanOrEqual(1)
      context.service.ignoreDependency(project.id, skipIssue.path, false)
    }
  })

  it('loads the bundled sample and exposes a friendly project name', async () => {
    context = await createTestContext()
    const sampleDir = join(process.cwd(), 'examples', 'beginner-sample')
    context.service.close()
    const service = new PathKeeperService(join(context.workspace, 'user-data'), {
      sampleProjectDir: sampleDir
    })
    await service.init()
    context.service = service
    const project = service.loadSampleProject()
    expect(project.name).toBe('新手示例工程')
    expect(existsSync(join(project.rootPath, 'assets', 'materials', 'brick_wall.png'))).toBe(true)
    expect(existsSync(join(project.rootPath, 'README.md'))).toBe(true)
    const scan = await service.scanDependencies(project.id)
    expect(scan.issues.length).toBeGreaterThan(0)
  })
})
