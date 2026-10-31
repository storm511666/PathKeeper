import { afterAll, describe, expect, it } from 'vitest'
import { scanDependencies, classifyDependencyRole, diffDependencyNode } from '../../src/main/core'
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
    projectName: 'deps',
    projectRoot: project.root,
    rules: makeBuiltinMatchRules(),
    ignoreRules: makeBuiltinIgnoreRules(),
    caseSensitive: false,
    maxFileSizeKb: 4096,
    ignoredPaths: [],
    ...overrides
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

describe('classifyDependencyRole', () => {
  it('classifies config, cache, output and input paths by precedence', () => {
    expect(classifyDependencyRole('config/app.json')).toBe('config')
    expect(classifyDependencyRole('outputs/render.png')).toBe('output')
    expect(classifyDependencyRole('cache/model.tmp')).toBe('cache')
    expect(classifyDependencyRole('assets/textures/a.png')).toBe('input')
    expect(classifyDependencyRole('src/app.ts')).toBe('source')
    expect(classifyDependencyRole('unknown.bin')).toBe('input')
  })
})

describe('scanDependencies', () => {
  it('builds a dependency graph and reports readable issues', async () => {
    const project = await createTempProject({
      'README.md': [
        '# Demo',
        '![missing](assets/old.png)',
        '![wrong format](assets/fake.png)',
        '[bad config](configs/bad.json)',
        '[version](configs/version.json)'
      ].join('\n'),
      'configs/app.json': JSON.stringify({ input: '../assets/keep.png', output: '../outputs/result.txt' }),
      'configs/bad.json': '{ this is not valid json',
      'configs/version.json': JSON.stringify({ version: '1.0.0' }),
      '.pathkeeper/dependency-policy.json': JSON.stringify({
        dependencies: [{ path: 'configs/version.json', minVersion: '2.0.0' }]
      }),
      'scripts/run.py': [
        'with open("../assets/keep.png", "rb") as handle:',
        '    pass',
        'with open("../cache/stale.tmp", "rb") as handle:',
        '    pass'
      ].join('\n'),
      'assets/new/old.png': PNG,
      'assets/keep.png': PNG,
      'assets/fake.png': 'this is plain text, not a png',
      'cache/stale.tmp': Buffer.alloc(0),
      'outputs/result.txt': 'ok'
    })

    const result = await scanDependencies(options(project))
    expect(result.summary.totalNodes).toBeGreaterThan(0)
    expect(result.summary.totalEdges).toBeGreaterThan(0)
    expect(result.summary.checkedFiles).toBeGreaterThan(0)
    expect(result.nodes.some((node) => node.role === 'config')).toBe(true)
    expect(result.nodes.some((node) => node.role === 'input')).toBe(true)
    expect(result.nodes.some((node) => node.role === 'output')).toBe(true)
    expect(result.nodes.some((node) => node.role === 'cache')).toBe(true)

    const missing = result.issues.find(
      (issue) => issue.health === 'missing' && issue.path === 'assets/old.png'
    )
    expect(missing).toBeDefined()
    expect(missing?.candidates[0]).toMatchObject({
      filePath: 'assets/new/old.png',
      reason: 'same-name'
    })
    expect(missing?.canAutoFix).toBe(true)
    expect(missing?.severity).toBe('blocking')

    expect(result.issues.some((issue) => issue.path === 'assets/fake.png' && issue.health === 'format-mismatch')).toBe(true)
    expect(result.issues.some((issue) => issue.path === 'configs/bad.json' && issue.health === 'corrupt')).toBe(true)
    expect(result.issues.some((issue) => issue.path === 'configs/version.json' && issue.health === 'version-mismatch')).toBe(true)
    const cacheIssue = result.issues.find((issue) => issue.path === 'cache/stale.tmp')
    expect(cacheIssue?.role).toBe('cache')
    expect(cacheIssue?.canRebuildCache).toBe(true)
  })

  it('honors user skip list', async () => {
    const project = await createTempProject({
      'README.md': '![missing](assets/old.png)\n',
      'assets/new/old.png': PNG
    })
    const result = await scanDependencies(
      options(project, { ignoredPaths: ['assets/old.png'] })
    )
    expect(result.issues).toEqual([])
    expect(result.summary.ignoredCount).toBe(1)
    expect(result.nodes.find((node) => node.path === 'assets/old.png')?.health).toBe('ignored')
  })

  it('does not follow ignored directories or backups', async () => {
    const project = await createTempProject({
      'README.md': '![missing](assets/old.png)\n',
      'node_modules/pkg/readme.md': '![x](assets/in-node.png)\n',
      '.pathkeeper-backup/old/readme.md': '![y](assets/in-backup.png)\n'
    })
    const result = await scanDependencies(options(project))
    expect(result.issues.some((issue) => issue.path.includes('in-node'))).toBe(false)
    expect(result.issues.some((issue) => issue.path.includes('in-backup'))).toBe(false)
  })

  it('detects a missing node and its later appearance through diffDependencyNode', async () => {
    const project = await createTempProject({ 'README.md': '# x\n' })
    expect(
      diffDependencyNode(project.root, {
        path: 'assets/old.png',
        exists: false,
        size: null,
        modifiedAt: null
      })
    ).toBeNull()
    expect(
      diffDependencyNode(project.root, {
        path: 'assets/old.png',
        exists: true,
        size: 10,
        modifiedAt: new Date().toISOString()
      })?.kind
    ).toBe('missing')
    await project.write('assets/old.png', PNG)
    const appeared = diffDependencyNode(project.root, {
      path: 'assets/old.png',
      exists: false,
      size: null,
      modifiedAt: null
    })
    expect(appeared?.kind).toBe('appeared')
  })
})
