/**
 * Safe reading primitives for projects that may contain very large files.
 *
 * PathKeeper 2.1 allows a single file up to 1 GB (1,048,576 KB), so the engine
 * must never blindly load a whole file into memory:
 *
 *  1. Every candidate file is first sniffed through its first 8 KB only. A NUL
 *     byte in the head (outside a UTF-16 BOM) means binary; the full file is
 *     then never read.
 *  2. Files at or below `FULL_READ_MAX_BYTES` (16 MB) are read and decoded as a
 *     whole, which keeps the existing snapshot/hash/repair path working.
 *  3. Larger files are decoded in a bounded streaming fashion (256 KB chunks,
 *     `TextDecoder` with `fatal: true`, binary NUL detection) and their lines
 *     are yielded one at a time. Callers keep only the current line, so memory
 *     stays bounded no matter whether the file is 20 MB or 1 GB.
 *  4. A global read budget (default 512 MB / 120 s) stops a scan early instead
 *     of letting a pathological project run for minutes. Exhaustion is always
 *     reported to the caller, never silently swallowed.
 *
 * Pure Node: no Electron, no database, no network.
 */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { TextDecoder } from 'node:util'
import type { FileEncoding } from '../../shared/types'
import { createAbortError } from './errors'
import { decodeTextBuffer, detectBomlessUtf16, looksBinary } from './text'

/** Bytes inspected to classify a file before deciding how to read it. */
export const HEAD_SNIFF_BYTES = 8 * 1024

/** Files up to this decoded size are read fully (snapshot + repair allowed). */
export const FULL_READ_MAX_BYTES = 16 * 1024 * 1024

/** Files above this size are report-only and get a stronger warning. */
export const REPORT_ONLY_WARN_BYTES = 64 * 1024 * 1024

/** Streaming read chunk. Keeps peak memory in the low hundreds of KB. */
export const STREAM_CHUNK_BYTES = 256 * 1024

/** A single line without a newline is force-flushed at this length. */
export const MAX_PENDING_LINE_CHARS = 1_048_576

/** Dependency health checks never JSON-parse files above this size. */
export const MAX_JSON_PARSE_BYTES = 8 * 1024 * 1024

/** Whole-file SHA-256 is only computed below this size. */
export const MAX_STREAM_HASH_BYTES = 128 * 1024 * 1024

/** Default global scan budget: 512 MB of file reads. */
export const DEFAULT_SCAN_BUDGET_BYTES = 512 * 1024 * 1024

/** Default global scan budget: 120 seconds of wall-clock time. */
export const DEFAULT_SCAN_BUDGET_MS = 120_000

export interface ScanBudgetOptions {
  /** Maximum bytes the whole scan may read. Defaults to 512 MB. */
  maxBytes?: number
  /** Maximum wall-clock duration in milliseconds. Defaults to 120 s. */
  maxDurationMs?: number
}

export interface ReadBudget {
  maxBytes: number
  maxDurationMs: number
  bytesRead: number
  startedAt: number
  /** True once a limit has been reached; callers must stop reading. */
  exhausted: boolean
}

/** Create a fresh budget object for one scan pass. */
export function createReadBudget(options?: ScanBudgetOptions | null): ReadBudget {
  const maxBytes =
    typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_SCAN_BUDGET_BYTES
  const maxDurationMs =
    typeof options?.maxDurationMs === 'number' &&
    Number.isFinite(options.maxDurationMs) &&
    options.maxDurationMs > 0
      ? Math.floor(options.maxDurationMs)
      : DEFAULT_SCAN_BUDGET_MS
  return {
    maxBytes,
    maxDurationMs,
    bytesRead: 0,
    startedAt: Date.now(),
    exhausted: false
  }
}

/**
 * Charge `bytes` against the budget. Returns false when the budget is (or just
 * became) exhausted; the read that was charged is still counted.
 */
export function chargeRead(budget: ReadBudget | null | undefined, bytes: number): boolean {
  if (!budget) return true
  if (budget.exhausted) return false
  if (Number.isFinite(bytes) && bytes > 0) budget.bytesRead += Math.floor(bytes)
  if (
    budget.bytesRead > budget.maxBytes ||
    Date.now() - budget.startedAt > budget.maxDurationMs
  ) {
    budget.exhausted = true
  }
  return !budget.exhausted
}

export function budgetExhausted(budget: ReadBudget | null | undefined): boolean {
  return budget?.exhausted === true
}

