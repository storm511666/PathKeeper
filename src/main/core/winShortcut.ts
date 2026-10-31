/**
 * Best-effort, read-only parser for Windows Shell Link (`.lnk`) files.
 *
 * PathKeeper only needs the local target path recorded inside a shortcut so the
 * “扫描一个软件” flow can resolve a dragged/dropped program to its install
 * directory. The parser follows the MS-SHLLINK layout just far enough to reach
 * the `LinkInfo` structure and its local base path: it never resolves shell
 * item IDs, never touches the shell namespace and never executes the target.
 *
 * Shortcuts can be malformed (truncated downloads, MSI-advertised links, links
 * that only point at a network share, …). Therefore parsing is total: the
 * exported functions never throw for bad input and instead return
 * `{ targetPath: null, reason }` with a Chinese explanation.
 */

import { promises as fsp } from 'node:fs'
import { errorMessage } from './errors'

export interface ShortcutParseResult {
  /** Absolute (or as recorded) local target path, null when unavailable. */
  targetPath: string | null
  /** Chinese explanation when `targetPath` is null; empty string on success. */
  reason: string
  /** Directory hint from the header file attributes; null when unknown. */
  isDirectory: boolean | null
}

export interface ParseShortcutOptions {
  /** Maximum bytes read from disk. Defaults to 64 KiB, hard-capped at 1 MiB. */
  maxBytes?: number
}

const HEADER_BYTES = 76
const HEADER_SIZE = 0x4c
const LINK_INFO_MIN_HEADER = 0x1c
const LINK_INFO_UNICODE_HEADER = 0x24
const MAX_SHORTCUT_BYTES = 1024 * 1024
const DEFAULT_MAX_SHORTCUT_BYTES = 64 * 1024
const MAX_TARGET_CHARS = 2048

const SHELL_LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46
])

const LINK_FLAGS_OFFSET = 20
const FILE_ATTRIBUTES_OFFSET = 24

const FLAG_HAS_LINK_TARGET_ID_LIST = 0x0000_0001
const FLAG_HAS_LINK_INFO = 0x0000_0002
const FLAG_FORCE_NO_LINK_INFO = 0x0000_0100

/** LinkInfo flags. */
const LINK_INFO_VOLUME_ID_AND_LOCAL_BASE_PATH = 0x0000_0001
const LINK_INFO_COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX = 0x0000_0002

/** `FILE_ATTRIBUTE_DIRECTORY`. */
const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010

function unavailable(reason: string): ShortcutParseResult {
  return { targetPath: null, reason, isDirectory: null }
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function u16(buffer: Buffer, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > buffer.length) return null
  return buffer.readUInt16LE(offset)
}

function u32(buffer: Buffer, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > buffer.length) return null
  return buffer.readUInt32LE(offset)
}

/** Decode a NUL-terminated single-byte (ANSI) string; stops at the LinkInfo end. */
function readAnsiString(buffer: Buffer, start: number, end: number): string | null {
  const boundedEnd = Math.min(end, buffer.length)
  if (start < 0 || start >= boundedEnd) return null
  const nulIndex = buffer.indexOf(0, start)
  const stop = nulIndex >= 0 && nulIndex < boundedEnd ? nulIndex : boundedEnd
  if (stop <= start) return ''
  const bytes = buffer.subarray(start, stop)
  // ANSI code pages are not available in pure Node. Prefer UTF-8 when the bytes
  // happen to be valid UTF-8, otherwise fall back to a 1:1 byte decode so at
  // least ASCII paths survive; a Chinese ANSI path may be imperfect here, but
  // modern Windows shortcuts store the Unicode path as well.
  const utf8 = bytes.toString('utf8')
  const decoded = utf8.includes('\uFFFD') ? bytes.toString('latin1') : utf8
  return truncateText(decoded, MAX_TARGET_CHARS)
}

