/**
 * Minimal, read-only PE (Portable Executable) import-table reader.
 *
 * PathKeeper only needs the names of the DLLs that an `.exe`/`.dll` imports so
 * the software report can tell the user whether the program's own files are
 * still present. This module therefore never loads, maps or executes the
 * target: the file is opened read-only and only a handful of bounded positional
 * reads are issued (DOS/PE/image headers, the section table, the import
 * descriptor table and each imported DLL name). A 1 GB executable costs the
 * same memory as a 20 KB one.
 *
 * Malformed, packed, packed-up or truncated binaries return
 * `status: 'unavailable'` together with an honest Chinese reason instead of
 * guessing, so a report never claims that a DLL is missing merely because the
 * static import table could not be read.
 */

import { promises as fsp } from 'node:fs'
import { createAbortError, errorMessage, isAbortError } from './errors'

export type PeImportStatus = 'parsed' | 'unavailable'

export interface PeImportsOptions {
  /** Upper bound on parsed import descriptors. Defaults to 256. */
  maxImports?: number
  /** Cancels parsing; a cancelled call throws an AbortError. */
  signal?: AbortSignal
}

export interface PeImportsResult {
  status: PeImportStatus
  /** Human-readable (Chinese) explanation; empty only for a clean parse. */
  reason: string
  /** Unique imported DLL module names, in table order. */
  imports: string[]
  /** COFF machine id (`0x14c` x86, `0x8664` x64, ...) or null when unknown. */
  machine: number | null
  /** True for PE32+, false for PE32, null when the headers were unreadable. */
  is64Bit: boolean | null
  /** True when the table (or optional import cap) was cut short. */
  truncated: boolean
  /** Non-fatal observations, Chinese, user-facing. */
  warnings: string[]
}

/** Default per-program import cap; keeps memory and report size predictable. */
export const DEFAULT_MAX_PE_IMPORTS = 256
/** Hard ceiling even when a caller asks for more. */
const HARD_MAX_IMPORTS = 4096

const DOS_HEADER_BYTES = 64
const DOS_E_LFANEW_OFFSET = 0x3c
const COFF_HEADER_BYTES = 24
const PE_SIGNATURE = 'PE\u0000\u0000'
const SECTION_HEADER_BYTES = 40
const IMPORT_DESCRIPTOR_BYTES = 20
const MAX_SECTIONS = 96
const MAX_PE_HEADER_OFFSET = 16 * 1024 * 1024
const MAX_OPTIONAL_HEADER_BYTES = 4096
const MAX_DLL_NAME_BYTES = 512
const MAX_DLL_NAME_CHARS = 260
const MAX_WARNINGS = 24
const IMAGE_FILE_MACHINE_I386 = 0x014c
const IMAGE_FILE_MACHINE_AMD64 = 0x8664
const IMAGE_FILE_MACHINE_ARM = 0x01c4
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64

type PeFileHandle = Awaited<ReturnType<typeof fsp.open>>

interface PeSection {
  virtualAddress: number
  virtualSize: number
  rawSize: number
  rawPointer: number
}

interface PeReader {
  readonly size: number
  /** Read at most `length` bytes at `offset`; short reads return a shorter buffer. */
  readAt(offset: number, length: number): Promise<Buffer>
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw createAbortError()
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message)
}

function u16(buffer: Buffer, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > buffer.length) return null
  return buffer.readUInt16LE(offset)
}

function u32(buffer: Buffer, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > buffer.length) return null
  return buffer.readUInt32LE(offset)
}

function normalizeMaxImports(value: unknown): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_MAX_PE_IMPORTS
  return Math.min(Math.max(parsed, 1), HARD_MAX_IMPORTS)
}

function createReader(handle: PeFileHandle, size: number): PeReader {
  return {
    size,
    async readAt(offset: number, length: number): Promise<Buffer> {
      const start = Math.max(0, Math.floor(offset))
      const wanted = Math.max(0, Math.min(Math.floor(length), size - start))
      if (wanted === 0) return Buffer.alloc(0)
      const buffer = Buffer.alloc(wanted)
      let filled = 0
      while (filled < wanted) {
        const { bytesRead } = await handle.read(buffer, filled, wanted - filled, start + filled)
        if (bytesRead <= 0) break
        filled += bytesRead
      }
      return filled === wanted ? buffer : buffer.subarray(0, filled)
    }
  }
}

