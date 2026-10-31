/**
 * Deterministic project scanner.
 *
 * Pure Node: no Electron, no database, no network. Walks the project (without
 * following symlinks), applies the enabled match rules, rejects unsafe
 * reference candidates, deduplicates overlapping captures and returns every
 * replacement plus per-file SHA-256 snapshots for stale-scan protection.
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'
import type {
  FileEncoding,
  IgnoreRule,
  MatchMode,
  MatchModes,
  MatchRule,
  PathKindInput,
  ScanOccurrence,
  ScanProgress,
  ScanResult
} from '../../shared/types'
import { CoreError, createAbortError, errorMessage, isAbortError } from './errors'
import { createIgnoreEvaluator, type IgnoreEvaluator } from './ignore'
import { evaluateReference, type MigrationTarget } from './match'
import { resolveMigrationPaths, resolveProjectRoot } from './path'
import {
  captureSpan,
  compileMatchRule,
  validateMatchRule,
  type CompiledRule
} from './rules'
import {
  budgetExhausted,
  createReadBudget,
  FULL_READ_MAX_BYTES,
  isStreamableEncoding,
  probeTextFile,
  readFullTextFile,
  REPORT_ONLY_WARN_BYTES,
  streamTextLines,
  StreamBinaryError,
  StreamEncodingError,
  type ReadBudget,
  type ScanBudgetOptions,
  type TextFileProbe,
  type TextStreamLine
} from './safeRead'
import {
  buildLineStarts,
  extractLineContext,
  lineColumnFromStarts
} from './text'

export interface ScanSnapshot {
  /** Absolute native path (used by the backend to verify stale files). */
  filePath: string
  size: number
  mtimeMs: number
  /** Lowercase hex SHA-256 of the raw file bytes. */
  hash: string
}

export interface EngineScanResult extends ScanResult {
  snapshots: ScanSnapshot[]
}

export interface ScanProjectOptions {
  projectId: number
  projectName: string
  projectRoot: string
  oldPath: string
  newPath: string
  kind: PathKindInput
  modes: MatchModes
  rules: MatchRule[]
  ignoreRules: IgnoreRule[]
  caseSensitive: boolean
  maxFileSizeKb: number
  /** Optional global read budget; defaults to 512 MB / 120 s. */
  budget?: ScanBudgetOptions
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
}

/** 1 GB is the supported ceiling for a single file, not a recommendation. */
const DEFAULT_MAX_FILE_SIZE_KB = 1_048_576
const MAX_WARNINGS = 400
const MAX_MATCHES_PER_RULE_PER_FILE = 10_000
const MAX_OCCURRENCES_PER_FILE = 20_000
const READ_CONCURRENCY = 8
const PROGRESS_INTERVAL_MS = 40
const WALK_PROGRESS_PERCENT = 3
const SCAN_PROGRESS_START = 5
const SCAN_PROGRESS_END = 95

interface PreparedRule {
  rule: MatchRule
  compiled: CompiledRule
}

interface WalkedFile {
  absolutePath: string
  /** Project-relative POSIX path. */
  relativePath: string
  size: number
  mtimeMs: number
}

interface RawHit {
  start: number
  end: number
  rule: MatchRule
  oldText: string
  newText: string
  matchMode: MatchMode
  matchText: string
}

interface FileScanOutcome {
  snapshot: ScanSnapshot | null
  occurrences: ScanOccurrence[]
  skipped: boolean
  skipReason: string | null
  /** True when the file content was read successfully (small full read or streamed). */
  scanned: boolean
  /** True when the global read budget stopped this file. */
  budgetExceeded: boolean
}

