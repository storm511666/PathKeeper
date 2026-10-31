import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestContext } from './helpers'
import {
  addProject,
  captureAppErrorAsync,
  createTestContext,
  destroyTestContext
} from './helpers'

let context: TestContext

beforeEach(async () => {
  context = await createTestContext()
})

afterEach(() => {
  destroyTestContext(context)
})

/** Create a tiny stand-in for an installed program inside the test workspace. */
function makeSoftwareDir(name = 'ExampleApp'): { rootPath: string; entryPath: string } {
  const rootPath = join(context.workspace, name)
  mkdirSync(join(rootPath, 'configs'), { recursive: true })
  mkdirSync(join(rootPath, 'output'), { recursive: true })
  const entryPath = join(rootPath, `${name}.exe`)
  // A non-PE payload is fine: text scanning never parses the binary and the
  // version lookup simply falls back to the file name.
  writeFileSync(entryPath, Buffer.from('MZ-pathkeeper-test-payload'))
  writeFileSync(
    join(rootPath, 'configs', 'settings.json'),
    JSON.stringify({ result_path: 'output/result.png' }, null, 2)
  )
  writeFileSync(join(rootPath, 'README.txt'), 'configs/settings.json\n')
  return { rootPath, entryPath }
}

describe('software projects', () => {
  it('adds a software project, persists kind/entry and reuses the same row', async () => {
    const { rootPath, entryPath } = makeSoftwareDir()
    const project = await context.service.addSoftwareProject({
      rootPath,
      entryPath,
      name: '示例软件'
    })
    expect(project.kind).toBe('software')
    expect(project.name).toBe('示例软件')
    expect(project.entryPath).toBe(entryPath)
    expect(project.rootPath.toLowerCase()).toBe(rootPath.toLowerCase())
    expect(context.service.getSettings().lastProjectId).toBe(project.id)
    expect(context.service.listMatchRules(project.id).length).toBeGreaterThan(0)

    const again = await context.service.addSoftwareProject({ rootPath, entryPath })
    expect(again.id).toBe(project.id)
    expect(again.kind).toBe('software')
    expect(context.service.listProjects()).toHaveLength(1)
  })

  it('derives a readable name from the program file when none is given', async () => {
    const { rootPath, entryPath } = makeSoftwareDir('CoolTool')
    const project = await context.service.addSoftwareProject({ rootPath, entryPath })
    expect(project.name).toBe('CoolTool')
  })

  it('rejects an entry program outside the install directory or not an exe', async () => {
    const { rootPath } = makeSoftwareDir()
    const outside = join(context.workspace, 'outside.exe')
    writeFileSync(outside, 'MZ')
    const outsideError = await captureAppErrorAsync(
      context.service.addSoftwareProject({ rootPath, entryPath: outside })
    )
    expect(outsideError.code).toBe('SOFTWARE_TARGET_INVALID')

    const missingError = await captureAppErrorAsync(
      context.service.addSoftwareProject({
        rootPath,
        entryPath: join(rootPath, 'missing.exe')
      })
    )
    expect(missingError.code).toBe('SOFTWARE_TARGET_INVALID')
  })

  it('rejects system directories and drive roots', async () => {
    if (process.platform !== 'win32') return
    const windows = await captureAppErrorAsync(
      context.service.addSoftwareProject({ rootPath: 'C:\\Windows', entryPath: null })
    )
    expect(['SOFTWARE_SYSTEM_DIRECTORY', 'SOFTWARE_TARGET_INVALID']).toContain(windows.code)

    const drive = await captureAppErrorAsync(
      context.service.addSoftwareProject({ rootPath: 'C:\\', entryPath: null })
    )
    expect(['SOFTWARE_TARGET_INVALID', 'SOFTWARE_SYSTEM_DIRECTORY']).toContain(drive.code)
  })

  it('inspects a directory target without writing anything', async () => {
    const { rootPath, entryPath } = makeSoftwareDir('InspectMe')
    const inspected = await context.service.inspectSoftwareTarget(rootPath)
    expect(inspected.rootPath.toLowerCase()).toBe(rootPath.toLowerCase())
    expect(inspected.entryPath).toBe(entryPath)
    expect(inspected.info.iconDataUrl).toBeNull()
    // Read-only: the software directory contents are untouched.
    expect(readFileSync(entryPath, 'utf8')).toBe('MZ-pathkeeper-test-payload')
    expect(context.service.listProjects()).toHaveLength(0)
  })
})

