/**
 * Text decoding / encoding and edit application.
 *
 * The scanner must never corrupt a file: it decodes buffers to UTF-8 strings,
 * rewrites only matched spans, and re-encodes with the detected original
 * encoding (UTF-8, UTF-8 with BOM, UTF-16 LE, UTF-16 BE).
 */

import type { FileEncoding } from '../../shared/types'

export interface DecodedText {
  text: string
  encoding: FileEncoding
}

export interface TextEdit {
  offset: number
  length: number
  oldText: string
  newText: string
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM_0 = 0xff
const UTF16LE_BOM_1 = 0xfe
const UTF16BE_BOM_0 = 0xfe
const UTF16BE_BOM_1 = 0xff

/** NUL bytes are a reliable and cheap binary signal for candidate text files. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0)
}

function isValidUtf8(buffer: Buffer, text: string): boolean {
  return Buffer.from(text, 'utf8').equals(buffer)
}

/** Binary-ish UTF-16: decoded NULs mean the payload was not really text. */
function isPlausibleUtf16Text(text: string): boolean {
  return !text.includes('\u0000')
}

function decodeUtf16Body(body: Buffer, encoding: 'utf16le' | 'utf16be'): string | null {
  if (body.length % 2 !== 0) return null
  if (encoding === 'utf16le') {
    const text = body.toString('utf16le')
    if (!isPlausibleUtf16Text(text)) return null
    if (!Buffer.from(text, 'utf16le').equals(body)) return null
    return text
  }
  const swapped = Buffer.from(body)
  swapped.swap16()
  const text = swapped.toString('utf16le')
  if (!isPlausibleUtf16Text(text)) return null
  const roundTrip = Buffer.from(text, 'utf16le')
  roundTrip.swap16()
  if (!roundTrip.equals(body)) return null
  return text
}

/**
 * Heuristic for BOM-less UTF-16: one byte of every pair is zero for ASCII
 * content. Only accepted when the round-trip through the encoding matches.
 */
export function detectBomlessUtf16(buffer: Buffer): 'utf16le' | 'utf16be' | null {
  if (buffer.length < 4 || buffer.length % 2 !== 0) return null
  const pairs = buffer.length / 2
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < pairs; index += 1) {
    if (buffer[index * 2] === 0) evenZeros += 1
    if (buffer[index * 2 + 1] === 0) oddZeros += 1
  }
  const highThreshold = Math.max(2, Math.floor(pairs * 0.6))
  const lowThreshold = Math.floor(pairs * 0.15)
  if (oddZeros >= highThreshold && evenZeros <= lowThreshold) {
    if (decodeUtf16Body(buffer, 'utf16le') !== null) return 'utf16le'
  }
  if (evenZeros >= highThreshold && oddZeros <= lowThreshold) {
    if (decodeUtf16Body(buffer, 'utf16be') !== null) return 'utf16be'
  }
  return null
}

/**
 * Decode a file buffer. Returns `null` for binary content, NUL-containing
 * content and text in an encoding the tool cannot safely preserve
 * (anything other than UTF-8 / UTF-8 BOM / UTF-16 LE / UTF-16 BE).
 */
export function decodeTextBuffer(buffer: Buffer): DecodedText | null {
  if (!Buffer.isBuffer(buffer)) return null
  if (buffer.length === 0) return { text: '', encoding: 'utf8' }

  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    const body = buffer.subarray(3)
    const text = body.toString('utf8')
    if (looksBinary(body)) return null
    if (!isValidUtf8(body, text)) return null
    return { text, encoding: 'utf8-bom' }
  }

  if (buffer[0] === UTF16LE_BOM_0 && buffer[1] === UTF16LE_BOM_1) {
    const text = decodeUtf16Body(buffer.subarray(2), 'utf16le')
    if (text === null) return null
    return { text, encoding: 'utf16le' }
  }

  if (buffer[0] === UTF16BE_BOM_0 && buffer[1] === UTF16BE_BOM_1) {
    const text = decodeUtf16Body(buffer.subarray(2), 'utf16be')
    if (text === null) return null
    return { text, encoding: 'utf16be' }
  }

  // BOM-less UTF-16 must be detected before treating the NUL bytes as binary.
  const bomless = detectBomlessUtf16(buffer)
  if (bomless === 'utf16le') {
    const text = decodeUtf16Body(buffer, 'utf16le')
    if (text !== null) return { text, encoding: 'utf16le' }
  }
  if (bomless === 'utf16be') {
    const text = decodeUtf16Body(buffer, 'utf16be')
    if (text !== null) return { text, encoding: 'utf16be' }
  }

  if (looksBinary(buffer)) return null

  const utf8Text = buffer.toString('utf8')
  if (isValidUtf8(buffer, utf8Text)) {
    return { text: utf8Text, encoding: 'utf8' }
  }

  return null
}

