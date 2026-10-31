/**
 * Large-file safety tests for PathKeeper 2.1.
 *
 * P0 requirements (plan B3 / section 六):
 *  - a 1 GB binary file is never read in full (no OOM, no multi-second stall);
 *  - a 20 MB text file is streamed and its occurrences are still reported;
 *  - streamed files produce no snapshot, so the backend apply step skips them;
 *  - the global read budget stops a scan early with a visible warning;
 *  - a running scan honours AbortSignal (the "停止扫描" button);
 *  - files above 64 MB get the stronger report-only warning.
 */

import { open } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { scanProject } from '../../src/main/core'
import {
  cleanupTempProjects,
  createTempProject,
  makeScanOptions,
  runScan,
  type TempProject
} from './helpers'

afterEach(cleanupTempProjects)

/** Default ceiling: 1 GiB, expressed in KB like the settings value. */
const ONE_GB_KB = 1_048_576
const ONE_GIB_BYTES = 1_073_741_824

async function createSparseFile(absolutePath: string, sizeBytes: number): Promise<void> {
  const handle = await open(absolutePath, 'w')
  try {
    await handle.truncate(sizeBytes)
  } finally {
    await handle.close()
  }
}

/** Build a >16 MB UTF-8 text file with one target path on a known line. */
function buildLargeText(targetLineIndex: number): string {
  const lines: string[] = []
  for (let index = 0; index < targetLineIndex; index += 1) {
    lines.push(`line ${index} ${'x'.repeat(200)}`)
  }
  lines.push('prefix assets/old.png suffix')
  for (let index = targetLineIndex + 1; index < targetLineIndex + 2000; index += 1) {
    lines.push(`line ${index} ${'x'.repeat(200)}`)
  }
  return `${lines.join('\n')}\n`
}

async function writeLargeUtf8File(project: TempProject, relativePath: string): Promise<number> {
  const content = buildLargeText(123_456)
  const absolute = await project.write(relativePath, content)
  return Buffer.byteLength(content)
}

/** Build a >64 MB file by streaming ~1 MB chunks (avoids a giant JS string). */
async function writeVeryLargeFile(project: TempProject, relativePath: string): Promise<number> {
  const absolute = project.absolute(relativePath)
  const handle = await open(absolute, 'w')
  const filler = Buffer.from(`${'x'.repeat(1000)}\n`.repeat(1024))
  let bytes = 0
  try {
    const target = Buffer.from('assets/old.png\n')
    await handle.write(target)
    bytes += target.length
    for (let index = 0; index < 66; index += 1) {
      await handle.write(filler)
      bytes += filler.length
    }
  } finally {
    await handle.close()
  }
  return bytes
}

describe('large files — binary head sniff', () => {
  it('does not read a 1 GB binary file in full and never snapshots it', async () => {
    const project = await createTempProject()
    // `.dat` is not in the built-in ignore list (unlike `.bin`/`.exe`), so the
    // file really reaches the scanner's head sniff.
    await createSparseFile(project.absolute('huge.dat'), ONE_GIB_BYTES)

    const startedAt = Date.now()
    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: ONE_GB_KB
    })
    const elapsed = Date.now() - startedAt

    expect(result.skippedFiles).toBe(1)
    expect(result.scannedFiles).toBe(0)
    expect(result.snapshots).toHaveLength(0)
    expect(result.items).toHaveLength(0)
    expect(result.budgetStopped).toBe(false)
    expect(result.warnings.join('\n')).toContain('二进制')
    // Reading the whole file would take much longer and/or exhaust the default
    // budget; only the 8 KB head should be touched.
    expect(elapsed).toBeLessThan(10_000)
  })

  it('detects binary content that only starts after the sniff window', async () => {
    const project = await createTempProject()
    const textPart = Buffer.from(`assets/old.png\n${'a'.repeat(1024 * 1024)}`)
    await project.write(
      'late-binary.txt',
      Buffer.concat([textPart, Buffer.alloc(20 * 1024 * 1024, 0)])
    )

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: ONE_GB_KB
    })

    expect(result.skippedFiles).toBe(1)
    expect(result.scannedFiles).toBe(0)
    expect(result.snapshots).toHaveLength(0)
    expect(result.items).toHaveLength(0)
    expect(result.warnings.join('\n')).toContain('二进制')
  })
})