/** Map an RVA to a file offset using the section table. Read-only, pure math. */
function rvaToFileOffset(
  rva: number,
  sizeOfHeaders: number,
  sections: readonly PeSection[],
  fileSize: number
): number | null {
  if (!Number.isFinite(rva) || rva <= 0) return null
  if (sizeOfHeaders > 0 && rva < sizeOfHeaders) {
    return rva < fileSize ? rva : null
  }
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize)
    if (span <= 0) continue
    if (rva < section.virtualAddress || rva >= section.virtualAddress + span) continue
    const delta = rva - section.virtualAddress
    // Data in the virtual tail without a file backing (e.g. .bss) is unreadable.
    if (delta >= section.rawSize) return null
    const offset = section.rawPointer + delta
    return offset >= 0 && offset < fileSize ? offset : null
  }
  return null
}

/** Reject control characters / path separators / garbage that is not a module name. */
function sanitizeDllName(raw: string): string | null {
  const trimmed = raw.replace(/\u0000/g, '').trim()
  if (trimmed.length === 0 || trimmed.length > MAX_DLL_NAME_CHARS) return null
  // PE import names are ANSI/ASCII; anything outside printable ASCII means we
  // mapped the wrong bytes and must not report it as a real dependency.
  if (!/^[\x20-\x7e]+$/.test(trimmed)) return null
  if (/[\\/:*?"<>|]/.test(trimmed)) return null
  if (!/\.[A-Za-z0-9]{1,10}$/.test(trimmed)) return null
  return trimmed
}

function unavailable(
  reason: string,
  warnings: string[] = [],
  partial: Partial<Pick<PeImportsResult, 'machine' | 'is64Bit' | 'truncated'>> = {}
): PeImportsResult {
  return {
    status: 'unavailable',
    reason,
    imports: [],
    machine: partial.machine ?? null,
    is64Bit: partial.is64Bit ?? null,
    truncated: partial.truncated === true,
    warnings: warnings.slice(0, MAX_WARNINGS)
  }
}

/**
 * Read the static import table of a PE file.
 *
 * - Opens the target **read-only**; never executes/loads it, never writes.
 * - Bounded memory: headers + import descriptors + DLL names only.
 * - Never throws for malformed input (returns `status: 'unavailable'` with a
 *   Chinese `reason`); only an aborted `signal` throws (AbortError).
 */
export async function readPeImports(
  absPath: string,
  options: PeImportsOptions = {}
): Promise<PeImportsResult> {
  const warnings: string[] = []
  const maxImports = normalizeMaxImports(options.maxImports)
  let handle: PeFileHandle | null = null

  try {
    throwIfAborted(options.signal)
    if (typeof absPath !== 'string' || absPath.trim().length === 0) {
      return unavailable('文件路径为空，无法解析程序导入表。')
    }
    try {
      handle = await fsp.open(absPath, 'r')
    } catch (error) {
      return unavailable(`无法以只读方式打开文件：${truncateText(errorMessage(error), 160)}`)
    }
    throwIfAborted(options.signal)
    const stats = await handle.stat()
    if (!stats.isFile()) {
      return unavailable('目标不是普通文件，无法解析程序导入表。')
    }
    const size = stats.size
    if (size < DOS_HEADER_BYTES) {
      return unavailable('文件太小，不像 Windows 程序（PE 文件），不做判断。')
    }
    const reader = createReader(handle, size)

    // 1. DOS header (`MZ`) and the PE header offset.
    const dos = await reader.readAt(0, DOS_HEADER_BYTES)
    if (dos.length < DOS_HEADER_BYTES || dos[0] !== 0x4d || dos[1] !== 0x5a) {
      return unavailable('文件开头不是 MZ 标记，不是有效的 Windows 程序（PE 文件），不做判断。')
    }
    const peOffset = u32(dos, DOS_E_LFANEW_OFFSET)
    if (
      peOffset === null ||
      peOffset < DOS_HEADER_BYTES ||
      peOffset > MAX_PE_HEADER_OFFSET ||
      peOffset + COFF_HEADER_BYTES > size
    ) {
      return unavailable('PE 头偏移无效，文件可能已损坏或加壳，不做判断。')
    }

    // 2. PE signature + COFF file header.
    throwIfAborted(options.signal)
    const coff = await reader.readAt(peOffset, COFF_HEADER_BYTES)
    if (coff.length < COFF_HEADER_BYTES) {
      return unavailable('PE 头不完整，文件可能被截断，不做判断。')
    }
    if (coff.toString('latin1', 0, 4) !== PE_SIGNATURE) {
      return unavailable('找不到 PE 签名，不是有效的 Windows 程序，不做判断。')
    }
    const machine = u16(coff, 4) ?? null
    const sectionCount = u16(coff, 6) ?? 0
    const optionalSize = u16(coff, 20) ?? 0
    if (sectionCount === 0) {
      return unavailable('PE 文件没有节（section），无法解析导入表，不做判断。', warnings, {
        machine
      })
    }
    if (sectionCount > MAX_SECTIONS) {
      return unavailable(`PE 节数量异常（${sectionCount}），文件可能已损坏或加壳，不做判断。`, warnings, {
        machine
      })
    }
    if (optionalSize < 28) {
      return unavailable('PE 可选头过小，文件可能已损坏，不做判断。', warnings, { machine })
    }

    // 3. Optional header: PE32 (0x10b) or PE32+ (0x20b).
    throwIfAborted(options.signal)
    const optional = await reader.readAt(
      peOffset + COFF_HEADER_BYTES,
      Math.min(optionalSize, MAX_OPTIONAL_HEADER_BYTES)
    )
    if (optional.length < 28) {
      return unavailable('PE 可选头不完整，文件可能被截断，不做判断。', warnings, { machine })
    }
    const magic = u16(optional, 0)
    let dataDirectoryOffset: number
    let numberOfRvaAndSizesOffset: number
    let is64Bit: boolean
    if (magic === 0x10b) {
      dataDirectoryOffset = 96
      numberOfRvaAndSizesOffset = 92
      is64Bit = false
    } else if (magic === 0x20b) {
      dataDirectoryOffset = 112
      numberOfRvaAndSizesOffset = 108
      is64Bit = true
    } else {
      const magicLabel = magic === null ? '未知' : `0x${magic.toString(16)}`
      return unavailable(`无法识别的 PE 可选头格式（${magicLabel}），不做判断。`, warnings, {
        machine
      })
    }
    if (optional.length < numberOfRvaAndSizesOffset + 4) {
      return unavailable('PE 可选头不完整，无法读取数据目录，不做判断。', warnings, {
        machine,
        is64Bit
      })
    }
    const numberOfRvaAndSizes = u32(optional, numberOfRvaAndSizesOffset) ?? 0
    const sizeOfHeaders = u32(optional, 60) ?? 0
    if (numberOfRvaAndSizes < 2 || optional.length < dataDirectoryOffset + 16) {
      return unavailable(
        '这个程序没有可读取的导入表（可能已加壳、是 .NET/驱动文件，或不需要外部 DLL），不做判断。',
        warnings,
        { machine, is64Bit }
      )
    }
    // Data directory index 1 = IMAGE_DIRECTORY_ENTRY_IMPORT (RVA + size).
    const importRva = u32(optional, dataDirectoryOffset + 8) ?? 0
    const importSize = u32(optional, dataDirectoryOffset + 12) ?? 0
    if (importRva === 0) {
      return unavailable(
        '这个程序没有导入表（可能已加壳、是 .NET 程序，或不需要外部 DLL），不做判断。',
        warnings,
        { machine, is64Bit }
      )
    }
    const machineLooks64Bit = machine === IMAGE_FILE_MACHINE_AMD64 || machine === IMAGE_FILE_MACHINE_ARM64
    const machineLooks32Bit = machine === IMAGE_FILE_MACHINE_I386 || machine === IMAGE_FILE_MACHINE_ARM
    if ((is64Bit && machineLooks32Bit) || (!is64Bit && machineLooks64Bit)) {
      // Not fatal: some valid files carry unusual machine ids. Just note it.
      addWarning(warnings, 'PE 头中的位数与 CPU 类型不一致，仅供参考。')
    }

    // 4. Section table, used to translate RVAs into file offsets.
    throwIfAborted(options.signal)
    const sectionOffset = peOffset + COFF_HEADER_BYTES + optionalSize
    const sectionBytes = await reader.readAt(sectionOffset, sectionCount * SECTION_HEADER_BYTES)
    if (sectionBytes.length < sectionCount * SECTION_HEADER_BYTES) {
      return unavailable('PE 节表不完整，文件可能被截断，不做判断。', warnings, {
        machine,
        is64Bit
      })
    }
    const sections: PeSection[] = []
    for (let index = 0; index < sectionCount; index += 1) {
      const base = index * SECTION_HEADER_BYTES
      sections.push({
        virtualSize: u32(sectionBytes, base + 8) ?? 0,
        virtualAddress: u32(sectionBytes, base + 12) ?? 0,
        rawSize: u32(sectionBytes, base + 16) ?? 0,
        rawPointer: u32(sectionBytes, base + 20) ?? 0
      })
    }

    // 5. Import descriptor table + imported DLL names.
    const importOffset = rvaToFileOffset(importRva, sizeOfHeaders, sections, size)
    if (importOffset === null) {
      return unavailable(
        '导入表所在位置无效（可能已加壳或文件被截断），无法判断缺失的 DLL，不做判断。',
        warnings,
        { machine, is64Bit }
      )
    }
    const declaredDescriptors =
      importSize >= IMPORT_DESCRIPTOR_BYTES ? Math.floor(importSize / IMPORT_DESCRIPTOR_BYTES) : 0
    let truncated = declaredDescriptors > maxImports
    if (truncated) {
      addWarning(warnings, `导入表记录 ${declaredDescriptors} 个模块，超过上限 ${maxImports}，只分析前 ${maxImports} 个。`)
    }
    if (importSize === 0) {
      addWarning(warnings, '导入表声明大小为 0，已按上限尝试读取。')
    }
    const descriptorBudget =
      importSize > 0
        ? Math.min(importSize, (maxImports + 1) * IMPORT_DESCRIPTOR_BYTES)
        : (maxImports + 1) * IMPORT_DESCRIPTOR_BYTES
    const descriptorBytes = await reader.readAt(
      importOffset,
      Math.min(descriptorBudget, Math.max(0, size - importOffset))
    )

    const imports: string[] = []
    const seenNames = new Set<string>()
    let descriptorsSeen = 0
    let reachedTerminator = false
    for (let index = 0; index < maxImports; index += 1) {
      throwIfAborted(options.signal)
      const base = index * IMPORT_DESCRIPTOR_BYTES
      if (base + IMPORT_DESCRIPTOR_BYTES > descriptorBytes.length) break
      const originalFirstThunk = u32(descriptorBytes, base) ?? 0
      const timeDateStamp = u32(descriptorBytes, base + 4) ?? 0
      const forwarderChain = u32(descriptorBytes, base + 8) ?? 0
      const nameRva = u32(descriptorBytes, base + 12) ?? 0
      const firstThunk = u32(descriptorBytes, base + 16) ?? 0
      if (
        originalFirstThunk === 0 &&
        timeDateStamp === 0 &&
        forwarderChain === 0 &&
        nameRva === 0 &&
        firstThunk === 0
      ) {
        reachedTerminator = true
        break
      }
      descriptorsSeen = index + 1
      // Ordinal-only imports simply have no name RVA; they do not add a module
      // name, so skip them without failing the whole table.
      if (nameRva === 0) {
        addWarning(warnings, `第 ${index + 1} 个导入描述没有 DLL 名称，已跳过。`)
        continue
      }
      const nameOffset = rvaToFileOffset(nameRva, sizeOfHeaders, sections, size)
      if (nameOffset === null) {
        addWarning(warnings, `第 ${index + 1} 个导入项的 DLL 名称位置无效，已跳过。`)
        continue
      }
      const nameBytes = await reader.readAt(nameOffset, MAX_DLL_NAME_BYTES)
      if (nameBytes.length === 0) {
        addWarning(warnings, `第 ${index + 1} 个导入项的 DLL 名称无法读取，已跳过。`)
        continue
      }
      const nulIndex = nameBytes.indexOf(0)
      const rawName = (nulIndex >= 0 ? nameBytes.subarray(0, nulIndex) : nameBytes).toString('latin1')
      const name = sanitizeDllName(rawName)
      if (name === null) {
        addWarning(warnings, `第 ${index + 1} 个导入项的 DLL 名称无效，已跳过。`)
        continue
      }
      const key = name.toLowerCase()
      if (seenNames.has(key)) continue
      seenNames.add(key)
      imports.push(name)
    }
    if (!reachedTerminator) {
      if (descriptorsSeen >= maxImports) {
        truncated = true
        addWarning(warnings, `导入项超过上限 ${maxImports} 个，只分析前 ${maxImports} 个。`)
      } else {
        truncated = true
        addWarning(warnings, '导入表缺少结束标记，文件可能被截断，已尽可能读取。')
      }
    }

    if (imports.length === 0) {
      if (descriptorsSeen === 0) {
        addWarning(warnings, '导入表为空：这个程序没有可静态检查的 DLL 依赖。')
        return {
          status: 'parsed',
          reason: '导入表为空，没有可检查的 DLL 依赖。',
          imports: [],
          machine,
          is64Bit,
          truncated,
          warnings: warnings.slice(0, MAX_WARNINGS)
        }
      }
      return unavailable(
        '导入表存在，但没能读出任何有效的 DLL 名称（可能已加壳或文件被截断），不做判断。',
        warnings,
        { machine, is64Bit, truncated }
      )
    }

    return {
      status: 'parsed',
      reason: '导入表解析成功。',
      imports,
      machine,
      is64Bit,
      truncated,
      warnings: warnings.slice(0, MAX_WARNINGS)
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return unavailable(
      `解析程序导入表时发生意外错误：${truncateText(errorMessage(error), 160)}`,
      warnings
    )
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // A read-only handle that fails to close is harmless at process level.
      }
    }
  }
}