/** Decode a NUL-terminated UTF-16LE string; stops at the LinkInfo end. */
function readUnicodeString(buffer: Buffer, start: number, end: number): string | null {
  const boundedEnd = Math.min(end, buffer.length)
  if (start < 0 || start + 2 > boundedEnd) return null
  const chars: string[] = []
  let offset = start
  while (offset + 2 <= boundedEnd && chars.length < MAX_TARGET_CHARS) {
    const code = buffer.readUInt16LE(offset)
    if (code === 0) break
    chars.push(String.fromCharCode(code))
    offset += 2
  }
  return chars.join('')
}

interface LinkInfoTarget {
  targetPath: string | null
  reason: string
}

/** Parse the `LinkInfo` structure located at `base`. */
function parseLinkInfo(buffer: Buffer, base: number): LinkInfoTarget {
  const linkInfoSize = u32(buffer, base)
  const headerSize = u32(buffer, base + 4)
  const flags = u32(buffer, base + 8)
  if (linkInfoSize === null || headerSize === null || flags === null) {
    return { targetPath: null, reason: '快捷方式的目标信息不完整。' }
  }
  if (linkInfoSize < LINK_INFO_MIN_HEADER || headerSize < LINK_INFO_MIN_HEADER) {
    return { targetPath: null, reason: '快捷方式的目标信息格式不正确。' }
  }
  const end = base + linkInfoSize
  if (end > buffer.length) {
    return { targetPath: null, reason: '快捷方式的目标信息被截断。' }
  }
  if (headerSize > linkInfoSize) {
    return { targetPath: null, reason: '快捷方式的目标信息头大小异常。' }
  }

  const localBasePathOffset = u32(buffer, base + 16)
  const localBasePathOffsetUnicode =
    headerSize >= LINK_INFO_UNICODE_HEADER ? u32(buffer, base + 28) : null
  const hasLocalBasePath = (flags & LINK_INFO_VOLUME_ID_AND_LOCAL_BASE_PATH) !== 0

  if (hasLocalBasePath) {
    // Prefer the Unicode copy — it survives non-ASCII install paths.
    if (
      localBasePathOffsetUnicode !== null &&
      localBasePathOffsetUnicode > 0 &&
      localBasePathOffsetUnicode < linkInfoSize
    ) {
      const unicode = readUnicodeString(buffer, base + localBasePathOffsetUnicode, end)
      if (unicode !== null && unicode.trim().length > 0) {
        return { targetPath: unicode.trim(), reason: '' }
      }
    }
    if (localBasePathOffset !== null && localBasePathOffset > 0 && localBasePathOffset < linkInfoSize) {
      const ansi = readAnsiString(buffer, base + localBasePathOffset, end)
      if (ansi !== null && ansi.trim().length > 0) {
        return { targetPath: ansi.trim(), reason: '' }
      }
    }
    return { targetPath: null, reason: '快捷方式没有记录有效的本地目标路径。' }
  }

  if ((flags & LINK_INFO_COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX) !== 0) {
    return {
      targetPath: null,
      reason: '这个快捷方式只记录了网络路径，无法确定本地软件安装目录。'
    }
  }
  return { targetPath: null, reason: '快捷方式没有记录本地目标路径。' }
}