describe('software scan', () => {
  it('produces a text-reference report and never writes to the software directory', async () => {
    const { rootPath, entryPath } = makeSoftwareDir('ScanMe')
    const project = await context.service.addSoftwareProject({ rootPath, entryPath })
    const result = await context.service.scanSoftware({ projectId: project.id, includeBinary: false })

    expect(result.installRoot.toLowerCase()).toBe(rootPath.toLowerCase())
    expect(result.entryPath).toBe(entryPath)
    expect(result.binaryAnalysis).toBe('not-analyzed')
    expect(result.binaryFilesScanned).toEqual([])
    expect(result.textReport).not.toBeNull()
    expect(result.textReport?.projectId).toBe(project.id)
    expect(result.warnings.some((warning) => warning.includes('未分析'))).toBe(true)

    const configPath = join(rootPath, 'configs', 'settings.json')
    expect(readFileSync(configPath, 'utf8')).toBe(
      JSON.stringify({ result_path: 'output/result.png' }, null, 2)
    )
  })

  it('only scans projects that were added as software', async () => {
    writeFileSync(join(context.projectRoot, 'notes.txt'), 'hello\n')
    const project = addProject(context)
    const error = await captureAppErrorAsync(
      context.service.scanSoftware({ projectId: project.id, includeBinary: false })
    )
    expect(error.code).toBe('SOFTWARE_TARGET_INVALID')
  })

  it('keeps the report useful when the entry program was moved or deleted', async () => {
    const { rootPath, entryPath } = makeSoftwareDir('MovedApp')
    const project = await context.service.addSoftwareProject({ rootPath, entryPath })
    rmSync(entryPath, { force: true })
    const result = await context.service.scanSoftware({
      projectId: project.id,
      includeBinary: false
    })
    expect(result.textReport).not.toBeNull()
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('fails cleanly when the whole install directory disappeared', async () => {
    const { rootPath, entryPath } = makeSoftwareDir('GoneApp')
    const project = await context.service.addSoftwareProject({ rootPath, entryPath })
    rmSync(rootPath, { recursive: true, force: true })
    const error = await captureAppErrorAsync(
      context.service.scanSoftware({ projectId: project.id, includeBinary: false })
    )
    expect(error.code).toBe('SOFTWARE_SCAN_FAILED')
  })
})

describe('file previews', () => {
  it('returns text lines for small text files and rejects binary content honestly', async () => {
    const project = addProject(context)
    mkdirSync(join(context.projectRoot, 'docs'), { recursive: true })
    writeFileSync(join(context.projectRoot, 'docs', 'a.md'), '# 标题\n第一行说明\n第二行说明\n')
    writeFileSync(join(context.projectRoot, 'docs', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]))

    const text = await context.service.previewFile(project.id, 'docs/a.md')
    expect(text.kind).toBe('text')
    expect(text.lines[0]).toBe('# 标题')
    expect(text.lines.length).toBeLessThanOrEqual(3)

    const binary = await context.service.previewFile(project.id, 'docs/blob.bin')
    expect(binary.kind).toBe('unavailable')
    expect(binary.reason).toBeTruthy()
  })

  it('returns an image data URL for small images and refuses traversal', async () => {
    const project = addProject(context)
    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    writeFileSync(join(context.projectRoot, 'tiny.png'), png)
    const image = await context.service.previewFile(project.id, 'tiny.png')
    expect(image.kind).toBe('image')
    expect(image.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)

    const traversal = await captureAppErrorAsync(
      context.service.previewFile(project.id, '../outside.png')
    )
    expect(['PATH_INVALID', 'PATH_OUTSIDE_PROJECT']).toContain(traversal.code)
  })

  it('reports directories as unavailable instead of throwing', async () => {
    const project = addProject(context)
    mkdirSync(join(context.projectRoot, 'assets'), { recursive: true })
    const preview = await context.service.previewFile(project.id, 'assets')
    expect(preview.kind).toBe('unavailable')
    expect(preview.reason).toBeTruthy()
  })
})

describe('software text scan scope (2.1.1 noise control)', () => {
  interface NoiseFixture {
    rootPath: string
    entryPath: string
    projectId: number
  }

  async function makeNoisySoftware(): Promise<NoiseFixture> {
    const rootPath = join(context.workspace, 'NoisyApp')
    mkdirSync(join(rootPath, 'configs'), { recursive: true })
    mkdirSync(join(rootPath, 'bundle', 'assets'), { recursive: true })
    mkdirSync(join(rootPath, 'logs'), { recursive: true })
    mkdirSync(join(rootPath, 'node_modules', 'pkg'), { recursive: true })
    const entryPath = join(rootPath, 'NoisyApp.exe')
    writeFileSync(entryPath, Buffer.from('MZ-pathkeeper-test-payload'))

    // A real config problem: relative reference to a missing file.
    writeFileSync(
      join(rootPath, 'configs', 'settings.json'),
      JSON.stringify(
        {
          input_file: 'assets/missing-input.png',
          cache_file: 'logs/runtime.log',
          module_path: 'node_modules/pkg/index.js',
          output_file: 'bundle/assets/present.png'
        },
        null,
        2
      )
    )
    mkdirSync(join(rootPath, 'bundle', 'assets'), { recursive: true })
    writeFileSync(join(rootPath, 'bundle', 'assets', 'present.png'), Buffer.from('png'))
    // Bundled script + log noise that must not be content-scanned by default.
    writeFileSync(
      join(rootPath, 'bundle', 'render.js'),
      'const asset = "../assets/never-shipped.png";\nconst other = "./also-missing.webp";\n'
    )
    writeFileSync(join(rootPath, 'logs', 'app.log'), 'opened ../assets/missing-in-log.png\n')
    writeFileSync(join(rootPath, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const project = await context.service.addSoftwareProject({ rootPath, entryPath })
    return { rootPath, entryPath, projectId: project.id }
  }

  it('defaults to config-only: scripts and logs are not reported, ignored targets are skipped', async () => {
    const fixture = await makeNoisySoftware()
    const result = await context.service.scanSoftware({
      projectId: fixture.projectId,
      includeBinary: false
    })
    expect(result.textScanScope).toBe('config')
    expect(result.textReport).not.toBeNull()
    const issuePaths = result.textReport?.issues.map((issue) => issue.path) ?? []
    // The plain config problem is reported once.
    expect(issuePaths).toContain('assets/missing-input.png')
    // Runtime/bundled sources are not content-scanned in config scope.
    expect(issuePaths.some((path) => path.includes('never-shipped'))).toBe(false)
    expect(issuePaths.some((path) => path.includes('missing-in-log'))).toBe(false)
    // References into ignored folders (node_modules / logs) are skipped and counted.
    expect(issuePaths.includes('node_modules/pkg/index.js')).toBe(false)
    expect(issuePaths.includes('logs/runtime.log')).toBe(false)
    expect(result.textIssuesSkipped).toBeGreaterThanOrEqual(2)
  })

  it('all scope content-scans scripts too, for power users', async () => {
    const fixture = await makeNoisySoftware()
    const scoped = await context.service.scanSoftware({
      projectId: fixture.projectId,
      includeBinary: false,
      textScan: 'all'
    })
    expect(scoped.textScanScope).toBe('all')
    const issuePaths = scoped.textReport?.issues.map((issue) => issue.path) ?? []
    expect(issuePaths.some((path) => path.includes('never-shipped'))).toBe(true)
  })

  it('off scope skips the text report with an honest warning', async () => {
    const fixture = await makeNoisySoftware()
    const result = await context.service.scanSoftware({
      projectId: fixture.projectId,
      includeBinary: false,
      textScan: 'off'
    })
    expect(result.textScanScope).toBe('off')
    expect(result.textReport).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('不检查'))).toBe(true)
  })
})
