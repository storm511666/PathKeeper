import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathKeeperService } from '../../src/main/services/pathkeeper-service'
import type { TestContext } from './helpers'
import {
  NEW_PATH,
  OLD_PATH,
  addProject,
  applyAll,
  backupRootPath,
  captureAppErrorAsync,
  createTestContext,
  destroyTestContext,
  normalizePath,
  readProjectFile,
  readProjectFileBuffer,
  scanFixture,
  writeProjectFile
} from './helpers'

let context: TestContext

const ORIGINAL = `Move ${OLD_PATH} into place.\n`

beforeEach(async () => {
  context = await createTestContext()
})

afterEach(() => {
  destroyTestContext(context)
})

async function scanOneFile() {
  writeProjectFile(context, 'notes/readme.txt', ORIGINAL)
  const project = addProject(context)
  const scan = await scanFixture(context, project)
  expect(scan.items.length).toBeGreaterThan(0)
  return { project, scan }
}

describe('apply success', () => {
  it('writes only matched spans, creates a backup + manifest and records history', async () => {
    const { project, scan } = await scanOneFile()
    const applied = await context.service.apply({
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })

    expect(applied.filesChanged).toBe(1)
    expect(applied.replacements).toBeGreaterThan(0)
    expect(applied.skipped).toHaveLength(0)
    expect(applied.backupId).toBeGreaterThan(0)

    const content = readProjectFile(context, 'notes/readme.txt')
    expect(content).not.toContain(OLD_PATH)
    expect(content).toContain('assets/new')
    expect(content).toContain('into place.')

    expect(existsSync(applied.backupDir)).toBe(true)
    expect(existsSync(join(applied.backupDir, 'manifest.json'))).toBe(true)
    const backupFile = join(applied.backupDir, 'files', 'notes', 'readme.txt')
    expect(existsSync(backupFile)).toBe(true)
    expect(readFileSync(backupFile, 'utf8')).toBe(ORIGINAL)

    const manifest = JSON.parse(readFileSync(join(applied.backupDir, 'manifest.json'), 'utf8')) as {
      format: string
      version: number
      migrationId: number
      files: Array<{ path: string; hash: string }>
    }
    expect(manifest.format).toBe('pathkeeper-backup')
    expect(manifest.version).toBe(1)
    expect(manifest.migrationId).toBe(applied.migrationId)
    expect(manifest.files).toHaveLength(1)
    expect(manifest.files[0]?.path).toBe('notes/readme.txt')
    expect(manifest.files[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

    const history = context.service.listHistory(project.id)
    expect(history).toHaveLength(1)
    const record = history[0]
    expect(record).toBeDefined()
    if (!record) return
    expect(record.status).toBe('applied')
    expect(record.filesChanged).toBe(1)
    expect(record.replacements).toBe(applied.replacements)
    expect(record.backupId).toBe(applied.backupId)
    expect(record.backupRemoved).toBe(false)
    expect(record.backupMissing).toBe(false)
    expect(record.oldPath).toBe(OLD_PATH)
    expect(record.newPath).toBe(NEW_PATH)
    expect(record.files[0]?.filePath).toBe('notes/readme.txt')
    expect(record.files[0]?.preHash).toMatch(/^[0-9a-f]{64}$/)
    expect(record.files[0]?.postHash).toMatch(/^[0-9a-f]{64}$/)
    expect(record.files[0]?.postHash).not.toBe(record.files[0]?.preHash)

    const backups = context.service.listBackups(project.id)
    expect(backups).toHaveLength(1)
    expect(backups[0]?.missing).toBe(false)
    expect(backups[0]?.orphaned).toBe(false)
    expect(backups[0]?.filesCount).toBe(1)

    // A used scan token must not be reusable for a second apply.
    const reuse = await captureAppErrorAsync(
      context.service.apply({
        scanToken: scan.scanToken,
        occurrenceIds: scan.items.map((item) => item.id)
      })
    )
    expect(reuse.code).toBe('SCAN_EXPIRED')
  })

  it('aborts the whole apply with SCAN_STALE when any selected file changed after scanning', async () => {
    const { project, scan } = await scanOneFile()
    const changedContent = `user edited this after scanning: ${OLD_PATH}\n`
    writeProjectFile(context, 'notes/readme.txt', changedContent)

    const error = await captureAppErrorAsync(
      context.service.apply({
        scanToken: scan.scanToken,
        occurrenceIds: scan.items.map((item) => item.id)
      })
    )
    expect(error.code).toBe('SCAN_STALE')
    const files = (error.details as { files?: Array<{ filePath: string; reason: string }> }).files
    expect(files?.[0]?.filePath).toBe('notes/readme.txt')
    expect(files?.[0]?.reason).toBe('changed')

    // Nothing was written, no backup and no history row.
    expect(readProjectFile(context, 'notes/readme.txt')).toBe(changedContent)
    expect(context.service.listHistory(project.id)).toHaveLength(0)
    expect(existsSync(backupRootPath(context))).toBe(false)
  })

  it('aborts every selected file when only one of them is stale', async () => {
    writeProjectFile(context, 'notes/readme.txt', ORIGINAL)
    const docsContent = `Guide still points at ${OLD_PATH}\n`
    writeProjectFile(context, 'docs/guide.md', docsContent)
    const project = addProject(context)
    const scan = await scanFixture(context, project)
    expect(scan.items.length).toBeGreaterThan(0)

    const staleContent = 'edited between scan and apply\n'
    writeProjectFile(context, 'notes/readme.txt', staleContent)

    const error = await captureAppErrorAsync(
      context.service.apply({
        scanToken: scan.scanToken,
        occurrenceIds: scan.items.map((item) => item.id)
      })
    )
    expect(error.code).toBe('SCAN_STALE')
    // No file was written, including the untouched one.
    expect(readProjectFile(context, 'notes/readme.txt')).toBe(staleContent)
    expect(readProjectFile(context, 'docs/guide.md')).toBe(docsContent)
    expect(context.service.listHistory(project.id)).toHaveLength(0)
  })

  it('only modifies files that have selected rows and backs up only those files', async () => {
    writeProjectFile(context, 'notes/readme.txt', ORIGINAL)
    const untouched = `Guide still points at ${OLD_PATH}\n`
    writeProjectFile(context, 'docs/guide.md', untouched)
    const project = addProject(context)
    const scan = await scanFixture(context, project)

    const selected = scan.items.filter(
      (item) => normalizePath(item.filePath) === 'notes/readme.txt'
    )
    expect(selected.length).toBeGreaterThan(0)

    const applied = await context.service.apply({
      scanToken: scan.scanToken,
      occurrenceIds: selected.map((item) => item.id)
    })
    expect(applied.filesChanged).toBe(1)

    expect(readProjectFile(context, 'notes/readme.txt')).not.toContain(OLD_PATH)
    expect(readProjectFile(context, 'docs/guide.md')).toBe(untouched)
    expect(existsSync(join(applied.backupDir, 'files', 'notes', 'readme.txt'))).toBe(true)
    expect(existsSync(join(applied.backupDir, 'files', 'docs', 'guide.md'))).toBe(false)

    const history = context.service.listHistory(project.id)
    expect(history[0]?.files).toHaveLength(1)
    expect(history[0]?.files[0]?.filePath).toBe('notes/readme.txt')
  })

  it('preserves UTF-8 BOM and UTF-16 LE/BE encodings including their BOM bytes', async () => {
    const text = `Move ${OLD_PATH} now.\n`
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const swapped = Buffer.from(text, 'utf16le')
    swapped.swap16()
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), swapped])

    writeProjectFile(context, 'encoding/utf8-bom.txt', utf8Bom)
    writeProjectFile(context, 'encoding/utf16le.txt', utf16le)
    writeProjectFile(context, 'encoding/utf16be.txt', utf16be)
    const project = addProject(context)
    const scan = await scanFixture(context, project)

    const scannedFiles = new Set(scan.items.map((item) => normalizePath(item.filePath)))
    expect(scannedFiles).toContain('encoding/utf8-bom.txt')
    expect(scannedFiles).toContain('encoding/utf16le.txt')
    expect(scannedFiles).toContain('encoding/utf16be.txt')

    await context.service.apply({
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })

    const afterUtf8Bom = readProjectFileBuffer(context, 'encoding/utf8-bom.txt')
    expect([...afterUtf8Bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(afterUtf8Bom.subarray(3).toString('utf8')).not.toContain(OLD_PATH)
    expect(afterUtf8Bom.subarray(3).toString('utf8')).toContain('assets/new')

    const afterUtf16le = readProjectFileBuffer(context, 'encoding/utf16le.txt')
    expect([...afterUtf16le.subarray(0, 2)]).toEqual([0xff, 0xfe])
    expect(afterUtf16le.subarray(2).toString('utf16le')).not.toContain(OLD_PATH)
    expect(afterUtf16le.subarray(2).toString('utf16le')).toContain('assets/new')

    const afterUtf16be = readProjectFileBuffer(context, 'encoding/utf16be.txt')
    expect([...afterUtf16be.subarray(0, 2)]).toEqual([0xfe, 0xff])
    const beBody = Buffer.from(afterUtf16be.subarray(2))
    beBody.swap16()
    expect(beBody.toString('utf16le')).not.toContain(OLD_PATH)
    expect(beBody.toString('utf16le')).toContain('assets/new')
  })

  it('validates selections and keeps the token usable after a failed apply', async () => {
    const { scan } = await scanOneFile()

    const empty = await captureAppErrorAsync(
      context.service.apply({ scanToken: scan.scanToken, occurrenceIds: [] })
    )
    expect(empty.code).toBe('SCAN_EMPTY_SELECTION')

    const unknownId = await captureAppErrorAsync(
      context.service.apply({ scanToken: scan.scanToken, occurrenceIds: ['not-a-real-id'] })
    )
    expect(unknownId.code).toBe('SCAN_SELECTION_INVALID')

    const badToken = await captureAppErrorAsync(
      context.service.apply({ scanToken: 'missing-token', occurrenceIds: ['x'] })
    )
    expect(badToken.code).toBe('SCAN_EXPIRED')

    // The failed attempts did not consume the scan session.
    const applied = await context.service.apply({
      scanToken: scan.scanToken,
      occurrenceIds: scan.items.map((item) => item.id)
    })
    expect(applied.filesChanged).toBe(1)
  })
})

describe('rollback', () => {
  it('restores original bytes and marks the migration rolled_back', async () => {
    const { project } = await scanOneFile()
    const { result } = await applyAll(context, project)
    expect(readProjectFile(context, 'notes/readme.txt')).not.toBe(ORIGINAL)

    const rollback = await context.service.rollback(result.migrationId)
    expect(rollback.migrationId).toBe(result.migrationId)
    expect(rollback.filesRestored).toBe(1)
    expect(rollback.backupDir).toBe(result.backupDir)
    expect(readProjectFile(context, 'notes/readme.txt')).toBe(ORIGINAL)

    const record = context.service.listHistory(project.id)[0]
    expect(record?.status).toBe('rolled_back')
    expect(record?.rolledBackAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const again = await captureAppErrorAsync(context.service.rollback(result.migrationId))
    expect(again.code).toBe('ROLLBACK_NOT_ALLOWED')
  })

  it('refuses to roll back when a file changed after applying', async () => {
    const { project } = await scanOneFile()
    const { result } = await applyAll(context, project)
    const manualEdit = 'manual edit after apply\n'
    writeProjectFile(context, 'notes/readme.txt', manualEdit)

    const error = await captureAppErrorAsync(context.service.rollback(result.migrationId))
    expect(error.code).toBe('ROLLBACK_CONFLICT')
    const files = (error.details as { files?: Array<{ reason: string }> }).files
    expect(files?.[0]?.reason).toBe('文件在迁移后又被修改')
    expect(readProjectFile(context, 'notes/readme.txt')).toBe(manualEdit)
    expect(context.service.listHistory(project.id)[0]?.status).toBe('applied')
  })

  it('restores no file at all when one file of a multi-file migration conflicts', async () => {
    writeProjectFile(context, 'notes/readme.txt', ORIGINAL)
    writeProjectFile(context, 'docs/guide.md', `Guide ${OLD_PATH}\n`)
    const project = addProject(context)
    const applied = await applyAll(context, project)
    expect(applied.result.filesChanged).toBeGreaterThanOrEqual(2)

    // The second file changes after apply; rollback must not restore the first.
    writeProjectFile(context, 'docs/guide.md', 'conflicting manual edit\n')
    const migratedNotes = readProjectFile(context, 'notes/readme.txt')
    expect(migratedNotes).not.toContain(OLD_PATH)

    const error = await captureAppErrorAsync(context.service.rollback(applied.result.migrationId))
    expect(error.code).toBe('ROLLBACK_CONFLICT')
    expect(readProjectFile(context, 'notes/readme.txt')).toBe(migratedNotes)
    expect(readProjectFile(context, 'docs/guide.md')).toBe('conflicting manual edit\n')
    expect(context.service.listHistory(project.id)[0]?.status).toBe('applied')
  })
})

describe('backup and history management', () => {
  it('deletes a backup from disk, keeps history and blocks rollback afterwards', async () => {
    const { project } = await scanOneFile()
    const { result } = await applyAll(context, project)
    expect(context.service.listBackups(project.id)).toHaveLength(1)

    context.service.removeBackup(result.backupId)
    expect(existsSync(result.backupDir)).toBe(false)
    expect(context.service.listBackups(project.id)).toHaveLength(0)

    const record = context.service.listHistory(project.id)[0]
    expect(record?.backupRemoved).toBe(true)
    expect(record?.backupMissing).toBe(true)
    expect(record?.status).toBe('applied')

    const rollback = await captureAppErrorAsync(context.service.rollback(result.migrationId))
    expect(rollback.code).toBe('BACKUP_MISSING')
  })

  it('keeps an orphaned backup manageable after history deletion', async () => {
    const { project } = await scanOneFile()
    const { result } = await applyAll(context, project)

    context.service.removeHistory(result.migrationId)
    expect(context.service.listHistory(project.id)).toHaveLength(0)
    expect(existsSync(result.backupDir)).toBe(true)

    const backups = context.service.listBackups(project.id)
    expect(backups).toHaveLength(1)
    expect(backups[0]?.orphaned).toBe(true)
    expect(backups[0]?.missing).toBe(false)

    const orphan = context.service.getBackupRecord(result.backupId)
    expect(orphan.orphaned).toBe(true)
    expect(existsSync(orphan.absPath)).toBe(true)

    context.service.removeBackup(result.backupId)
    expect(context.service.listBackups(project.id)).toHaveLength(0)
    expect(existsSync(result.backupDir)).toBe(false)

    const rollback = await captureAppErrorAsync(context.service.rollback(result.migrationId))
    expect(rollback.code).toBe('MIGRATION_NOT_FOUND')
  })

  it('persists history and backups across a service restart so rollback still works', async () => {
    const { project } = await scanOneFile()
    const { result } = await applyAll(context, project)

    context.service.close()
    const reopened = new PathKeeperService(join(context.workspace, 'user-data'))
    await reopened.init()
    try {
      const projects = reopened.listProjects()
      expect(projects).toHaveLength(1)
      expect(projects[0]?.id).toBe(project.id)
      const history = reopened.listHistory(project.id)
      expect(history).toHaveLength(1)
      expect(history[0]?.status).toBe('applied')
      expect(reopened.listBackups(project.id)).toHaveLength(1)

      const rollback = await reopened.rollback(result.migrationId)
      expect(rollback.filesRestored).toBe(1)
      expect(readProjectFile(context, 'notes/readme.txt')).toBe(ORIGINAL)
    } finally {
      reopened.close()
    }
  })

  it('rejects unknown history and backup ids', () => {
    addProject(context)
    expect(captureAppErrorSync(() => context.service.removeHistory(4242)).code).toBe(
      'MIGRATION_NOT_FOUND'
    )
    expect(captureAppErrorSync(() => context.service.removeBackup(4242)).code).toBe(
      'BACKUP_NOT_FOUND'
    )
    expect(captureAppErrorSync(() => context.service.getBackupRecord(4242)).code).toBe(
      'BACKUP_NOT_FOUND'
    )
  })
})

function captureAppErrorSync(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      return error as Error & { code: string }
    }
    throw error
  }
  throw new Error('预期的 AppError 没有被抛出。')
}