/* ------------------------------------------------------------------ */
/* Head sniff                                                          */
/* ------------------------------------------------------------------ */

export type ProbeEncoding = FileEncoding | 'binary' | 'unsupported'

export interface TextFileProbe {
  /** Detected encoding, or why the file must be skipped. */
  encoding: ProbeEncoding
  /** Number of head bytes actually read (0 for an empty file). */
  headBytes: number
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * Validate that `buffer` is a plausible UTF-8 prefix. `stream: true` tolerates
 * a multi-byte character cut at the end of the head, which is expected because
 * the real file may continue past the sniff window.
 */
function isValidUtf8Prefix(buffer: Buffer): boolean {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    decoder.decode(buffer, { stream: true })
    return true
  } catch {
    return false
  }
}

/**
 * Classify a file from its first bytes only. The order matters: a UTF-16 BOM
 * or BOM-less UTF-16 heuristic wins over the "NUL means binary" rule because
 * UTF-16 text legitimately contains NUL bytes.
 */
export function classifyHead(head: Buffer): TextFileProbe {
  const headBytes = head.length
  if (headBytes === 0) return { encoding: 'utf8', headBytes }
  if (headBytes >= 3 && head.subarray(0, 3).equals(UTF8_BOM)) {
    return { encoding: 'utf8-bom', headBytes }
  }
  if (headBytes >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { encoding: 'utf16le', headBytes }
  }
  if (headBytes >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { encoding: 'utf16be', headBytes }
  }
  const bomless = detectBomlessUtf16(head)
  if (bomless !== null) return { encoding: bomless, headBytes }
  if (looksBinary(head)) return { encoding: 'binary', headBytes }
  if (!isValidUtf8Prefix(head)) return { encoding: 'unsupported', headBytes }
  return { encoding: 'utf8', headBytes }
}

/**
 * Read at most `HEAD_SNIFF_BYTES` and classify the file. This is the only read
 * performed for binary files; callers must check `encoding` before reading
 * further. Read errors are thrown so the caller can produce a warning.
 */
export async function probeTextFile(
  filePath: string,
  budget?: ReadBudget | null
): Promise<TextFileProbe> {
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_SNIFF_BYTES)
    const result = await handle.read(buffer, 0, HEAD_SNIFF_BYTES, 0)
    chargeRead(budget, result.bytesRead)
    return classifyHead(buffer.subarray(0, result.bytesRead))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* Full read (small files only)                                        */
/* ------------------------------------------------------------------ */

export type FullTextRead =
  | { kind: 'text'; text: string; encoding: FileEncoding; buffer: Buffer }
  | { kind: 'binary' }
  | { kind: 'unsupported' }
  | { kind: 'budget-exhausted' }

/**
 * Read and decode a whole file. Only call this after a head sniff showed text
 * and the file is small enough (`FULL_READ_MAX_BYTES`). The raw buffer is
 * returned so the caller can hash it without reading the file twice.
 */
export async function readFullTextFile(
  filePath: string,
  budget?: ReadBudget | null
): Promise<FullTextRead> {
  const buffer = await fsp.readFile(filePath)
  if (!chargeRead(budget, buffer.length)) return { kind: 'budget-exhausted' }
  const decoded = decodeTextBuffer(buffer)
  if (decoded === null) {
    return looksBinary(buffer) ? { kind: 'binary' } : { kind: 'unsupported' }
  }
  return { kind: 'text', text: decoded.text, encoding: decoded.encoding, buffer }
}

/* ------------------------------------------------------------------ */
/* Streaming (large files only)                                        */
/* ------------------------------------------------------------------ */

const STREAM_BINARY_MESSAGE = '文件在读取过程中出现二进制内容，已停止流式扫描。'
const STREAM_ENCODING_MESSAGE = '文件不是可识别的文本编码，已停止流式扫描。'

/** Thrown when a streaming read discovers binary content past the head. */
export class StreamBinaryError extends Error {
  constructor(message = STREAM_BINARY_MESSAGE) {
    super(message)
    this.name = 'StreamBinaryError'
  }
}

/** Thrown when a streaming decoder rejects the file encoding. */
export class StreamEncodingError extends Error {
  constructor(message = STREAM_ENCODING_MESSAGE) {
    super(message)
    this.name = 'StreamEncodingError'
  }
}

export interface TextStreamLine {
  /** Line text without the trailing newline / carriage return. */
  text: string
  /** 1-based line number in the decoded stream. */
  lineNumber: number
  /** Character offset of this line start in the decoded stream. */
  offset: number
}

