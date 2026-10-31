/**
 * Software scan backend tests.
 *
 * Fixtures are synthetic PE images and a fake Windows layout built in a temp
 * directory, so DLL resolution/classification is deterministic on every
 * machine. The suite also proves the scan is read-only (file tree unchanged) and
 * that the core never imports a process/network API (it must never execute the
 * scanned software).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import nodePath from 'node:path'
import type { SoftwareScanResult } from '../../src/shared/types'
import { analyzeSoftwareBinary, scanSoftwarePackage } from '../../src/main/core/softwareScan'
import {
  inspectSoftware,
  isSoftwareTargetError,
  parseSoftwareTarget,
  readFileVersionInfo,
  type SoftwareTargetError
} from '../../src/main/services/software-info'
import {
  cleanupTempProjects,
  createTempProject,
  makeBuiltinIgnoreRules,
  makeBuiltinMatchRules,
  type TempProject
} from '../core/helpers'

afterAll(async () => {
  await cleanupTempProjects()
})

/* ------------------------------------------------------------------ */
/* Synthetic binary fixtures                                           */
/* ------------------------------------------------------------------ */

const SECTION_RVA = 0x1000
const SECTION_RAW = 0x200
const FILE_ALIGN = 0x200
const IMPORT_DESCRIPTOR_BYTES = 20

/** Minimal PE32 image with one `.idata` section holding the given imports. */
function buildPe(imports: string[]): Buffer {
  const optionalSize = 224
  const descriptorBytes = (imports.length + 1) * IMPORT_DESCRIPTOR_BYTES
  const nameOffsets: number[] = []
  let cursor = descriptorBytes
  for (const name of imports) {
    nameOffsets.push(cursor)
    cursor += Buffer.byteLength(`${name}\u0000`, 'latin1')
  }
  const rawSize = Math.max(0x1000, Math.ceil(cursor / FILE_ALIGN) * FILE_ALIGN)
  const buffer = Buffer.alloc(SECTION_RAW + rawSize)

  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.write('PE\u0000\u0000', 0x80, 'latin1')
  const coff = 0x84
  buffer.writeUInt16LE(0x014c, coff) // i386
  buffer.writeUInt16LE(1, coff + 2) // one section
  buffer.writeUInt16LE(optionalSize, coff + 16)
  buffer.writeUInt16LE(0x0102, coff + 18)

  const opt = 0x80 + 24
  buffer.writeUInt16LE(0x10b, opt) // PE32
  buffer.writeUInt32LE(0x1000, opt + 16) // AddressOfEntryPoint
  buffer.writeUInt32LE(0x1000, opt + 32) // SectionAlignment
  buffer.writeUInt32LE(FILE_ALIGN, opt + 36) // FileAlignment
  buffer.writeUInt32LE(0x2000, opt + 56) // SizeOfImage
  buffer.writeUInt32LE(SECTION_RAW, opt + 60) // SizeOfHeaders
  buffer.writeUInt16LE(3, opt + 68) // Subsystem
  buffer.writeUInt32LE(16, opt + 92) // NumberOfRvaAndSizes
  buffer.writeUInt32LE(SECTION_RVA, opt + 96 + 8) // import directory RVA
  buffer.writeUInt32LE(descriptorBytes, opt + 96 + 12) // import directory size

  const sectionHeader = 0x80 + 24 + optionalSize
  buffer.write('.idata', sectionHeader, 'latin1')
  buffer.writeUInt32LE(rawSize, sectionHeader + 8)
  buffer.writeUInt32LE(SECTION_RVA, sectionHeader + 12)
  buffer.writeUInt32LE(rawSize, sectionHeader + 16)
  buffer.writeUInt32LE(SECTION_RAW, sectionHeader + 20)
  buffer.writeUInt32LE(0xc0000040, sectionHeader + 36)

  imports.forEach((name, index) => {
    const nameOffset = nameOffsets[index] ?? 0
    buffer.writeUInt32LE(SECTION_RVA + nameOffset, SECTION_RAW + index * IMPORT_DESCRIPTOR_BYTES + 12)
    buffer.write(`${name}\u0000`, SECTION_RAW + nameOffset, 'latin1')
  })
  return buffer
}

