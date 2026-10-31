/**
 * Windows shortcut (`.lnk`) parser tests.
 *
 * Fixtures are synthetic MS-SHLLINK buffers built in this file, so both the
 * common layouts (ANSI / Unicode local base path, with or without an item ID
 * list) and every malformed case are deterministic. Nothing is executed and no
 * real shortcut is required.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseShortcutBuffer, parseShortcutFile } from '../../src/main/core/winShortcut'

const SHELL_LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46
])
const HEADER_BYTES = 76

const createdDirs: string[] = []

async function writeTempFile(name: string, content: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pathkeeper-lnk-'))
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

interface BuildShortcutOptions {
  localBasePath?: string
  /** Write the Unicode LinkInfo base path (needs the 0x24-byte header). */
  unicode?: boolean
  includeIdList?: boolean
  /** Some writers count the 2-byte size field inside IDList size; emulate both. */
  idListSizeIncludesItself?: boolean
  fileAttributes?: number
  noLinkInfo?: boolean
  /** LinkInfo flags: 1 = local base path (+volume id), 2 = network relative. */
  linkInfoFlags?: number
  truncateTo?: number
}

/** Build a structurally plausible MS-SHLLINK buffer for one target path. */
function buildShortcut(options: BuildShortcutOptions = {}): Buffer {
  const localBasePath = options.localBasePath ?? 'C:\\Apps\\Example\\example.exe'
  const unicode = options.unicode === true
  const linkInfoHeaderSize = unicode ? 0x24 : 0x1c
  const ansiBytes = Buffer.from(`${localBasePath}\u0000`, 'latin1')
  const unicodeBytes = Buffer.from(`${localBasePath}\u0000`, 'utf16le')

  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(0x4c, 0) // HeaderSize
  SHELL_LINK_CLSID.copy(header, 4)
  let flags = 0
  if (options.noLinkInfo !== true) flags |= 0x02 // HasLinkInfo
  if (unicode) flags |= 0x80 // IsUnicode
  if (options.includeIdList === true) flags |= 0x01 // HasLinkTargetIDList
  header.writeUInt32LE(flags, 20)
  header.writeUInt32LE(options.fileAttributes ?? 0x20, 24) // FileAttributes

  const parts: Buffer[] = [header]

  if (options.includeIdList === true) {
    const itemBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]) // opaque shell item payload
    const idList = Buffer.alloc(2 + itemBytes.length)
    const declaredSize =
      options.idListSizeIncludesItself === true ? itemBytes.length + 2 : itemBytes.length
    idList.writeUInt16LE(declaredSize, 0)
    itemBytes.copy(idList, 2)
    parts.push(idList)
  }

  if (options.noLinkInfo !== true) {
    const linkInfo = Buffer.alloc(linkInfoHeaderSize + ansiBytes.length + unicodeBytes.length)
    linkInfo.writeUInt32LE(linkInfo.length, 0) // LinkInfoSize
    linkInfo.writeUInt32LE(linkInfoHeaderSize, 4) // LinkInfoHeaderSize
    linkInfo.writeUInt32LE(options.linkInfoFlags ?? 1, 8) // LinkInfoFlags
    linkInfo.writeUInt32LE(0, 12) // VolumeIDOffset (ignored by the parser)
    linkInfo.writeUInt32LE(linkInfoHeaderSize, 16) // LocalBasePathOffset (ANSI)
    linkInfo.writeUInt32LE(0, 20) // CommonNetworkRelativeLinkOffset
    linkInfo.writeUInt32LE(0, 24) // CommonPathSuffixOffset
    if (unicode) {
      linkInfo.writeUInt32LE(linkInfoHeaderSize + ansiBytes.length, 28) // LocalBasePathOffsetUnicode
    }
    ansiBytes.copy(linkInfo, linkInfoHeaderSize)
    if (unicode) unicodeBytes.copy(linkInfo, linkInfoHeaderSize + ansiBytes.length)
    parts.push(linkInfo)
  }

  const buffer = Buffer.concat(parts)
  return options.truncateTo === undefined ? buffer : buffer.subarray(0, options.truncateTo)
}