interface EngineContext {
  projectRootAbs: string
  target: MigrationTarget
  rules: PreparedRule[]
  ignore: IgnoreEvaluator
  maxFileBytes: number
  budget: ReadBudget
  warnings: string[]
  warningLimitReached: boolean
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  lastProgressAt: number
  lastPercent: number
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function rulePriority(rule: MatchRule): number {
  return typeof rule.priority === 'number' && Number.isFinite(rule.priority) ? rule.priority : 0
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function addWarning(context: EngineContext, message: string): void {
  if (context.warnings.length < MAX_WARNINGS) {
    context.warnings.push(message)
    return
  }
  if (!context.warningLimitReached) {
    context.warningLimitReached = true
    context.warnings.push('警告数量过多，后续警告已省略。')
  }
}

function throwIfAborted(context: EngineContext): void {
  if (context.signal?.aborted === true) throw createAbortError()
}

function emitProgress(
  context: EngineContext,
  phase: ScanProgress['phase'],
  filesScanned: number,
  filesTotal: number,
  currentFile: string | null,
  percent: number,
  force = false
): void {
  if (!context.onProgress) return
  const now = Date.now()
  if (!force && now - context.lastProgressAt < PROGRESS_INTERVAL_MS) return
  context.lastProgressAt = now
  const monotonicPercent = Math.max(context.lastPercent, Math.min(100, Math.max(0, percent)))
  context.lastPercent = monotonicPercent
  try {
    context.onProgress({ phase, filesScanned, filesTotal, currentFile, percent: monotonicPercent })
  } catch {
    // A broken progress listener must never fail the scan.
  }
}

function normalizeModes(modes: MatchModes | undefined): MatchModes {
  if (!modes || typeof modes !== 'object') {
    return { strict: true, basename: true, directory: true }
  }
  return {
    strict: modes.strict === true,
    basename: modes.basename === true,
    directory: modes.directory === true
  }
}

function normalizeMaxFileSizeKb(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value))
  }
  return DEFAULT_MAX_FILE_SIZE_KB
}

function prepareRules(context: EngineContext, rules: readonly MatchRule[]): PreparedRule[] {
  const enabled = (Array.isArray(rules) ? rules : []).filter(
    (rule): rule is MatchRule => Boolean(rule) && rule.enabled === true
  )
  enabled.sort(
    (left, right) =>
      rulePriority(right) - rulePriority(left) ||
      compareText(left.ruleKey ?? '', right.ruleKey ?? '') ||
      (left.id ?? 0) - (right.id ?? 0)
  )
  const prepared: PreparedRule[] = []
  for (const rule of enabled) {
    try {
      const validation = validateMatchRule(rule.pattern, rule.flags)
      if (!validation.valid) {
        addWarning(context, `规则“${rule.name}”已跳过：${validation.error ?? '配置无效。'}`)
        continue
      }
      const compiled = compileMatchRule(rule.pattern, rule.flags)
      prepared.push({ rule, compiled })
    } catch (error) {
      addWarning(context, `规则“${rule.name}”已跳过：${errorMessage(error)}`)
    }
  }
  return prepared
}

async function walkProject(
  context: EngineContext
): Promise<{ files: WalkedFile[]; ignoredFiles: number }> {
  const files: WalkedFile[] = []
  let ignoredFiles = 0

  emitProgress(context, 'walking', 0, 0, null, WALK_PROGRESS_PERCENT, true)

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    throwIfAborted(context)
    emitProgress(
      context,
      'walking',
      0,
      0,
      relativeDir.length > 0 ? relativeDir : null,
      WALK_PROGRESS_PERCENT
    )
    let entries
    try {
      entries = await fsp.readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      addWarning(context, `无法读取目录 ${relativeDir.length > 0 ? relativeDir : '.'}：${errorMessage(error)}`)
      return
    }
    entries.sort((left, right) => compareText(left.name, right.name))

    for (const entry of entries) {
      throwIfAborted(context)
      const name = entry.name
      const absolutePath = nodePath.join(absoluteDir, name)
      const relativePath = relativeDir.length === 0 ? name : `${relativeDir}/${name}`

      if (entry.isSymbolicLink()) {
        // Never follow symlinks (Windows junctions included).
        ignoredFiles += 1
        continue
      }
      if (entry.isDirectory()) {
        if (context.ignore.isIgnoredDirectory(name, relativePath)) {
          ignoredFiles += 1
          continue
        }
        await walk(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) {
        ignoredFiles += 1
        continue
      }
      if (context.ignore.isIgnoredFile(relativePath, name)) {
        ignoredFiles += 1
        continue
      }
      let stats
      try {
        stats = await fsp.stat(absolutePath)
      } catch (error) {
        ignoredFiles += 1
        addWarning(context, `无法获取文件信息 ${relativePath}：${errorMessage(error)}`)
        continue
      }
      files.push({
        absolutePath,
        relativePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs
      })
    }
  }

  await walk(context.projectRootAbs, '')
  files.sort((left, right) => compareText(left.relativePath, right.relativePath))
  return { files, ignoredFiles }
}