function parseShortcutUnsafe(buffer: Buffer): ShortcutParseResult {
  if (buffer.length < HEADER_BYTES) {
    return unavailable('文件太小，不是有效的 Windows 快捷方式。')
  }
  if (u32(buffer, 0) !== HEADER_SIZE) {
    return unavailable('快捷方式文件头大小不正确，可能不是有效的 .lnk 文件。')
  }
  const clsid = buffer.subarray(4, 20)
  if (!clsid.equals(SHELL_LINK_CLSID)) {
    return unavailable('文件标识不匹配，不是有效的 Windows 快捷方式。')
  }
  const flags = u32(buffer, LINK_FLAGS_OFFSET)
  if (flags === null) return unavailable('快捷方式文件头不完整。')
  const fileAttributes = u32(buffer, FILE_ATTRIBUTES_OFFSET)
  const isDirectory =
    fileAttributes === null || fileAttributes === 0
      ? null
      : (fileAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0

  const linkInfoStart = locateLinkInfo(buffer, flags)
  if (linkInfoStart === null) {
    if ((flags & FLAG_HAS_LINK_INFO) === 0 || (flags & FLAG_FORCE_NO_LINK_INFO) !== 0) {
      return {
        targetPath: null,
        reason: '这个快捷方式没有记录目标路径（可能是 MSI 安装程序创建的公告快捷方式）。',
        isDirectory
      }
    }
    return { targetPath: null, reason: '无法定位快捷方式中的目标信息。', isDirectory }
  }

  const linkInfo = parseLinkInfo(buffer, linkInfoStart)
  return { targetPath: linkInfo.targetPath, reason: linkInfo.reason, isDirectory }
}

/**
 * Find the `LinkInfo` structure. The optional shell item ID list precedes it;
 * the MS-SHLLINK spec treats the list size as not including its own two-byte
 * size field, but some writers include it, so both offsets are attempted and
 * the first one that yields a structurally valid `LinkInfo` wins.
 */
function locateLinkInfo(buffer: Buffer, flags: number): number | null {
  if ((flags & FLAG_HAS_LINK_INFO) === 0 || (flags & FLAG_FORCE_NO_LINK_INFO) !== 0) return null
  if ((flags & FLAG_HAS_LINK_TARGET_ID_LIST) === 0) return HEADER_BYTES
  const idListSize = u16(buffer, HEADER_BYTES)
  if (idListSize === null || idListSize < 2) return null
  const candidates = [HEADER_BYTES + 2 + idListSize, HEADER_BYTES + idListSize]
  for (const candidate of candidates) {
    if (candidate + LINK_INFO_MIN_HEADER > buffer.length) continue
    const size = u32(buffer, candidate)
    const headerSize = u32(buffer, candidate + 4)
    if (size === null || headerSize === null) continue
    if (size < LINK_INFO_MIN_HEADER || size > buffer.length - candidate) continue
    if (headerSize < LINK_INFO_MIN_HEADER || headerSize > size) continue
    return candidate
  }
  return null
}

/**
 * Parse a `.lnk` from an in-memory buffer. Pure and total: never throws for
 * malformed input (returns `targetPath: null` plus a Chinese reason).
 */
export function parseShortcutBuffer(buffer: Buffer): ShortcutParseResult {
  try {
    if (!Buffer.isBuffer(buffer)) return unavailable('快捷方式内容不是有效的二进制数据。')
    return parseShortcutUnsafe(buffer)
  } catch (error) {
    return unavailable(`解析快捷方式失败：${truncateText(errorMessage(error), 160)}`)
  }
}

/**
 * Read and parse a `.lnk` file. Opens the file read-only, reads at most
 * `maxBytes` (default 64 KiB), and never throws for malformed content.
 */
export async function parseShortcutFile(
  absPath: string,
  options: ParseShortcutOptions = {}
): Promise<ShortcutParseResult> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
  try {
    if (typeof absPath !== 'string' || absPath.trim().length === 0) {
      return unavailable('快捷方式路径为空。')
    }
    const requested = options.maxBytes
    const maxBytes =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_SHORTCUT_BYTES)
        : DEFAULT_MAX_SHORTCUT_BYTES
    try {
      handle = await fsp.open(absPath, 'r')
    } catch (error) {
      return unavailable(`无法读取快捷方式：${truncateText(errorMessage(error), 160)}`)
    }
    const stats = await handle.stat()
    if (!stats.isFile()) return unavailable('快捷方式不是一个普通文件。')
    if (stats.size === 0) return unavailable('快捷方式文件是空的。')
    const length = Math.min(maxBytes, stats.size)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return parseShortcutBuffer(buffer.subarray(0, bytesRead))
  } catch (error) {
    return unavailable(`读取快捷方式失败：${truncateText(errorMessage(error), 160)}`)
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Read-only handle; a failed close is harmless.
      }
    }
  }
}