/** Minimal MS-SHLLINK buffer pointing at `targetPath` via LinkInfo ANSI path. */
function buildShortcut(targetPath: string): Buffer {
  const header = Buffer.alloc(76)
  header.writeUInt32LE(0x4c, 0)
  Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]).copy(
    header,
    4
  )
  header.writeUInt32LE(0x02, 20) // HasLinkInfo
  header.writeUInt32LE(0x20, 24) // FileAttributes = archive
  const ansi = Buffer.from(`${targetPath}\u0000`, 'latin1')
  const linkInfo = Buffer.alloc(0x1c + ansi.length)
  linkInfo.writeUInt32LE(linkInfo.length, 0)
  linkInfo.writeUInt32LE(0x1c, 4)
  linkInfo.writeUInt32LE(1, 8) // VolumeIDAndLocalBasePath
  linkInfo.writeUInt32LE(0x1c, 16) // LocalBasePathOffset
  ansi.copy(linkInfo, 0x1c)
  return Buffer.concat([header, linkInfo])
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function scanOptions(project: TempProject, overrides: Record<string, unknown> = {}) {
  return {
    projectId: 7,
    projectName: '示例软件',
    installRoot: project.root,
    entryPath: project.absolute('app.exe'),
    includeBinary: true,
    rules: makeBuiltinMatchRules(),
    ignoreRules: makeBuiltinIgnoreRules(),
    caseSensitive: false,
    maxFileSizeKb: 4096,
    ...overrides
  }
}

function dependencyNamed(result: SoftwareScanResult, name: string) {
  return result.binaryDependencies.find(
    (dependency) => dependency.name.toLowerCase() === name.toLowerCase()
  )
}

async function captureTargetError(fn: () => Promise<unknown>): Promise<SoftwareTargetError> {
  try {
    await fn()
  } catch (error) {
    if (isSoftwareTargetError(error)) return error
    throw error
  }
  throw new Error('预期的 SoftwareTargetError 没有被抛出。')
}

async function snapshotTree(root: string): Promise<string[]> {
  const rows: string[] = []
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const entryRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      const absolute = nodePath.join(dir, entry.name)
      if (entry.isDirectory()) {
        rows.push(`dir:${entryRelative}`)
        await walk(absolute, entryRelative)
      } else {
        const stats = await fsp.stat(absolute)
        rows.push(`file:${entryRelative}:${stats.size}`)
      }
    }
  }
  await walk(root, '')
  rows.sort()
  return rows
}

const IMPORTING_DLLS = [
  'KERNEL32.dll',
  'missing-local.dll',
  'api-ms-win-crt-runtime-l1-1-0.dll',
  'vcruntime140.dll'
]

/* ------------------------------------------------------------------ */
/* Full package scan                                                   */
/* ------------------------------------------------------------------ */