function cloneCompiledRule(compiled: CompiledRule): CompiledRule {
  return {
    regex: new RegExp(compiled.regex.source, compiled.regex.flags),
    captureGroup: compiled.captureGroup,
    captureName: compiled.captureName,
    captureIndex: compiled.captureIndex
  }
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end
}

function dedupeHits(hits: RawHit[]): RawHit[] {
  const sorted = [...hits].sort(
    (left, right) =>
      rulePriority(right.rule) - rulePriority(left.rule) ||
      right.end - right.start - (left.end - left.start) ||
      left.start - right.start ||
      left.rule.id - right.rule.id ||
      compareText(left.rule.ruleKey ?? '', right.rule.ruleKey ?? '')
  )
  const accepted: RawHit[] = []
  for (const hit of sorted) {
    let conflict = false
    for (const kept of accepted) {
      if (overlaps(hit, kept)) {
        conflict = true
        break
      }
    }
    if (!conflict) accepted.push(hit)
  }
  accepted.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      compareText(left.rule.ruleKey ?? '', right.rule.ruleKey ?? '') ||
      left.rule.id - right.rule.id
  )
  return accepted
}

/**
 * Stable occurrence id. `offsetSalt` is non-zero for streamed (report-only)
 * files, where `hit.start` is relative to a single line and would otherwise
 * collide across lines.
 */
function occurrenceId(relativePath: string, hit: RawHit, offsetSalt = 0): string {
  const digest = createHash('sha256')
    .update(relativePath)
    .update('\u0000')
    .update(String(hit.start + offsetSalt))
    .update('\u0000')
    .update(hit.oldText)
    .update('\u0000')
    .update(hit.newText)
    .update('\u0000')
    .update(hit.rule.ruleKey ?? String(hit.rule.id))
    .digest('hex')
  return `occ_${digest.slice(0, 20)}`
}

const SINGLE_LINE_STARTS: readonly number[] = [0]

function buildOccurrence(
  text: string,
  lineStarts: readonly number[],
  relativePath: string,
  hit: RawHit
): ScanOccurrence {
  const { line, column } = lineColumnFromStarts(lineStarts, hit.start)
  return {
    id: occurrenceId(relativePath, hit),
    filePath: relativePath,
    line,
    column,
    ruleId: hit.rule.id,
    ruleKey: hit.rule.ruleKey,
    ruleName: hit.rule.name,
    ruleCategory: hit.rule.category,
    matchMode: hit.matchMode,
    snippet: truncate(hit.matchText.trim(), 240),
    oldText: hit.oldText,
    newText: hit.newText,
    context: extractLineContext(text, lineStarts, hit.start, hit.end - hit.start),
    offset: hit.start,
    length: hit.end - hit.start
  }
}

/**
 * Build an occurrence for a streamed line. The reported `offset` is a
 * best-effort position in the decoded stream; large streamed files are
 * report-only (no snapshot), so the backend never rewrites those offsets.
 */
function buildLineOccurrence(
  line: TextStreamLine,
  relativePath: string,
  hit: RawHit
): ScanOccurrence {
  return {
    id: occurrenceId(relativePath, hit, line.offset),
    filePath: relativePath,
    line: line.lineNumber,
    column: hit.start + 1,
    ruleId: hit.rule.id,
    ruleKey: hit.rule.ruleKey,
    ruleName: hit.rule.name,
    ruleCategory: hit.rule.category,
    matchMode: hit.matchMode,
    snippet: truncate(hit.matchText.trim(), 240),
    oldText: hit.oldText,
    newText: hit.newText,
    context: extractLineContext(line.text, SINGLE_LINE_STARTS, hit.start, hit.end - hit.start),
    offset: line.offset + hit.start,
    length: hit.end - hit.start
  }
}

