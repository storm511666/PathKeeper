import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PathKeeperService } from '../../src/main/services/pathkeeper-service'

const DEMO = join(process.cwd(), 'examples', 'demo-project')
const OLD_PATH = 'assets/textures/old_brick_wall.png'
const NEW_PATH = 'assets/materials/brick_wall.png'
const tempRoot = mkdtempSync(join(tmpdir(), 'pathkeeper-demo-probe-'))
const projectDir = join(tempRoot, 'demo-project')
cpSync(DEMO, projectDir, { recursive: true })
const service = new PathKeeperService(join(tempRoot, 'profile'))

afterAll(() => {
  service.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('demo project backend probe (mirrors e2e expectations)', () => {
  it('scans, applies and rolls back the real demo fixture', async () => {
    await service.init()
    const project = service.addProjectFromPath(projectDir)

    const scan = await service.scan({
      projectId: project.id,
      oldPath: OLD_PATH,
      newPath: NEW_PATH,
      kind: 'file'
    })
    console.log('[probe] file scan matches:', scan.items.length, 'files:', new Set(scan.items.map((i) => i.filePath)).size)
    expect(scan.items.length).toBeGreaterThanOrEqual(6)
    expect(scan.items.some((item) => item.filePath === 'configs/pipeline.json')).toBe(true)

    const applied = await service.apply({
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })
    console.log('[probe] applied:', JSON.stringify({ filesChanged: applied.filesChanged, replacements: applied.replacements, backupDir: applied.backupDir }))
    expect(applied.filesChanged).toBeGreaterThan(0)

    const preprocess = readFileSync(join(projectDir, 'scripts', 'preprocess.py'), 'utf8')
    expect(preprocess).not.toContain(OLD_PATH)
    expect(preprocess).toContain(NEW_PATH)
    const readme = readFileSync(join(projectDir, 'README.md'), 'utf8')
    expect(readme).not.toContain(OLD_PATH)
    expect(readme).toContain(NEW_PATH)
    expect(readFileSync(join(projectDir, 'notes', 'field-notes.txt'), 'utf8')).toContain(NEW_PATH)
    expect(
      readFileSync(join(projectDir, 'node_modules', 'demo-dependency', 'README.md'), 'utf8')
    ).toContain(OLD_PATH)
    expect(readFileSync(join(projectDir, 'dist', 'bundle.js'), 'utf8')).toContain(OLD_PATH)

    const backupRoot = join(projectDir, '.pathkeeper-backup')
    expect(existsSync(backupRoot)).toBe(true)
    const backupIds = readdirSync(backupRoot)
    expect(backupIds.length).toBeGreaterThanOrEqual(1)
    const manifest = JSON.parse(
      readFileSync(join(backupRoot, backupIds[0] ?? '', 'manifest.json'), 'utf8')
    ) as { files: unknown[] }
    console.log('[probe] manifest files:', manifest.files.length)
    expect(manifest.files.length).toBeGreaterThan(0)

    const rollback = await service.rollback(applied.migrationId)
    expect(rollback.filesRestored).toBeGreaterThan(0)
    expect(readFileSync(join(projectDir, 'scripts', 'preprocess.py'), 'utf8')).toContain(
      'old_brick_wall.png'
    )

    const directoryScan = await service.scan({
      projectId: project.id,
      oldPath: 'datasets/raw',
      newPath: 'datasets/processed',
      kind: 'directory'
    })
    console.log('[probe] dir scan matches:', directoryScan.items.length, 'kind:', directoryScan.pathInfo.kind)
    expect(directoryScan.pathInfo.kind).toBe('directory')
    expect(directoryScan.items.length).toBeGreaterThanOrEqual(1)
    expect(directoryScan.items.some((item) => item.filePath === 'configs/dataset.json')).toBe(true)
  })
})