/** Encode text back to the given encoding (`utf16*` files keep their BOM). */
export function encodeTextBuffer(text: string, encoding: FileEncoding): Buffer {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be': {
      const littleEndian = Buffer.from(text, 'utf16le')
      littleEndian.swap16()
      return Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian])
    }
    default:
      return Buffer.from(text, 'utf8')
  }
}

/**
 * Apply replacements by character offset. Invalid edits (negative/NaN/out of
 * range) are ignored and overlapping edits are applied greedily by start
 * offset, preferring the longer span when two edits share a start. Returns the
 * number of edits actually applied.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): { text: string; applied: number } {
  if (typeof text !== 'string' || !Array.isArray(edits) || edits.length === 0) {
    return { text, applied: 0 }
  }
  const valid: TextEdit[] = []
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null) continue
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length)) continue
    if (edit.offset < 0 || edit.length < 0) continue
    if (edit.offset + edit.length > text.length) continue
    if (typeof edit.newText !== 'string') continue
    valid.push(edit)
  }
  valid.sort((left, right) => left.offset - right.offset || right.length - left.length)

  const chunks: string[] = []
  let cursor = 0
  let applied = 0
  for (const edit of valid) {
    if (edit.offset < cursor) continue
    chunks.push(text.slice(cursor, edit.offset), edit.newText)
    cursor = edit.offset + edit.length
    applied += 1
  }
  chunks.push(text.slice(cursor))
  return { text: chunks.join(''), applied }
}

/** Offsets (in UTF-16 code units) at which each line starts. */
export function buildLineStarts(text: string): number[] {
  const starts: number[] = [0]
  if (typeof text !== 'string') return starts
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

/** 1-based line/column for an offset, using a precomputed line-start table. */
export function lineColumnFromStarts(
  lineStarts: readonly number[],
  offset: number
): { line: number; column: number } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const start = lineStarts[mid] ?? 0
    if (start <= safeOffset) low = mid + 1
    else high = mid - 1
  }
  const lineIndex = Math.max(0, high)
  const lineStart = lineStarts[lineIndex] ?? 0
  return { line: lineIndex + 1, column: safeOffset - lineStart + 1 }
}

/** Convenience wrapper: 1-based line/column for a raw offset. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  return lineColumnFromStarts(buildLineStarts(text), offset)
}

/**
 * Single-line context: up to `radius` characters before and after the matched
 * span, never crossing the line boundaries. The matched text is included.
 */
export function extractLineContext(
  text: string,
  lineStarts: readonly number[],
  offset: number,
  length: number,
  radius = 50
): string {
  const { line } = lineColumnFromStarts(lineStarts, offset)
  const lineStart = lineStarts[line - 1] ?? 0
  const nextLineStart = line < lineStarts.length ? (lineStarts[line] ?? text.length) : text.length
  let lineEndExclusive: number = nextLineStart
  if (lineEndExclusive > lineStart && text.charCodeAt(lineEndExclusive - 1) === 10) {
    lineEndExclusive -= 1
  }
  if (lineEndExclusive > lineStart && text.charCodeAt(lineEndExclusive - 1) === 13) {
    lineEndExclusive -= 1
  }
  const safeOffset = Math.max(0, Math.min(offset, text.length))
  const safeEnd = Math.max(safeOffset, Math.min(safeOffset + Math.max(0, length), lineEndExclusive))
  const beforeStart = Math.max(lineStart, safeOffset - radius)
  const afterEnd = Math.min(lineEndExclusive, safeEnd + radius)
  const raw =
    text.slice(beforeStart, safeOffset) + text.slice(safeOffset, safeEnd) + text.slice(safeEnd, afterEnd)
  return raw.replace(/[\r\n]+/g, ' ')
}
