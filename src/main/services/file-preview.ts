/**
 * Read-only file previews for beginner candidate cards.
 *
 * The renderer must never read files itself, so this tiny service returns a
 * bounded preview: a small image data URL, or the first lines of a text file.
 * Nothing is cached, nothing is written and the project root is enforced.
 */

import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'
import type { FilePreview } from '../../shared/types'
import { decodeTextBuffer } from '../core'
import { detectPathKind, resolveProjectPath } from './file-ops'

/** Only these image formats are previewed, and never above this size. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** Read at most this much of a text file; a preview only needs a few lines. */
const MAX_TEXT_BYTES = 64 * 1024
const PREVIEW_LINE_COUNT = 3
const MAX_LINE_LENGTH = 240

function unavailable(reason: string, size = 0): FilePreview {
  return { kind: 'unavailable', dataUrl: null, lines: [], size, reason }
}

function trimLine(line: string): string {
  const trimmed = line.replace(/\s+$/, '')
  if (trimmed.length <= MAX_LINE_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_LINE_LENGTH - 1)}…`
}

async function readHead(absPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fsp.open(absPath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const result = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Preview a project file. Throws only for paths outside the project root
 * (reused AppError); every other problem degrades to `unavailable`.
 */
export async function previewProjectFile(
  projectRoot: string,
  relativePath: string
): Promise<FilePreview> {
  const { absPath } = resolveProjectPath(projectRoot, relativePath)
  if (detectPathKind(absPath) !== 'file') {
    return unavailable('这个位置不是文件，无法预览。')
  }

  let size = 0
  try {
    size = (await fsp.stat(absPath)).size
  } catch {
    return unavailable('读取文件信息失败，可能文件已被移动。')
  }

  const extension = nodePath.extname(absPath).toLowerCase()
  const mime = IMAGE_MIME[extension]
  if (mime) {
    if (size > MAX_IMAGE_BYTES) {
      return unavailable('图片超过 2 MB，为了保持界面流畅，暂不生成缩略图。', size)
    }
    try {
      const buffer = await fsp.readFile(absPath)
      return {
        kind: 'image',
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        lines: [],
        size,
        reason: null
      }
    } catch {
      return unavailable('读取图片失败，可能文件被占用。', size)
    }
  }

  if (size > MAX_TEXT_BYTES) {
    return unavailable('文件较大，暂不生成文字预览。', size)
  }

  try {
    const head = await readHead(absPath, Math.min(size, MAX_TEXT_BYTES))
    const decoded = decodeTextBuffer(head)
    if (!decoded) {
      return unavailable('这看起来是二进制文件，无法显示文字预览。', size)
    }
    const lines = decoded.text
      .split(/\r\n|\r|\n/)
      .slice(0, PREVIEW_LINE_COUNT)
      .map(trimLine)
    return { kind: 'text', dataUrl: null, lines, size, reason: null }
  } catch {
    return unavailable('读取文件失败，可能文件被其他程序占用。', size)
  }
}
