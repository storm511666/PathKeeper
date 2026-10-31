/**
 * PE import parser tests.
 *
 * Fixtures are synthetic PE32/PE32+ images built right here in the test file,
 * so every malformed / packed / truncated scenario is deterministic and no
 * binary blobs need to live in the repository. One conditional case parses the
 * real running `node.exe` to prove the reader works against genuine Windows
 * binaries; it never executes anything.
 */

import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MAX_PE_IMPORTS, readPeImports } from '../../src/main/core/pe'

const SECTION_RVA = 0x1000
const SECTION_RAW = 0x200
const MIN_RAW_SIZE = 0x1000
const FILE_ALIGN = 0x200
const IMPORT_DESCRIPTOR_BYTES = 20

const createdDirs: string[] = []

async function writeTempFile(name: string, content: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pathkeeper-pe-'))
  createdDirs.push(dir)
  const file = join(dir, name)
  await writeFile(file, content)
  return file
}

afterAll(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

interface BuildPeOptions {
  bitness?: 32 | 64
  imports?: string[]
  machine?: number
  /** Override the import data-directory RVA (used for bad-RVA cases). */
  importRva?: number
  /** Override the import data-directory size. */
  importSize?: number
  /** Mark the file as having no referenceable import directory at all. */
  noImportDirectory?: boolean
  eLfanew?: number
  /** Point FirstThunk at a thunk array made only of ordinal entries. */
  ordinalThunks?: boolean
  /** Make the first descriptor's DLL-name RVA unreachable. */
  corruptNameRva?: boolean
}

/**
 * Build a minimal but structurally honest PE image with one `.idata` section
 * that holds the import descriptor table and NUL-terminated DLL names.
 */
function buildPe(options: BuildPeOptions = {}): Buffer {
  const bitness = options.bitness ?? 32
  const is64 = bitness === 64
  const imports = options.imports ?? []
  const ordinalThunks = options.ordinalThunks === true
  const eLfanew = options.eLfanew ?? 0x80
  const optionalSize = is64 ? 240 : 224

  const descriptorBytes = (imports.length + 1) * IMPORT_DESCRIPTOR_BYTES
  const nameOffsets: number[] = []
  let cursor = descriptorBytes
  for (const name of imports) {
    nameOffsets.push(cursor)
    cursor += Buffer.byteLength(`${name}\u0000`, 'latin1')
  }
  const thunkOffset = ordinalThunks ? alignUp(cursor, 8) : 0
  if (ordinalThunks) cursor = thunkOffset + (is64 ? 16 : 8)
  const rawSize = alignUp(Math.max(MIN_RAW_SIZE, cursor), FILE_ALIGN)
  const buffer = Buffer.alloc(SECTION_RAW + rawSize)

  // DOS header + "MZ" stub.
  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(eLfanew, 0x3c)
  // PE signature + COFF file header.
  buffer.write('PE\u0000\u0000', eLfanew, 'latin1')
  const coff = eLfanew + 4
  buffer.writeUInt16LE(options.machine ?? (is64 ? 0x8664 : 0x014c), coff)
  buffer.writeUInt16LE(1, coff + 2) // NumberOfSections
  buffer.writeUInt16LE(optionalSize, coff + 16) // SizeOfOptionalHeader
  buffer.writeUInt16LE(0x0102, coff + 18) // Characteristics

  // Optional header.
  const opt = eLfanew + 24
  buffer.writeUInt16LE(is64 ? 0x20b : 0x10b, opt)
  buffer.writeUInt32LE(0x1000, opt + 16) // AddressOfEntryPoint
  if (is64) {
    buffer.writeBigUInt64LE(0x140000000n, opt + 24) // ImageBase
  } else {
    buffer.writeUInt32LE(0x400000, opt + 28) // ImageBase
  }
  buffer.writeUInt32LE(0x1000, opt + 32) // SectionAlignment
  buffer.writeUInt32LE(FILE_ALIGN, opt + 36) // FileAlignment
  buffer.writeUInt32LE(0x2000, opt + 56) // SizeOfImage
  buffer.writeUInt32LE(SECTION_RAW, opt + 60) // SizeOfHeaders
  buffer.writeUInt16LE(3, opt + 68) // Subsystem = console
  const numberOfRvaOffset = is64 ? 108 : 92
  const dataDirectoryOffset = is64 ? 112 : 96
  buffer.writeUInt32LE(options.noImportDirectory === true ? 1 : 16, opt + numberOfRvaOffset)
  const importEntry = dataDirectoryOffset + 8
  buffer.writeUInt32LE(
    options.noImportDirectory === true ? 0 : (options.importRva ?? SECTION_RVA),
    opt + importEntry
  )
  buffer.writeUInt32LE(
    options.noImportDirectory === true ? 0 : (options.importSize ?? descriptorBytes),
    opt + importEntry + 4
  )

  // Section table (one `.idata` section).
  const sectionHeader = eLfanew + 24 + optionalSize
  buffer.write('.idata', sectionHeader, 'latin1')
  buffer.writeUInt32LE(rawSize, sectionHeader + 8) // VirtualSize
  buffer.writeUInt32LE(SECTION_RVA, sectionHeader + 12) // VirtualAddress
  buffer.writeUInt32LE(rawSize, sectionHeader + 16) // SizeOfRawData
  buffer.writeUInt32LE(SECTION_RAW, sectionHeader + 20) // PointerToRawData
  buffer.writeUInt32LE(0xc0000040, sectionHeader + 36) // Characteristics

  // Import descriptor table.
  for (let index = 0; index < imports.length; index += 1) {
    const base = SECTION_RAW + index * IMPORT_DESCRIPTOR_BYTES
    const nameOffset = nameOffsets[index] ?? 0
    buffer.writeUInt32LE(ordinalThunks ? SECTION_RVA + thunkOffset : 0, base)
    buffer.writeUInt32LE(0, base + 4)
    buffer.writeUInt32LE(0, base + 8)
    const unreachableName = options.corruptNameRva === true && index === 0
    buffer.writeUInt32LE(unreachableName ? 0x7ffe0000 : SECTION_RVA + nameOffset, base + 12)
    buffer.writeUInt32LE(ordinalThunks ? SECTION_RVA + thunkOffset : 0, base + 16)
  }
  // The 20-byte all-zero terminator is already zero-filled.

  // Imported DLL names.
  for (let index = 0; index < imports.length; index += 1) {
    const name = imports[index] ?? ''
    buffer.write(`${name}\u0000`, SECTION_RAW + (nameOffsets[index] ?? 0), 'latin1')
  }

  // Ordinal-only thunk array: one ordinal import followed by a zero terminator.
  if (ordinalThunks) {
    const at = SECTION_RAW + thunkOffset
    if (is64) {
      buffer.writeUInt32LE(1, at)
      buffer.writeUInt32LE(0x80000000, at + 4)
    } else {
      buffer.writeUInt32LE(0x80000001, at)
    }
  }

  return buffer
}

describe('readPeImports — well-formed binaries', () => {
  it('parses PE32 imports, machine and bitness', async () => {
    const file = await writeTempFile(
      'app32.exe',
      buildPe({ imports: ['KERNEL32.dll', 'user32.dll', 'vcruntime140.dll'] })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['KERNEL32.dll', 'user32.dll', 'vcruntime140.dll'])
    expect(result.machine).toBe(0x014c)
    expect(result.is64Bit).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.warnings).toEqual([])
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('parses PE32+ imports', async () => {
    const file = await writeTempFile(
      'app64.exe',
      buildPe({ bitness: 64, imports: ['KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'] })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'])
    expect(result.machine).toBe(0x8664)
    expect(result.is64Bit).toBe(true)
  })

  it('keeps parsing when the import thunks are ordinal-only', async () => {
    const file = await writeTempFile(
      'ordinal.exe',
      buildPe({ imports: ['ORDINAL.dll', 'KERNEL32.dll'], ordinalThunks: true })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['ORDINAL.dll', 'KERNEL32.dll'])
  })

  it('deduplicates module names case-insensitively', async () => {
    const file = await writeTempFile(
      'dupe.exe',
      buildPe({ imports: ['KERNEL32.dll', 'kernel32.DLL', 'User32.dll'] })
    )
    const result = await readPeImports(file)
    expect(result.imports).toEqual(['KERNEL32.dll', 'User32.dll'])
  })

  it('reports an empty import table as parsed without inventing dependencies', async () => {
    const file = await writeTempFile('empty-imports.exe', buildPe({ imports: [] }))
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual([])
    expect(result.warnings.some((warning) => warning.includes('导入表为空'))).toBe(true)
  })

  it('parses imports of a large executable without reading the payload', async () => {
    const pe = buildPe({ imports: ['KERNEL32.dll', 'huge.dll'] })
    const padded = Buffer.concat([pe, Buffer.alloc(4 * 1024 * 1024)])
    const file = await writeTempFile('padded.exe', padded)
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['KERNEL32.dll', 'huge.dll'])
  })

  it('skips a descriptor whose DLL-name RVA is unreachable but keeps the rest', async () => {
    const file = await writeTempFile(
      'one-bad-descriptor.exe',
      buildPe({ imports: ['BROKEN.dll', 'SECOND.dll'], corruptNameRva: true })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['SECOND.dll'])
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('readPeImports — caps and truncation', () => {
  it('caps imports at 256 by default and flags truncation honestly', async () => {
    const names = Array.from({ length: 300 }, (_, index) => `module-${index}.dll`)
    const file = await writeTempFile('many-imports.exe', buildPe({ imports: names }))
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toHaveLength(DEFAULT_MAX_PE_IMPORTS)
    expect(result.imports).toEqual(names.slice(0, DEFAULT_MAX_PE_IMPORTS))
    expect(result.truncated).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('上限'))).toBe(true)
  })

  it('honors an explicit maxImports option', async () => {
    const file = await writeTempFile(
      'capped.exe',
      buildPe({ imports: ['A.dll', 'B.dll', 'C.dll', 'D.dll'] })
    )
    const result = await readPeImports(file, { maxImports: 2 })
    expect(result.imports).toEqual(['A.dll', 'B.dll'])
    expect(result.truncated).toBe(true)
  })

  it('tolerates a zero import-directory size when the RVA is valid', async () => {
    const file = await writeTempFile(
      'zero-size.exe',
      buildPe({ imports: ['KERNEL32.dll'], importSize: 0 })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['KERNEL32.dll'])
    expect(result.warnings.some((warning) => warning.includes('大小为 0'))).toBe(true)
  })

  it('reports a table without a terminator as truncated instead of crashing', async () => {
    const pe = buildPe({ imports: ['KERNEL32.dll'] })
    // Shrink the declared import-directory size so the all-zero terminator is
    // outside the readable table: the parser must note the missing terminator.
    const optionalHeaderOffset = 0x80 + 24
    pe.writeUInt32LE(
      IMPORT_DESCRIPTOR_BYTES,
      optionalHeaderOffset + 96 + 12 // data-directory offset (PE32) + import size field
    )
    const file = await writeTempFile('no-terminator.exe', pe)
    const result = await readPeImports(file)
    expect(result.status).toBe('parsed')
    expect(result.imports).toEqual(['KERNEL32.dll'])
    expect(result.truncated).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('结束标记'))).toBe(true)
  })
})

describe('readPeImports — malformed / packed inputs never crash', () => {
  it('returns unavailable for a tiny non-PE file', async () => {
    const file = await writeTempFile('tiny.exe', Buffer.from('MZ'))
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.imports).toEqual([])
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('returns unavailable for a plain text file', async () => {
    const file = await writeTempFile('text.exe', Buffer.from('this is not a windows program'.repeat(10)))
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('MZ')
  })

  it('returns unavailable when the PE signature is missing', async () => {
    const pe = buildPe({ imports: ['KERNEL32.dll'] })
    pe.write('NOPE', 0x80, 'latin1')
    const file = await writeTempFile('bad-signature.exe', pe)
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('PE 签名')
  })

  it('returns unavailable for an absurd e_lfanew', async () => {
    const pe = buildPe({ imports: ['KERNEL32.dll'] })
    pe.writeUInt32LE(0x7fff0000, 0x3c) // patch the DOS header's PE offset
    const file = await writeTempFile('bad-lfanew.exe', pe)
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('偏移')
  })

  it('returns unavailable when the file is truncated mid-header', async () => {
    const pe = buildPe({ imports: ['KERNEL32.dll'] })
    const file = await writeTempFile('truncated-headers.exe', pe.subarray(0, 0x140))
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('returns unavailable when the file is truncated before the import table', async () => {
    const pe = buildPe({ imports: ['KERNEL32.dll'] })
    const file = await writeTempFile('truncated-imports.exe', pe.subarray(0, 0x200))
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('导入表')
  })

  it('returns unavailable when the import-directory RVA points outside the image', async () => {
    const file = await writeTempFile(
      'packed-rva.exe',
      buildPe({ imports: ['KERNEL32.dll'], importRva: 0x7ffe0000 })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('导入表')
    expect(result.imports).toEqual([])
  })

  it('returns unavailable when the program has no data directories at all', async () => {
    const file = await writeTempFile(
      'no-directories.exe',
      buildPe({ imports: ['KERNEL32.dll'], noImportDirectory: true })
    )
    const result = await readPeImports(file)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('导入表')
  })

  it('returns unavailable instead of throwing for a missing file', async () => {
    const missing = join(tmpdir(), `pathkeeper-pe-missing-${Date.now()}.exe`)
    const result = await readPeImports(missing)
    expect(result.status).toBe('unavailable')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('returns unavailable for a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pathkeeper-pe-dir-'))
    createdDirs.push(dir)
    const result = await readPeImports(dir)
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('普通文件')
  })

  it('rejects an empty path without throwing', async () => {
    const result = await readPeImports('   ')
    expect(result.status).toBe('unavailable')
  })

  it('throws an AbortError when the signal is already aborted', async () => {
    const file = await writeTempFile('abort.exe', buildPe({ imports: ['KERNEL32.dll'] }))
    const controller = new AbortController()
    controller.abort()
    await expect(readPeImports(file, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

describe.runIf(process.platform === 'win32')('readPeImports — real Windows binary', () => {
  it('parses the imports of the running Node.js executable', async () => {
    const result = await readPeImports(process.execPath)
    expect(result.status).toBe('parsed')
    expect(result.imports.length).toBeGreaterThan(0)
    expect(result.imports.every((name) => name.toLowerCase().endsWith('.dll'))).toBe(true)
    expect(result.is64Bit).toBe(process.arch === 'x64' || process.arch === 'arm64')
    expect(result.truncated).toBe(false)
  })
})