/** Characters that end an unquoted token; used for URL/template context checks. */
const TOKEN_BREAK = /[\s"'`]/

/**
 * A rule may capture only the tail of a URL or template reference (for
 * example `example.com/a.png` inside `https://example.com/a.png`). Such spans
 * must never be rewritten even though the captured text itself looks like a
 * path, so inspect the unquoted token prefix before accepting a candidate.
 */
function hasUnsafeTokenPrefix(text: string, start: number): boolean {
  let tokenStart = start
  while (tokenStart > 0) {
    const character = text[tokenStart - 1]
    if (character === undefined || TOKEN_BREAK.test(character)) break
    tokenStart -= 1
  }
  const prefix = text.slice(tokenStart, start)
  if (prefix.length === 0) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(prefix)) return true
  if (prefix.includes('://')) return true
  // Also catch captures that start at the second slash of a protocol URL.
  if (prefix.includes(':/')) return true
  if (prefix.includes('${')) return true
  if (prefix.includes('{{') || prefix.includes('}}')) return true
  if (prefix.includes('%')) return true
  if (prefix.includes('$')) return true
  // Protocol-ish prefixes such as `mailto:` (a Windows drive prefix `C:` is
  // allowed because the rules capture the drive together with the path).
  if (prefix.endsWith(':') && !/^[A-Za-z]:$/.test(prefix)) return true
  return false
}

/** Run every enabled rule over `text` and return the accepted raw hits. */
function collectRawHits(context: EngineContext, text: string, relativePath: string): RawHit[] {
  const hits: RawHit[] = []

  outer: for (const prepared of context.rules) {
    const compiled = cloneCompiledRule(prepared.compiled)
    const regex = compiled.regex
    let matchesInFile = 0
    let guard = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      guard += 1
      if ((guard & 0x3ff) === 0) throwIfAborted(context)
      if (match[0].length === 0) {
        if (regex.lastIndex >= text.length) break
        regex.lastIndex += 1
        continue
      }
      const span = captureSpan(match, compiled)
      if (!span) continue
      // Trim insignificant whitespace captured by lenient rules, while keeping
      // offsets tight so surrounding whitespace is never rewritten.
      const rawSpan = text.slice(span.start, span.end)
      const leading = rawSpan.length - rawSpan.trimStart().length
      const trailing = rawSpan.length - rawSpan.trimEnd().length
      const start = span.start + leading
      const end = span.end - trailing
      if (end <= start) continue
      if (hasUnsafeTokenPrefix(text, start)) continue
      const raw = text.slice(start, end)
      const evaluation = evaluateReference(raw, relativePath, context.target)
      if (!evaluation) continue

      hits.push({
        start,
        end,
        rule: prepared.rule,
        oldText: evaluation.oldText,
        newText: evaluation.newText,
        matchMode: evaluation.matchMode,
        matchText: match[0]
      })
      matchesInFile += 1

      if (matchesInFile >= MAX_MATCHES_PER_RULE_PER_FILE) {
        addWarning(
          context,
          `规则“${prepared.rule.name}”在 ${relativePath} 中匹配过多（超过 ${MAX_MATCHES_PER_RULE_PER_FILE} 处），已截断。`
        )
        break
      }
      if (hits.length >= MAX_OCCURRENCES_PER_FILE) {
        addWarning(context, `文件 ${relativePath} 中的待替换位置过多，已截断。`)
        break outer
      }
    }
  }

  return hits
}

function collectOccurrences(
  context: EngineContext,
  text: string,
  relativePath: string
): ScanOccurrence[] {
  const accepted = dedupeHits(collectRawHits(context, text, relativePath))
  if (accepted.length === 0) return []
  const lineStarts = buildLineStarts(text)
  return accepted.map((hit) => buildOccurrence(text, lineStarts, relativePath, hit))
}