export interface StreamTextOptions {
  signal?: AbortSignal
  budget?: ReadBudget | null
  chunkBytes?: number
}

function decoderFor(encoding: FileEncoding): TextDecoder {
  switch (encoding) {
    case 'utf16le':
      return new TextDecoder('utf-16le', { fatal: true })
    case 'utf16be':
      return new TextDecoder('utf-16be', { fatal: true })
    default:
      return new TextDecoder('utf-8', { fatal: true })
  }
}

function stripTrailingCr(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value
}

/**
 * Decode a file incrementally and yield it line by line with bounded memory.
 *
 * Stops early (without throwing) when the shared read budget is exhausted;
 * callers must check `budgetExhausted(budget)` afterwards. Aborts throw an
 * `AbortError`, binary/encoding problems throw typed errors above.
 */
export async function* streamTextLines(
  filePath: string,
  encoding: FileEncoding,
  options: StreamTextOptions = {}
): AsyncGenerator<TextStreamLine, void, void> {
  const signal = options.signal
  const budget = options.budget ?? null
  const chunkBytes = Math.max(4096, Math.floor(options.chunkBytes ?? STREAM_CHUNK_BYTES))
  const decoder = decoderFor(encoding)
  const stream = createReadStream(filePath, { highWaterMark: chunkBytes })

  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw createAbortError()
  }

  let pendingLine = ''
  let lineNumber = 0
  let lineStartOffset = 0

  const decodeChunk = (chunk: Buffer, final: boolean): string => {
    let text: string
    try {
      text = decoder.decode(chunk, { stream: !final })
    } catch {
      throw new StreamEncodingError()
    }
    if (text.includes('\u0000')) throw new StreamBinaryError()
    return text
  }

  try {
    for await (const rawChunk of stream) {
      throwIfAborted()
      const chunk = rawChunk as Buffer
      if (!chargeRead(budget, chunk.length)) return
      pendingLine += decodeChunk(chunk, false)

      let newlineIndex = pendingLine.indexOf('\n')
      while (newlineIndex !== -1) {
        yield {
          text: stripTrailingCr(pendingLine.slice(0, newlineIndex)),
          lineNumber: lineNumber + 1,
          offset: lineStartOffset
        }
        lineStartOffset += newlineIndex + 1
        lineNumber += 1
        pendingLine = pendingLine.slice(newlineIndex + 1)
        newlineIndex = pendingLine.indexOf('\n')
      }

      // A single "line" longer than the cap is flushed as a pseudo-line so a
      // minified/one-line 1 GB file cannot grow the pending string without
      // bound. Such a file is report-only anyway.
      if (pendingLine.length > MAX_PENDING_LINE_CHARS) {
        yield {
          text: pendingLine,
          lineNumber: lineNumber + 1,
          offset: lineStartOffset
        }
        lineStartOffset += pendingLine.length
        lineNumber += 1
        pendingLine = ''
      }
      throwIfAborted()
    }

    throwIfAborted()
    const tail = decodeChunk(Buffer.alloc(0), true)
    if (tail.length > 0) pendingLine += tail
    if (pendingLine.length > 0) {
      yield {
        text: stripTrailingCr(pendingLine),
        lineNumber: lineNumber + 1,
        offset: lineStartOffset
      }
    }
  } finally {
    stream.destroy()
  }
}

/** Whether a streaming head-detected encoding can be streamed. */
export function isStreamableEncoding(encoding: ProbeEncoding): encoding is FileEncoding {
  return encoding === 'utf8' || encoding === 'utf8-bom' || encoding === 'utf16le' || encoding === 'utf16be'
}

/* ------------------------------------------------------------------ */
/* Streaming hash (dependency health)                                  */
/* ------------------------------------------------------------------ */

/**
 * Hash a whole file without loading it into memory. Returns null when the
 * shared budget stopped the read early.
 */
export async function hashFileStreaming(
  filePath: string,
  options: StreamTextOptions = {}
): Promise<string | null> {
  const signal = options.signal
  const budget = options.budget ?? null
  const chunkBytes = Math.max(4096, Math.floor(options.chunkBytes ?? STREAM_CHUNK_BYTES))
  const stream = createReadStream(filePath, { highWaterMark: chunkBytes })
  const hash = createHash('sha256')
  try {
    for await (const rawChunk of stream) {
      if (signal?.aborted === true) throw createAbortError()
      const chunk = rawChunk as Buffer
      if (!chargeRead(budget, chunk.length)) return null
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}
