import { afterAll, describe, expect, it } from 'vitest'
import { autoCheckProject } from '../../src/main/core'
import {
  cleanupTempProjects,
  createTempProject,
  makeBuiltinIgnoreRules,
  makeBuiltinMatchRules
} from './helpers'

afterAll(async () => {
  await cleanupTempProjects()
})

function options(project: { root: string }, overrides: Record<string, unknown> = {}) {
  return {
    projectId: 1,
    projectName: 'broken-refs',
    projectRoot: project.root,
    rules: makeBuiltinMatchRules(),
    ignoreRules: makeBuiltinIgnoreRules(),
    caseSensitive: false,
    maxFileSizeKb: 4096,
    ...overrides
  }
}

describe('autoCheckProject', () => {
  it('finds missing references and suggests the moved file with the same name', async () => {
    const project = await createTempProject({
      'README.md': [
        '# Demo',
        '![texture](assets/textures/old.png)',
        '![healthy](assets/keep.png)',
        '[project](docs/readme.md)'
      ].join('\n'),
      'scripts/run.py': 'open("../assets/textures/old.png", "rb")\n',
      'configs/pipeline.json': '{\n  "texture": "assets/textures/old.png"\n}\n',
      'assets/new/old.png': Buffer.from([1, 2, 3]),
      'assets/keep.png': Buffer.from([4, 5, 6]),
      'docs/readme.md': '# Docs\n'
    })

    const result = await autoCheckProject(options(project))
    expect(result.brokenReferenceCount).toBeGreaterThanOrEqual(3)
    const group = result.groups.find((item) => item.missingPath === 'assets/textures/old.png')
    expect(group).toBeDefined()
    expect(group?.references.length).toBeGreaterThanOrEqual(3)
    expect(group?.candidates[0]).toMatchObject({
      filePath: 'assets/new/old.png',
      reason: 'same-name'
    })
    expect(result.groups.some((item) => item.missingPath === 'assets/keep.png')).toBe(false)
    expect(result.checkedFiles).toBeGreaterThanOrEqual(4)
  })

  it('suggests similarly renamed files instead of only exact basenames', async () => {
    const project = await createTempProject({
      'README.md': '![brick](assets/textures/old_brick_wall.png)\n',
      'assets/materials/brick_wall.png': Buffer.from([1, 2, 3])
    })

    const result = await autoCheckProject(options(project))
    const group = result.groups[0]
    expect(group?.missingPath).toBe('assets/textures/old_brick_wall.png')
    expect(group?.candidates[0]).toMatchObject({
      filePath: 'assets/materials/brick_wall.png',
      reason: 'similar-name'
    })
    expect(group?.candidates[0]?.score).toBeGreaterThan(40)
  })

  it('ignores URLs, module names and extensionless references', async () => {
    const project = await createTempProject({
      'src/app.js': [
        'const img = "https://example.com/a/missing.png";',
        'const mod = require("react");',
        'const local = require("./missing-module");',
        'const route = "docs/guide";'
      ].join('\n'),
      'README.md': 'See [docs](docs/guide).\n'
    })

    const result = await autoCheckProject(options(project))
    expect(result.referenceCount).toBe(0)
    expect(result.brokenReferenceCount).toBe(0)
    expect(result.groups).toEqual([])
  })

  it('respects ignore directories and never scans backups', async () => {
    const project = await createTempProject({
      'README.md': '![gone](assets/missing.png)\n',
      'node_modules/dependency/README.md': '![also](assets/missing.png)\n',
      'dist/bundle.js': 'const x = "assets/missing.png";\n',
      'assets/keep.png': Buffer.from([1, 2, 3])
    })

    const result = await autoCheckProject(options(project))
    expect(result.brokenReferenceCount).toBe(1)
    const group = result.groups[0]
    expect(group?.references).toHaveLength(1)
    expect(group?.references[0]?.filePath).toBe('README.md')
    expect(group?.candidates).toEqual([])
  })

  it('returns an informative error when no rules are enabled', async () => {
    const project = await createTempProject({ 'README.md': '# Empty\n' })
    await expect(
      autoCheckProject(
        options(project, {
          rules: makeBuiltinMatchRules().map((rule) => ({ ...rule, enabled: false }))
        })
      )
    ).rejects.toMatchObject({ code: 'NO_RULES' })
  })
})