/** Extract occurrences from one streamed line (report-only large files). */
function collectLineOccurrences(
  context: EngineContext,
  line: TextStreamLine,
  relativePath: string
): ScanOccurrence[] {
  const accepted = dedupeHits(collectRawHits(context, line.text, relativePath))
  if (accepted.length === 0) return []
  return accepted.map((hit) => buildLineOccurrence(line, relativePath, hit))
}

function skippedOutcome(reason: string | null, budgetExceeded = false): FileScanOutcome {
  return {
    snapshot: null,
    occurrences: [],
    skipped: true,
    skipReason: reason,
    scanned: false,
    budgetExceeded
  }
}

const BINARY_SKIP = (relativePath: string): string =>
  `疑似二进制文件，已跳过：${relativePath}`
const UNSUPPORTED_ENCODING_SKIP = (relativePath: string): string =>
  `无法识别的文本编码（仅支持 UTF-8 / UTF-8 BOM / UTF-16 LE / UTF-16 BE），已跳过：${relativePath}`
const READ_FAILED_SKIP = (relativePath: string, error: unknown): string =>
  `无法读取文件 ${relativePath}：${errorMessage(error)}`

/**
 * Stream a 16 MB..1 GB text file line by line. Occurrences are reported for
 * the read-only report, but no snapshot is produced, so the backend's apply
 * step skips these files instead of rewriting them.
 */