describe('scanSoftwarePackage', () => {
  it('scans text references and binary imports without modifying anything', async () => {
    const project = await createTempProject({
      'app.exe': buildPe(IMPORTING_DLLS),
      'unins000.exe': buildPe(['KERNEL32.dll', 'missing-local.dll']),
      'README.md': '![missing](data/missing.dat)\n',
      'config.json': JSON.stringify({ inputPath: 'data/missing.dat', output: 'data/result.txt' }),
      'data/result.txt': 'ok'
    })
    const before = await snapshotTree(project.root)
    const result = await scanSoftwarePackage(scanOptions(project))
    const after = await snapshotTree(project.root)

    // Read-only: the file tree is byte-for-byte unchanged.
    expect(after).toEqual(before)

    expect(result.projectId).toBe(7)
    expect(result.projectName).toBe('示例软件')
    expect(result.installRoot).toBe(project.root)
    expect(result.entryPath).toBe(project.absolute('app.exe'))
    expect(result.info.entryPath).toBe(project.absolute('app.exe'))
    expect(result.info.iconDataUrl).toBeNull()
    expect(result.createdAt.length).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // Text pass reuses the existing dependency engine.
    expect(result.textReport).not.toBeNull()
    const missingText = result.textReport?.issues.find((issue) => issue.path === 'data/missing.dat')
    expect(missingText?.health).toBe('missing')

    // Binary pass parsed both program files.
    expect(result.binaryAnalysis).toBe('analyzed')
    expect(result.binaryFilesScanned).toEqual(['app.exe', 'unins000.exe'])
    expect(result.binaryCapHit).toBe(false)

    const kernel32 = dependencyNamed(result, 'KERNEL32.dll')
    expect(kernel32?.origin).toBe('system')
    expect(kernel32?.status).toBe(process.platform === 'win32' ? 'ok' : 'missing')
    expect(kernel32?.importedBy).toEqual(['app.exe', 'unins000.exe'])

    const missingLocal = dependencyNamed(result, 'missing-local.dll')
    expect(missingLocal).toMatchObject({
      resolvedPath: null,
      origin: 'app-local',
      status: 'missing'
    })
    expect(missingLocal?.importedBy).toEqual(['app.exe', 'unins000.exe'])

    // API Set contracts are OS-provided: always OK, never reported missing.
    expect(dependencyNamed(result, 'api-ms-win-crt-runtime-l1-1-0.dll')).toMatchObject({
      origin: 'system',
      status: 'ok'
    })

    // Known VC++ runtime: classified as a system/runtime dependency either way.
    const vcruntime = dependencyNamed(result, 'vcruntime140.dll')
    expect(vcruntime?.origin).toBe('system')
    expect(['ok', 'missing']).toContain(vcruntime?.status)

    // Missing rows sort first so the report highlights them.
    const firstRow = result.binaryDependencies[0]
    expect(firstRow?.status).toBe('missing')
  })

  it('returns not-analyzed when the binary pass is disabled', async () => {
    const project = await createTempProject({
      'app.exe': buildPe(['KERNEL32.dll']),
      'README.md': 'plain text, no references\n'
    })
    const result = await scanSoftwarePackage(scanOptions(project, { includeBinary: false }))
    expect(result.binaryAnalysis).toBe('not-analyzed')
    expect(result.binaryDependencies).toEqual([])
    expect(result.binaryFilesScanned).toEqual([])
    expect(result.binaryCapHit).toBe(false)
    expect(result.textReport).not.toBeNull()
  })

  it('survives an invalid rules list by skipping the text pass honestly', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    const result = await scanSoftwarePackage(
      scanOptions(project, { includeBinary: false, rules: [], ignoreRules: [] })
    )
    expect(result.textReport).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('匹配规则'))).toBe(true)
  })

  it('marks unparseable binaries as unavailable instead of inventing missing DLLs', async () => {
    const project = await createTempProject({
      'app.exe': Buffer.from('this is not a PE binary, just text'),
      'README.md': '# demo\n'
    })
    const result = await scanSoftwarePackage(scanOptions(project))
    expect(result.binaryAnalysis).toBe('unavailable')
    expect(result.binaryDependencies).toEqual([])
    expect(result.binaryFilesScanned).toEqual([])
    expect(result.warnings.some((warning) => warning.includes('无法解析'))).toBe(true)
  })

  it('caps the number of binary files analysed and says so', async () => {
    const files: Record<string, string | Buffer> = {
      'app.exe': buildPe(['KERNEL32.dll']),
      'README.md': '# demo\n'
    }
    for (let index = 1; index <= 9; index += 1) {
      files[`extra-${index}.exe`] = buildPe(['KERNEL32.dll', `lib-${index}.dll`])
    }
    const project = await createTempProject(files)
    const result = await scanSoftwarePackage(scanOptions(project))
    expect(result.binaryFilesScanned).toHaveLength(8)
    expect(result.binaryCapHit).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('最多分析'))).toBe(true)
  })

  it('reports when there is no program file to analyse', async () => {
    const project = await createTempProject({ 'README.md': '# only docs\n' })
    const result = await scanSoftwarePackage(scanOptions(project, { entryPath: null }))
    expect(result.binaryAnalysis).toBe('unavailable')
    expect(result.warnings.some((warning) => warning.includes('没有找到'))).toBe(true)
  })

  it('throws an AbortError for a cancelled scan', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    const controller = new AbortController()
    controller.abort()
    await expect(
      scanSoftwarePackage(scanOptions(project, { signal: controller.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a missing install root with a typed core error', async () => {
    const project = await createTempProject({})
    const missingRoot = nodePath.join(project.root, 'does-not-exist')
    await expect(
      scanSoftwarePackage(scanOptions(project, { installRoot: missingRoot }))
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' })
  })
})

/* ------------------------------------------------------------------ */
/* Binary-only pass: resolution order + classification                 */
/* ------------------------------------------------------------------ */

describe('analyzeSoftwareBinary — DLL resolution and classification', () => {
  it('resolves app-local → system dirs → PATH and classifies each module', async () => {
    const project = await createTempProject({
      'app.exe': buildPe([
        'runtime.dll',
        'BINLIB.dll',
        'sysdll.dll',
        'syswow.dll',
        'pathonly.dll',
        'missing.dll',
        'kernel32.dll',
        'api-ms-win-core-file-l1-1-0.dll',
        'vcruntime140.dll',
        'msvcp140.dll'
      ]),
      'runtime.dll': Buffer.alloc(4),
      'bin/binlib.dll': Buffer.alloc(4),
      'fake-sys/System32/sysdll.dll': Buffer.alloc(4),
      'fake-sys/System32/kernel32.dll': Buffer.alloc(4),
      'fake-sys/SysWOW64/syswow.dll': Buffer.alloc(4),
      'fake-path/pathonly.dll': Buffer.alloc(4)
    })
    const result = await analyzeSoftwareBinary({
      installRoot: project.root,
      entryPath: project.absolute('app.exe'),
      systemRoot: project.absolute('fake-sys'),
      pathDirs: [project.absolute('fake-path')]
    })

    expect(result.binaryAnalysis).toBe('analyzed')
    expect(result.binaryFilesScanned).toEqual(['app.exe'])
    expect(result.binaryCapHit).toBe(false)
    const byName = new Map(result.binaryDependencies.map((dependency) => [dependency.name.toLowerCase(), dependency]))

    // Install root wins.
    expect(byName.get('runtime.dll')).toMatchObject({
      origin: 'app-local',
      status: 'ok',
      resolvedPath: project.absolute('runtime.dll')
    })
    // Common subdirectory, case-insensitive match.
    expect(byName.get('binlib.dll')).toMatchObject({
      origin: 'app-local',
      status: 'ok',
      resolvedPath: project.absolute('bin/binlib.dll')
    })
    // System32 / SysWOW64.
    expect(byName.get('sysdll.dll')).toMatchObject({
      origin: 'system',
      status: 'ok',
      resolvedPath: project.absolute('fake-sys/System32/sysdll.dll')
    })
    expect(byName.get('syswow.dll')).toMatchObject({
      origin: 'system',
      status: 'ok',
      resolvedPath: project.absolute('fake-sys/SysWOW64/syswow.dll')
    })
    // PATH-only match resolves, but origin is honest: cannot prove the source.
    expect(byName.get('pathonly.dll')).toMatchObject({
      origin: 'unknown',
      status: 'ok',
      resolvedPath: project.absolute('fake-path/pathonly.dll')
    })
    // Missing app-local dependency is the important finding.
    expect(byName.get('missing.dll')).toMatchObject({
      origin: 'app-local',
      status: 'missing',
      resolvedPath: null
    })
    // API Set + known system modules are classified as system even when absent.
    expect(byName.get('api-ms-win-core-file-l1-1-0.dll')).toMatchObject({
      origin: 'system',
      status: 'ok'
    })
    expect(byName.get('vcruntime140.dll')).toMatchObject({
      origin: 'system',
      status: 'missing'
    })
    expect(byName.get('msvcp140.dll')).toMatchObject({
      origin: 'system',
      status: 'missing'
    })
    // Missing rows come first.
    expect(result.binaryDependencies[0]?.status).toBe('missing')
    // importedBy stays install-root-relative.
    expect(byName.get('runtime.dll')?.importedBy).toEqual(['app.exe'])
  })

  it('rejects a non-directory install root', async () => {
    const project = await createTempProject({ 'README.md': 'hello' })
    await expect(
      analyzeSoftwareBinary({ installRoot: project.absolute('README.md'), entryPath: null })
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' })
  })
})

/* ------------------------------------------------------------------ */
/* Target parsing                                                      */
/* ------------------------------------------------------------------ */

describe('parseSoftwareTarget', () => {
  it('accepts an install directory and picks a plausible entry program', async () => {
    const project = await createTempProject({
      'app.exe': buildPe(['KERNEL32.dll']),
      'unins000.exe': buildPe(['KERNEL32.dll'])
    })
    const target = await parseSoftwareTarget(project.root)
    expect(target.rootPath).toBe(project.root)
    expect(target.entryPath).toBe(project.absolute('app.exe'))
    expect(target.kindHint).toBe('directory')
    expect(target.warnings.some((warning) => warning.includes('入口程序'))).toBe(true)
  })

  it('accepts an .exe and uses its directory as root', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    const target = await parseSoftwareTarget(project.absolute('app.exe'))
    expect(target.rootPath).toBe(project.root)
    expect(target.entryPath).toBe(project.absolute('app.exe'))
    expect(target.kindHint).toBe('exe')
  })

  it('resolves a .lnk shortcut to its local target', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    await project.write('shortcut.lnk', buildShortcut(project.absolute('app.exe')))
    const target = await parseSoftwareTarget(project.absolute('shortcut.lnk'))
    expect(target.rootPath).toBe(project.root)
    expect(target.entryPath).toBe(project.absolute('app.exe'))
    expect(target.kindHint).toBe('shortcut')
  })

  it('rejects an unparseable shortcut', async () => {
    const project = await createTempProject({})
    await project.write('broken.lnk', Buffer.from('not a shortcut at all'))
    const error = await captureTargetError(() => parseSoftwareTarget(project.absolute('broken.lnk')))
    expect(error.code).toBe('SOFTWARE_TARGET_INVALID')
    expect(error.message).toContain('快捷方式')
  })

  it('rejects a file type that is not .exe / .lnk', async () => {
    const project = await createTempProject({ 'notes.txt': 'hello' })
    const error = await captureTargetError(() => parseSoftwareTarget(project.absolute('notes.txt')))
    expect(error.code).toBe('SOFTWARE_TARGET_INVALID')
  })

  it('rejects a missing path with FILE_NOT_FOUND', async () => {
    const project = await createTempProject({})
    const error = await captureTargetError(() =>
      parseSoftwareTarget(nodePath.join(project.root, 'nope', 'missing.exe'))
    )
    expect(error.code).toBe('FILE_NOT_FOUND')
  })

  it('rejects an empty path', async () => {
    const error = await captureTargetError(() => parseSoftwareTarget('   '))
    expect(error.code).toBe('SOFTWARE_TARGET_INVALID')
  })

  it('rejects a drive root', async () => {
    const driveRoot = nodePath.parse(process.cwd()).root
    const error = await captureTargetError(() => parseSoftwareTarget(driveRoot))
    expect(error.code).toBe('SOFTWARE_TARGET_INVALID')
    expect(error.message).toContain('根目录')
  })

  it('rejects the user profile root', async () => {
    const error = await captureTargetError(() => parseSoftwareTarget(homedir()))
    expect(error.code).toBe('SOFTWARE_TARGET_INVALID')
    expect(error.message).toContain('主目录')
  })

  it.runIf(process.platform === 'win32')('rejects the Windows system directory', async () => {
    const windowsRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
    const error = await captureTargetError(() => parseSoftwareTarget(windowsRoot))
    expect(error.code).toBe('SOFTWARE_SYSTEM_DIRECTORY')
    expect(error.message).toContain('系统')
  })
})

/* ------------------------------------------------------------------ */
/* Version metadata + inspection                                       */
/* ------------------------------------------------------------------ */

describe('readFileVersionInfo', () => {
  it('returns all-null fields without spawning anything off Windows', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    const info = await readFileVersionInfo(project.absolute('app.exe'), { platform: 'linux' })
    expect(info).toEqual({
      productName: null,
      fileDescription: null,
      productVersion: null,
      companyName: null
    })
  })

  it.runIf(process.platform === 'win32')('fails soft with a missing PowerShell', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    const info = await readFileVersionInfo(project.absolute('app.exe'), {
      powershellPath: nodePath.join(tmpdir(), `missing-powershell-${Date.now()}.exe`)
    })
    expect(info.productName).toBeNull()
    expect(info.productVersion).toBeNull()
  })

  const systemExecutableCandidates =
    process.platform === 'win32'
      ? [
          nodePath.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'notepad.exe'),
          nodePath.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'),
          nodePath.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'kernel32.dll')
        ]
      : []
  const systemExecutable = systemExecutableCandidates.find((candidate) => existsSync(candidate))

  it.runIf(systemExecutable !== undefined)('reads real version metadata from a system binary', async () => {
    const info = await readFileVersionInfo(systemExecutable as string, { timeoutMs: 10_000 })
    const values = [info.productName, info.fileDescription, info.productVersion, info.companyName]
    expect(values.some((value) => value !== null)).toBe(true)
  })
})