describe('parseShortcutBuffer — valid shortcuts', () => {
  it('reads an ANSI local base path', () => {
    const result = parseShortcutBuffer(
      buildShortcut({ localBasePath: 'C:\\Program Files\\Example App\\Example.exe' })
    )
    expect(result.targetPath).toBe('C:\\Program Files\\Example App\\Example.exe')
    expect(result.reason).toBe('')
    expect(result.isDirectory).toBe(false)
  })

  it('prefers the Unicode local base path for non-ASCII install paths', () => {
    const target = 'C:\\程序目录\\示例软件\\示例.exe'
    const result = parseShortcutBuffer(buildShortcut({ localBasePath: target, unicode: true }))
    expect(result.targetPath).toBe(target)
  })

  it('skips the shell item ID list before the LinkInfo block', () => {
    const result = parseShortcutBuffer(
      buildShortcut({
        localBasePath: 'D:\\Tools\\tool.exe',
        includeIdList: true
      })
    )
    expect(result.targetPath).toBe('D:\\Tools\\tool.exe')
  })

  it('also handles writers that count the ID-list size field inside the size', () => {
    const result = parseShortcutBuffer(
      buildShortcut({
        localBasePath: 'D:\\Tools\\tool.exe',
        includeIdList: true,
        idListSizeIncludesItself: true
      })
    )
    expect(result.targetPath).toBe('D:\\Tools\\tool.exe')
  })

  it('reports the directory hint from file attributes', () => {
    const directoryShortcut = parseShortcutBuffer(
      buildShortcut({ localBasePath: 'C:\\Apps\\Example', fileAttributes: 0x10 })
    )
    expect(directoryShortcut.isDirectory).toBe(true)
    const fileShortcut = parseShortcutBuffer(buildShortcut({ fileAttributes: 0x20 }))
    expect(fileShortcut.isDirectory).toBe(false)
    const unknownShortcut = parseShortcutBuffer(buildShortcut({ fileAttributes: 0 }))
    expect(unknownShortcut.isDirectory).toBeNull()
  })
})

describe('parseShortcutBuffer — malformed shortcuts never throw', () => {
  it('rejects an empty buffer', () => {
    const result = parseShortcutBuffer(Buffer.alloc(0))
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('太小')
  })

  it('rejects a too-small buffer', () => {
    const result = parseShortcutBuffer(Buffer.alloc(40))
    expect(result.targetPath).toBeNull()
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('rejects a wrong CLSID', () => {
    const buffer = buildShortcut()
    buffer.fill(0x00, 4, 20)
    const result = parseShortcutBuffer(buffer)
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('文件标识')
  })

  it('rejects a wrong header size', () => {
    const buffer = buildShortcut()
    buffer.writeUInt32LE(0x40, 0)
    const result = parseShortcutBuffer(buffer)
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('头大小')
  })

  it('rejects a truncated file', () => {
    const result = parseShortcutBuffer(buildShortcut({ truncateTo: 90 }))
    expect(result.targetPath).toBeNull()
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('reports a shortcut without LinkInfo instead of guessing', () => {
    const result = parseShortcutBuffer(buildShortcut({ noLinkInfo: true }))
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('没有记录目标路径')
  })

  it('reports a network-only shortcut', () => {
    const result = parseShortcutBuffer(buildShortcut({ linkInfoFlags: 2 }))
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('网络')
  })

  it('never throws for arbitrary byte sequences', () => {
    for (let seed = 0; seed < 24; seed += 1) {
      const bytes = Buffer.alloc(16 + seed * 7)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (seed * 31 + index * 17) & 0xff
      }
      const result = parseShortcutBuffer(bytes)
      expect(result.targetPath === null || typeof result.targetPath === 'string').toBe(true)
      expect(typeof result.reason).toBe('string')
    }
  })

  it('rejects non-buffer input without throwing', () => {
    const result = parseShortcutBuffer('not a buffer' as unknown as Buffer)
    expect(result.targetPath).toBeNull()
  })
})

describe('parseShortcutFile', () => {
  it('reads and parses a shortcut from disk', async () => {
    const file = await writeTempFile(
      'example.lnk',
      buildShortcut({ localBasePath: 'C:\\Program Files\\Example\\Example.exe' })
    )
    const result = await parseShortcutFile(file)
    expect(result.targetPath).toBe('C:\\Program Files\\Example\\Example.exe')
    expect(result.reason).toBe('')
  })

  it('returns a readable reason for a missing file', async () => {
    const missing = join(tmpdir(), `pathkeeper-lnk-missing-${Date.now()}.lnk`)
    const result = await parseShortcutFile(missing)
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('无法读取')
  })

  it('returns a readable reason for a non-shortcut file', async () => {
    const file = await writeTempFile('not-a-link.lnk', Buffer.from('plain text content'))
    const result = await parseShortcutFile(file)
    expect(result.targetPath).toBeNull()
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('returns a readable reason when maxBytes cuts the header', async () => {
    const file = await writeTempFile('short.lnk', buildShortcut())
    const result = await parseShortcutFile(file, { maxBytes: 32 })
    expect(result.targetPath).toBeNull()
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('returns a readable reason for an empty path', async () => {
    const result = await parseShortcutFile('')
    expect(result.targetPath).toBeNull()
    expect(result.reason).toContain('路径为空')
  })
})