async function scanLargeTextFile(
  context: EngineContext,
  file: WalkedFile,
  encoding: FileEncoding
): Promise<FileScanOutcome> {
  const occurrences: ScanOccurrence[] = []
  let truncated = false

  try {
    for await (const line of streamTextLines(file.absolutePath, encoding, {
      signal: context.signal,
      budget: context.budget
    })) {
      throwIfAborted(context)
      if (occurrences.length >= MAX_OCCURRENCES_PER_FILE) {
        truncated = true
        break
      }
      occurrences.push(...collectLineOccurrences(context, line, file.relativePath))
      if (occurrences.length > MAX_OCCURRENCES_PER_FILE) {
        occurrences.length = MAX_OCCURRENCES_PER_FILE
        truncated = true
        break
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    if (error instanceof StreamBinaryError) return skippedOutcome(BINARY_SKIP(file.relativePath))
    if (error instanceof StreamEncodingError) {
      return skippedOutcome(UNSUPPORTED_ENCODING_SKIP(file.relativePath))
    }
    return skippedOutcome(READ_FAILED_SKIP(file.relativePath, error))
  }

  if (truncated) {
    addWarning(context, `文件 ${file.relativePath} 中的待替换位置过多，已截断。`)
  }
  addWarning(
    context,
    file.size > REPORT_ONLY_WARN_BYTES
      ? `文件超过 64 MB，仅报告扫描结果，不提供直接修复：${file.relativePath}`
      : `文件较大（超过 16 MB），已改为流式扫描，仅报告扫描结果，不提供直接修复：${file.relativePath}`
  )

  return {
    snapshot: null,
    occurrences,
    skipped: false,
    skipReason: null,
    scanned: true,
    budgetExceeded: budgetExhausted(context.budget)
  }
}

async function scanSingleFile(context: EngineContext, file: WalkedFile): Promise<FileScanOutcome> {
  throwIfAborted(context)
  if (file.size > context.maxFileBytes) {
    return skippedOutcome(
      `文件超过大小限制（${Math.ceil(file.size / 1024)} KB > ${Math.floor(
        context.maxFileBytes / 1024
      )} KB），已跳过：${file.relativePath}`
    )
  }

  // 1) Binary head sniff BEFORE any full read. A 1 GB binary therefore costs
  //    one 8 KB read instead of a 1 GB buffer.
  let probe: TextFileProbe
  try {
    probe = await probeTextFile(file.absolutePath, context.budget)
  } catch (error) {
    throwIfAborted(context)
    return skippedOutcome(READ_FAILED_SKIP(file.relativePath, error))
  }
  if (budgetExhausted(context.budget)) return skippedOutcome(null, true)
  if (probe.encoding === 'binary') return skippedOutcome(BINARY_SKIP(file.relativePath))
  if (probe.encoding === 'unsupported') {
    return skippedOutcome(UNSUPPORTED_ENCODING_SKIP(file.relativePath))
  }

  // 2) Small text files keep the existing full-read path, including a SHA-256
  //    snapshot so they remain repairable.
  if (file.size <= FULL_READ_MAX_BYTES) {
    if (budgetExhausted(context.budget)) return skippedOutcome(null, true)
    let read
    try {
      read = await readFullTextFile(file.absolutePath, context.budget)
    } catch (error) {
      throwIfAborted(context)
      return skippedOutcome(READ_FAILED_SKIP(file.relativePath, error))
    }
    if (read.kind === 'budget-exhausted') return skippedOutcome(null, true)
    if (read.kind === 'binary') return skippedOutcome(BINARY_SKIP(file.relativePath))
    if (read.kind === 'unsupported') {
      return skippedOutcome(UNSUPPORTED_ENCODING_SKIP(file.relativePath))
    }
    if (read.buffer.length > context.maxFileBytes) {
      return skippedOutcome(`文件超过大小限制，已跳过：${file.relativePath}`)
    }
    throwIfAborted(context)

    const hash = createHash('sha256').update(read.buffer).digest('hex')
    const snapshot: ScanSnapshot = {
      filePath: file.absolutePath,
      size: read.buffer.length,
      mtimeMs: file.mtimeMs,
      hash
    }
    const occurrences = collectOccurrences(context, read.text, file.relativePath)
    return {
      snapshot,
      occurrences,
      skipped: false,
      skipReason: null,
      scanned: true,
      budgetExceeded: false
    }
  }

  // 3) 16 MB..1 GB: bounded streaming scan, report-only (no snapshot).
  if (!isStreamableEncoding(probe.encoding)) {
    return skippedOutcome(UNSUPPORTED_ENCODING_SKIP(file.relativePath))
  }
  return scanLargeTextFile(context, file, probe.encoding)
}

function occurrenceComparator(left: ScanOccurrence, right: ScanOccurrence): number {
  return (
    compareText(left.filePath, right.filePath) ||
    left.offset - right.offset ||
    right.length - left.length ||
    compareText(left.ruleKey ?? '', right.ruleKey ?? '') ||
    compareText(left.id, right.id)
  )
}

/**
 * Scan an entire project for references that point at the moved file/directory
 * and compute their style-preserving replacements.
 */
export async function scanProject(options: ScanProjectOptions): Promise<EngineScanResult> {
  if (!options || typeof options !== 'object') {
    throw new CoreError('INVALID_PATH', '扫描参数无效。')
  }
  const startedAt = Date.now()
  const warnings: string[] = []

  // Path resolution/validation may throw typed CoreErrors for bad input.
  const pathInfo = resolveMigrationPaths(
    options.projectRoot,
    options.oldPath,
    options.newPath,
    options.kind
  )
  const projectRootAbs = resolveProjectRoot(options.projectRoot)
  const modes = normalizeModes(options.modes)
  const target: MigrationTarget = {
    projectRoot: projectRootAbs,
    kind: pathInfo.kind,
    oldRel: pathInfo.oldRel,
    newRel: pathInfo.newRel,
    oldName: pathInfo.oldName,
    newName: pathInfo.newName,
    modes,
    caseSensitive: options.caseSensitive === true
  }

  const ignore = createIgnoreEvaluator(Array.isArray(options.ignoreRules) ? options.ignoreRules : [])

  const context: EngineContext = {
    projectRootAbs,
    target,
    rules: [],
    ignore,
    maxFileBytes: normalizeMaxFileSizeKb(options.maxFileSizeKb) * 1024,
    budget: createReadBudget(options.budget),
    warnings,
    warningLimitReached: false,
    lastProgressAt: 0,
    lastPercent: 0
  }
  if (options.signal) context.signal = options.signal
  if (options.onProgress) context.onProgress = options.onProgress

  warnings.push(...pathInfo.warnings)
  context.rules = prepareRules(context, Array.isArray(options.rules) ? options.rules : [])

  if (modes.strict === false && modes.basename === false && modes.directory === false) {
    warnings.push('严格路径、文件名和目录三种匹配模式均已关闭，本次扫描不会产生任何结果。')
  } else if (pathInfo.kind === 'directory' && modes.directory === false) {
    warnings.push('目录模式已关闭，移动目录内部的引用不会被重新映射。')
  }

  throwIfAborted(context)
  emitProgress(context, 'preparing', 0, 0, null, 0, true)

  const { files, ignoredFiles } = await walkProject(context)
  const candidateFiles = files.length
  const occurrences: ScanOccurrence[] = []
  const snapshots: ScanSnapshot[] = []
  let scannedFiles = 0
  let skippedFiles = 0
  let processed = 0
  let budgetStopped = budgetExhausted(context.budget)

  emitProgress(context, 'scanning', 0, candidateFiles, null, candidateFiles === 0 ? SCAN_PROGRESS_END : SCAN_PROGRESS_START, true)

  for (let index = 0; index < files.length; index += READ_CONCURRENCY) {
    throwIfAborted(context)
    if (budgetExhausted(context.budget)) {
      budgetStopped = true
      break
    }
    const batch = files.slice(index, index + READ_CONCURRENCY)
    const outcomes = await Promise.all(
      batch.map(async (file) => {
        try {
          return await scanSingleFile(context, file)
        } catch (error) {
          if (isAbortError(error)) throw error
          addWarning(context, `扫描文件 ${file.relativePath} 失败：${errorMessage(error)}`)
          return skippedOutcome(null)
        }
      })
    )

    for (let offset = 0; offset < outcomes.length; offset += 1) {
      const outcome = outcomes[offset]
      if (!outcome) continue
      processed += 1
      if (outcome.snapshot) snapshots.push(outcome.snapshot)
      if (outcome.scanned) scannedFiles += 1
      if (outcome.skipped) {
        skippedFiles += 1
        if (outcome.skipReason) addWarning(context, outcome.skipReason)
      }
      if (outcome.occurrences.length > 0) occurrences.push(...outcome.occurrences)
      if (outcome.budgetExceeded) budgetStopped = true
    }

    const lastFile = batch[batch.length - 1]
    const percent =
      candidateFiles === 0
        ? SCAN_PROGRESS_END
        : SCAN_PROGRESS_START +
          Math.floor(((SCAN_PROGRESS_END - SCAN_PROGRESS_START) * processed) / candidateFiles)
    emitProgress(context, 'scanning', processed, candidateFiles, lastFile?.relativePath ?? null, percent)
    if (budgetStopped) break
  }

  if (budgetStopped) {
    addWarning(
      context,
      `已扫描 ${scannedFiles} 个文件，因扫描预算停止。1 GB 是单文件上限而不是推荐值；可减少项目内的超大文件后重试。`
    )
  }

  occurrences.sort(occurrenceComparator)
  snapshots.sort((left, right) => compareText(left.filePath, right.filePath))

  emitProgress(context, 'finalizing', processed, candidateFiles, null, 100, true)

  return {
    scanToken: randomUUID(),
    projectId: typeof options.projectId === 'number' ? options.projectId : 0,
    projectName: typeof options.projectName === 'string' ? options.projectName : '',
    projectRoot: projectRootAbs,
    oldPathInput: String(options.oldPath ?? ''),
    newPathInput: String(options.newPath ?? ''),
    pathInfo,
    modes,
    items: occurrences,
    scannedFiles,
    candidateFiles,
    skippedFiles,
    ignoredFiles,
    durationMs: Date.now() - startedAt,
    warnings: context.warnings,
    budgetStopped,
    createdAt: new Date().toISOString(),
    snapshots
  }
}