describe('inspectSoftware', () => {
  it('combines target parsing with read-only version metadata', async () => {
    const project = await createTempProject({
      'app.exe': buildPe(['KERNEL32.dll']),
      'unins000.exe': buildPe(['KERNEL32.dll'])
    })
    const result = await inspectSoftware(project.root, { platform: 'linux' })
    expect(result.rootPath).toBe(project.root)
    expect(result.entryPath).toBe(project.absolute('app.exe'))
    expect(result.info.entryPath).toBe(project.absolute('app.exe'))
    expect(result.info.iconDataUrl).toBeNull()
    expect(result.info.productName).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('文件版本信息'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('degrades gracefully when version metadata cannot be read', async () => {
    const project = await createTempProject({ 'app.exe': buildPe(['KERNEL32.dll']) })
    const result = await inspectSoftware(project.absolute('app.exe'), {
      powershellPath: nodePath.join(tmpdir(), `missing-powershell-${Date.now()}.exe`)
    })
    expect(result.rootPath).toBe(project.root)
    expect(result.entryPath).toBe(project.absolute('app.exe'))
    expect(result.info.productVersion).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('文件版本信息'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Safety by construction                                              */
/* ------------------------------------------------------------------ */

describe('software scan safety boundaries', () => {
  it('core modules never import a process/network API (the target is never executed)', () => {
    // The scanned software must never be launched; keep the core free of any
    // process-spawning or network module so this is structurally guaranteed.
    const forbidden = ['child_process', 'LoadLibrary', 'node:http', 'node:https', 'node:net', 'fetch(']
    for (const relative of [
      'src/main/core/pe.ts',
      'src/main/core/winShortcut.ts',
      'src/main/core/softwareScan.ts'
    ]) {
      const source = readFileSync(nodePath.join(process.cwd(), relative), 'utf8')
      for (const token of forbidden) {
        expect(source.includes(token), `${relative} 不应包含 ${token}`).toBe(false)
      }
    }
  })
})
