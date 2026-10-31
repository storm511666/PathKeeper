import { afterEach, describe, expect, it } from 'vitest'
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

describe('PathKeeperService.autoCheck', () => {
  it('finds broken references and returns possible moved files without writing', async () => {
    context = await createTestContext()
    const readme = [
      '# Demo',
      '![texture](assets/textures/old_brick_wall.png)',
      '[ignored](https://example.com/a/missing.png)'
    ].join('\n')
    writeProjectFile(context, 'README.md', readme)
    writeProjectFile(context, 'scripts/run.py', 'open("../assets/textures/old_brick_wall.png")\n')
    writeProjectFile(context, 'assets/materials/brick_wall.png', Buffer.from([1, 2, 3]))
    const project = addProject(context)

    const result = await context.service.autoCheck(project.id)

    expect(result.checkedFiles).toBeGreaterThanOrEqual(2)
    expect(result.brokenReferenceCount).toBeGreaterThanOrEqual(2)
    const group = result.groups.find(
      (item) => item.missingPath === 'assets/textures/old_brick_wall.png'
    )
    expect(group).toBeDefined()
    expect(group?.candidates[0]?.filePath).toBe('assets/materials/brick_wall.png')
    expect(readProjectFile(context, 'README.md')).toBe(readme)
  })

  it('reports an empty result when every reference resolves', async () => {
    context = await createTestContext()
    writeProjectFile(context, 'README.md', '![keep](assets/keep.png)\n')
    writeProjectFile(context, 'assets/keep.png', Buffer.from([1, 2, 3]))
    const project = addProject(context)

    const result = await context.service.autoCheck(project.id)
    expect(result.brokenReferenceCount).toBe(0)
    expect(result.groups).toEqual([])
  })

  it('rejects an unknown project', async () => {
    context = await createTestContext()
    await expect(context.service.autoCheck(999)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND'
    })
  })
})