describe('large files — streaming text scan', () => {
  it('streams a 20 MB text file, reports occurrences and produces no snapshot', async () => {
    const project = await createTempProject()
    const sizeBytes = await writeLargeUtf8File(project, 'huge.txt')
    expect(sizeBytes).toBeGreaterThan(16 * 1024 * 1024)

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: ONE_GB_KB
    })

    expect(result.scannedFiles).toBe(1)
    expect(result.skippedFiles).toBe(0)
    expect(result.snapshots).toHaveLength(0)
    const items = result.items.filter((item) => item.filePath === 'huge.txt')
    expect(items).toHaveLength(1)
    const item = items[0]
    if (!item) throw new Error('missing streamed occurrence')
    expect(item.line).toBe(123_457)
    expect(item.oldText).toBe('assets/old.png')
    expect(item.newText).toBe('media/new.png')
    expect(item.context).toContain('assets/old.png')

    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('超过 16 MB')
    expect(warnings).toContain('仅报告')
    expect(warnings).toContain('不提供直接修复')
    expect(warnings).not.toContain('超过 64 MB')
  })

  it('streams UTF-16 LE text in an encoding-aware way', async () => {
    const project = await createTempProject()
    const lines = ['assets/old.png']
    for (let index = 0; index < 140_000; index += 1) {
      lines.push(`line ${index} ${'x'.repeat(80)}`)
    }
    const text = `${lines.join('\r\n')}\r\n`
    const body = Buffer.from(text, 'utf16le')
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), body])
    expect(buffer.length).toBeGreaterThan(16 * 1024 * 1024)
    await project.write('utf16-large.txt', buffer)

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: ONE_GB_KB
    })

    expect(result.scannedFiles).toBe(1)
    expect(result.snapshots).toHaveLength(0)
    const item = result.items.find((entry) => entry.filePath === 'utf16-large.txt')
    expect(item).toBeDefined()
    expect(item?.line).toBe(1)
    expect(item?.newText).toBe('media/new.png')
  })

  it('reports files above 64 MB with the stronger report-only warning', async () => {
    const project = await createTempProject()
    const sizeBytes = await writeVeryLargeFile(project, 'very-large.txt')
    expect(sizeBytes).toBeGreaterThan(64 * 1024 * 1024)

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: ONE_GB_KB
    })

    expect(result.scannedFiles).toBe(1)
    expect(result.snapshots).toHaveLength(0)
    const item = result.items.find((entry) => entry.filePath === 'very-large.txt')
    expect(item).toBeDefined()
    expect(item?.line).toBe(1)

    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('超过 64 MB')
    expect(warnings).toContain('仅报告')
    expect(warnings).toContain('不提供直接修复')
  })

  it('skips large files when maxFileSizeKb is lower than their size', async () => {
    const project = await createTempProject()
    await writeLargeUtf8File(project, 'huge.txt')

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: 4096
    })

    expect(result.skippedFiles).toBe(1)
    expect(result.scannedFiles).toBe(0)
    expect(result.snapshots).toHaveLength(0)
    expect(result.warnings.join('\n')).toContain('大小限制')
  })
})

describe('large files — global budget and cancellation', () => {
  it('stops early when the global read budget is exhausted', async () => {
    const project = await createTempProject()
    const padding = 'x'.repeat(512 * 1024)
    for (let index = 0; index < 6; index += 1) {
      await project.write(`docs/file-${index}.txt`, `assets/old.png\n${padding}\n`)
    }

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      maxFileSizeKb: ONE_GB_KB,
      budget: { maxBytes: 1_200_000, maxDurationMs: 60_000 }
    })

    expect(result.budgetStopped).toBe(true)
    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('因扫描预算停止')
    expect(warnings).toMatch(/已扫描 \d+ 个文件/)
    expect(result.snapshots.length).toBeLessThan(6)
  })

  it('stops as soon as the first head read exceeds the budget', async () => {
    const project = await createTempProject()
    await project.write('a.txt', `assets/old.png\n${'x'.repeat(20 * 1024)}`)
    await project.write('b.txt', `assets/old.png\n${'x'.repeat(20 * 1024)}`)

    const result = await runScan(project, {
      oldPath: 'assets/old.png',
      newPath: 'media/new.png',
      kind: 'file',
      budget: { maxBytes: 100, maxDurationMs: 60_000 }
    })

    expect(result.budgetStopped).toBe(true)
    expect(result.warnings.join('\n')).toContain('因扫描预算停止')
  })

  it('rejects with an AbortError when cancelled during scanning', async () => {
    const project = await createTempProject()
    await writeLargeUtf8File(project, 'huge.txt')
    const controller = new AbortController()

    const promise = scanProject(
      makeScanOptions(project, {
        oldPath: 'assets/old.png',
        newPath: 'media/new.png',
        kind: 'file',
        maxFileSizeKb: ONE_GB_KB,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'scanning') controller.abort()
        }
      })
    )

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
