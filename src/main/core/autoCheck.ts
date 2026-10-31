/**
 * Automatic broken-reference check.
 *
 * Unlike scanProject (which needs an old/new migration route), this pass simply
 * asks: "which path-like strings in the project point to files that do not
 * exist?" It is entirely read-only. For each broken path it also ranks existing
 * project files that look like they may be the moved target, so a beginner can
 * pick a suggestion instead of inventing an old/new path pair.
 */

import { createHash } from 'node:crypto'
import { promises as fsp, statSync } from 'node:fs'
import nodePath from 'node:path'
import type {
  AutoCheckCandidate,
  AutoCheckGroup,
  AutoCheckReference,
  AutoCheckResult,
  IgnoreRule,
  MatchRule,
  RuleCategory
} from '../../shared/types'
import { CoreError, createAbortError, errorMessage, isAbortError } from './errors'
import { createIgnoreEvaluator, type IgnoreEvaluator } from './ignore'
import {
  analyzeReference,
  resolveReferenceCandidates,
  type AnalyzedReference
} from './match'
import { isInside, normalizeSlashes, relativeBaseName, resolveProjectRoot } from './path'
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
  probeTextFile,
  readFullTextFile,
  type ScanBudgetOptions
} from './safeRead'
import {
  buildLineStarts,
  extractLineContext,
  lineColumnFromStarts
} from './text'

export interface AutoCheckProjectOptions {
  projectId: number
  projectName: string
  projectRoot: string
  rules: MatchRule[]
  ignoreRules: IgnoreRule[]
  caseSensitive: boolean
  maxFileSizeKb: number
  /** Optional global read budget; defaults to 512 MB / 120 s. */
  budget?: ScanBudgetOptions
  signal?: AbortSignal
}

interface WalkedFile {
  absolutePath: string
  relativePath: string
  size: number
  mtimeMs: number
}

interface PreparedRule {
  rule: MatchRule
  compiled: CompiledRule
}

interface RawReference {
  start: number
  end: number
  rule: MatchRule
  raw: string
  matchText: string
}

const READ_CONCURRENCY = 8
const MAX_GROUPS = 100
const MAX_REFS_PER_GROUP = 40
const MAX_REFERENCES = 1500
const MAX_CANDIDATES_PER_GROUP = 6
const MAX_WARNINGS = 80
const DEFAULT_MAX_FILE_SIZE_KB = 1_048_576

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function rulePriority(rule: MatchRule): number {
  return typeof rule.priority === 'number' && Number.isFinite(rule.priority) ? rule.priority : 0
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function hashId(...parts: Array<string | number>): string {
  return `ref_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20)}`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw createAbortError()
}

/** Reject module names, URLs and bare names; only real path-like file refs. */
function hasLikelyFileExtension(raw: string): boolean {
  const clean = raw.split(/[?#]/, 1)[0] ?? ''
  const base = clean.split(/[\\/]/).pop() ?? ''
  if (base.length === 0 || base.startsWith('.')) return false
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return false
  const ext = base.slice(dot + 1)
  return ext.length > 0 && ext.length <= 12 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ext)
}

function fileOrDirectoryExists(projectRoot: string, relativePath: string): boolean {
  const absolute = nodePath.resolve(projectRoot, ...relativePath.split('/'))
  if (!isInside(projectRoot, absolute)) return false
  try {
    const stats = statSync(absolute)
    return stats.isFile() || stats.isDirectory()
  } catch {
    return false
  }
}

function canonicalMissingPath(
  analysis: AnalyzedReference,
  sourceFileRel: string,
  projectRoot: string
): string | null {
  const candidates = resolveReferenceCandidates(analysis, sourceFileRel, projectRoot)
  if (candidates.length === 0) return null
  const preference =
    analysis.style === 'source-relative'
      ? ['source', 'root', 'absolute']
      : analysis.style === 'absolute'
        ? ['absolute', 'root', 'source']
        : ['root', 'source', 'absolute']
  for (const branch of preference) {
    const found = candidates.find((candidate) => candidate.branch === branch)
    if (found) return found.rel
  }
  return candidates[0]?.rel ?? null
}

function anyCandidateExists(
  analysis: AnalyzedReference,
  sourceFileRel: string,
  projectRoot: string
): boolean {
  const candidates = resolveReferenceCandidates(analysis, sourceFileRel, projectRoot)
  return candidates.some((candidate) => fileOrDirectoryExists(projectRoot, candidate.rel))
}

async function walkProjectFiles(
  projectRoot: string,
  ignore: IgnoreEvaluator,
  warnings: string[],
  signal?: AbortSignal
): Promise<WalkedFile[]> {
  const files: WalkedFile[] = []
  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    throwIfAborted(signal)
    let entries
    try {
      entries = await fsp.readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      if (warnings.length < MAX_WARNINGS) {
        warnings.push(`无法读取目录 ${relativeDir || '.'}：${errorMessage(error)}`)
      }
      return
    }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      throwIfAborted(signal)
      const name = entry.name
      const relativePath = relativeDir.length === 0 ? name : `${relativeDir}/${name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // Always ignore the app's own backups, even if the user disabled the
        // default ignore rule. Scanning a backup inside a project is never
        // part of a normal broken-reference check.
        if (relativePath.split('/').includes('.pathkeeper-backup')) continue
        if (ignore.isIgnoredDirectory(name, relativePath)) continue
        await walk(nodePath.join(absoluteDir, name), relativePath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stats = await fsp.stat(nodePath.join(absoluteDir, name))
        files.push({
          absolutePath: nodePath.join(absoluteDir, name),
          relativePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs
        })
      } catch {
        // A disappearing file is not fatal for a read-only check.
      }
    }
  }
  await walk(projectRoot, '')
  files.sort((left, right) => compareText(left.relativePath, right.relativePath))
  return files
}

function prepareRules(rules: readonly MatchRule[], warnings: string[]): PreparedRule[] {
  const enabled = (Array.isArray(rules) ? rules : []).filter(
    (rule): rule is MatchRule => Boolean(rule) && rule.enabled === true
  )
  enabled.sort(
    (left, right) =>
      rulePriority(right) - rulePriority(left) ||
      compareText(left.ruleKey ?? '', right.ruleKey ?? '')
  )
  const prepared: PreparedRule[] = []
  for (const rule of enabled) {
    try {
      const validation = validateMatchRule(rule.pattern, rule.flags)
      if (!validation.valid) {
        if (warnings.length < MAX_WARNINGS) {
          warnings.push(`规则“${rule.name}”已跳过：${validation.error ?? '配置无效。'}`)
        }
        continue
      }
      prepared.push({ rule, compiled: compileMatchRule(rule.pattern, rule.flags) })
    } catch (error) {
      if (warnings.length < MAX_WARNINGS) {
        warnings.push(`规则“${rule.name}”已跳过：${errorMessage(error)}`)
      }
    }
  }
  return prepared
}

function extractRawReferences(
  text: string,
  rules: PreparedRule[],
  signal?: AbortSignal
): RawReference[] {
  const collected: Array<RawReference & { priority: number }> = []
  for (const prepared of rules) {
    throwIfAborted(signal)
    const compiled = prepared.compiled
    const regex = new RegExp(compiled.regex.source, compiled.regex.flags)
    let match: RegExpExecArray | null
    let guard = 0
    while ((match = regex.exec(text)) !== null) {
      guard += 1
      if ((guard & 0x3ff) === 0) throwIfAborted(signal)
      if (match[0].length === 0) {
        if (regex.lastIndex >= text.length) break
        regex.lastIndex += 1
        continue
      }
      const span = captureSpan(match, compiled)
      if (!span) continue
      const rawSpan = text.slice(span.start, span.end)
      const leading = rawSpan.length - rawSpan.trimStart().length
      const trailing = rawSpan.length - rawSpan.trimEnd().length
      const start = span.start + leading
      const end = span.end - trailing
      if (end <= start) continue
      const raw = text.slice(start, end)
      if (raw.length === 0 || raw.length > 4096) continue
      if (!hasLikelyFileExtension(raw)) continue
      if (analyzeReference(raw) === null) continue
      collected.push({
        start,
        end,
        rule: prepared.rule,
        raw,
        matchText: match[0],
        priority: rulePriority(prepared.rule)
      })
    }
  }

  // Overlapping captures from several rules: keep the most specific rule.
  collected.sort(
    (left, right) =>
      right.priority - left.priority ||
      left.start - right.start ||
      right.end - right.start - (left.end - left.start)
  )
  const accepted: RawReference[] = []
  for (const item of collected) {
    const conflict = accepted.some((kept) => leftOverlaps(item, kept))
    if (!conflict) {
      accepted.push({
        start: item.start,
        end: item.end,
        rule: item.rule,
        raw: item.raw,
        matchText: item.matchText
      })
    }
  }
  accepted.sort((left, right) => left.start - right.start)
  return accepted
}

function leftOverlaps(
  left: { start: number; end: number },
  right: { start: number; end: number }
): boolean {
  return left.start < right.end && right.start < left.end
}

function normalizeStem(value: string): string {
  const base = relativeBaseName(value).toLowerCase()
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).replace(/[^\p{L}\p{N}]+/gu, '')
}

function bigramSimilarity(left: string, right: string): number {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0
  const grams = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let shared = 0
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2)
    const remaining = grams.get(gram) ?? 0
    if (remaining > 0) {
      shared += 1
      grams.set(gram, remaining - 1)
    }
  }
  return (2 * shared) / (left.length - 1 + right.length - 1)
}

function candidatesForMissing(
  missingPath: string,
  inventory: WalkedFile[],
  caseSensitive: boolean
): AutoCheckCandidate[] {
  const missingName = relativeBaseName(missingPath)
  const missingLower = caseSensitive ? missingName : missingName.toLowerCase()
  const missingExtension = nodePath.posix.extname(missingName).toLowerCase()
  const missingStem = normalizeStem(missingName)
  const ranked: Array<AutoCheckCandidate & { mtimeMs: number }> = []
  for (const file of inventory) {
    if (file.relativePath === missingPath) continue
    const base = relativeBaseName(file.relativePath)
    const baseCompare = caseSensitive ? base : base.toLowerCase()
    if (baseCompare === missingLower) {
      ranked.push({
        filePath: file.relativePath,
        reason: 'same-name',
        score: 100,
        mtimeMs: file.mtimeMs
      })
      continue
    }
    if (missingExtension.length === 0) continue
    const extension = nodePath.posix.extname(base).toLowerCase()
    if (extension !== missingExtension) continue
    const similarity = bigramSimilarity(missingStem, normalizeStem(base))
    if (similarity < 0.45) continue
    ranked.push({
      filePath: file.relativePath,
      reason: 'similar-name',
      score: 40 + Math.round(similarity * 55),
      mtimeMs: file.mtimeMs
    })
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      right.mtimeMs - left.mtimeMs ||
      compareText(left.filePath, right.filePath)
  )
  return ranked.slice(0, MAX_CANDIDATES_PER_GROUP).map(({ filePath, reason, score }) => ({
    filePath,
    reason,
    score
  }))
}

function makeReference(
  fileRel: string,
  text: string,
  lineStarts: number[],
  hit: RawReference
): AutoCheckReference {
  const { line, column } = lineColumnFromStarts(lineStarts, hit.start)
  return {
    id: hashId(fileRel, hit.start, hit.raw),
    filePath: fileRel,
    line,
    column,
    ruleName: hit.rule.name,
    ruleCategory: hit.rule.category as RuleCategory,
    rawText: hit.raw,
    context: extractLineContext(text, lineStarts, hit.start, hit.end - hit.start)
  }
}

/**
 * Run the automatic broken-reference check. Pure Node, no writes.
 */
export async function autoCheckProject(
  options: AutoCheckProjectOptions
): Promise<AutoCheckResult> {
  if (!options || typeof options !== 'object') {
    throw new CoreError('INVALID_PATH', '自动检查参数无效。')
  }
  const startedAt = Date.now()
  const projectRoot = resolveProjectRoot(options.projectRoot)
  const warnings: string[] = []
  const rules = prepareRules(Array.isArray(options.rules) ? options.rules : [], warnings)
  if (rules.length === 0) {
    throw new CoreError('NO_RULES', '没有启用的匹配规则，无法自动检查。')
  }
  const ignore = createIgnoreEvaluator(Array.isArray(options.ignoreRules) ? options.ignoreRules : [])
  const maxFileBytes =
    (Number.isFinite(options.maxFileSizeKb) && Number(options.maxFileSizeKb) > 0
      ? Math.floor(Number(options.maxFileSizeKb))
      : DEFAULT_MAX_FILE_SIZE_KB) * 1024
  const caseSensitive = options.caseSensitive === true
  const budget = createReadBudget(options.budget)

  throwIfAborted(options.signal)
  const inventory = await walkProjectFiles(projectRoot, ignore, warnings, options.signal)
  let checkedFiles = 0
  let skippedFiles = 0
  let referenceCount = 0
  let budgetStopped = false
  const brokenByPath = new Map<string, { references: AutoCheckReference[]; total: number }>()

  const addAutoCheckWarning = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message)
  }

  // Read scanned files in small batches. Inventory is reused for suggestions.
  for (let offset = 0; offset < inventory.length; offset += READ_CONCURRENCY) {
    throwIfAborted(options.signal)
    if (budgetExhausted(budget)) {
      budgetStopped = true
      break
    }
    const batch = inventory.slice(offset, offset + READ_CONCURRENCY)
    const outcomes = await Promise.all(
      batch.map(async (file) => {
        const base = relativeBaseName(file.relativePath)
        if (ignore.isIgnoredFile(file.relativePath, base)) {
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        if (file.size > maxFileBytes) {
          addAutoCheckWarning(`文件过大，已跳过自动检查：${file.relativePath}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }

        // Binary head sniff before any full read (a 1 GB binary is never loaded).
        let probe
        try {
          probe = await probeTextFile(file.absolutePath, budget)
        } catch (error) {
          if (isAbortError(error)) throw error
          addAutoCheckWarning(`无法读取文件 ${file.relativePath}：${errorMessage(error)}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        if (budgetExhausted(budget)) {
          return { skipped: true, budgetExceeded: true, refs: [] as AutoCheckReference[] }
        }
        if (probe.encoding === 'binary') {
          addAutoCheckWarning(`疑似二进制文件，已跳过自动检查：${file.relativePath}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        if (probe.encoding === 'unsupported') {
          addAutoCheckWarning(`无法识别的文本编码，已跳过自动检查：${file.relativePath}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        if (file.size > FULL_READ_MAX_BYTES) {
          addAutoCheckWarning(`文件较大（超过 16 MB），已跳过内容扫描：${file.relativePath}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }

        let read
        try {
          read = await readFullTextFile(file.absolutePath, budget)
        } catch (error) {
          if (isAbortError(error)) throw error
          addAutoCheckWarning(`无法读取文件 ${file.relativePath}：${errorMessage(error)}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        if (read.kind === 'budget-exhausted') {
          return { skipped: true, budgetExceeded: true, refs: [] as AutoCheckReference[] }
        }
        if (read.kind === 'binary') {
          addAutoCheckWarning(`疑似二进制文件，已跳过自动检查：${file.relativePath}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        if (read.kind === 'unsupported') {
          addAutoCheckWarning(`无法识别的文本编码，已跳过自动检查：${file.relativePath}`)
          return { skipped: true, budgetExceeded: false, refs: [] as AutoCheckReference[] }
        }
        const refs: AutoCheckReference[] = []
        const lineStarts = buildLineStarts(read.text)
        const rawHits = extractRawReferences(read.text, rules, options.signal)
        for (const hit of rawHits) {
          const analysis = analyzeReference(hit.raw)
          if (!analysis) continue
          if (anyCandidateExists(analysis, file.relativePath, projectRoot)) {
            referenceCount += 1
            continue
          }
          const missingPath = canonicalMissingPath(analysis, file.relativePath, projectRoot)
          if (!missingPath) continue
          referenceCount += 1
          const group = brokenByPath.get(missingPath) ?? { references: [], total: 0 }
          group.total += 1
          if (group.references.length < MAX_REFS_PER_GROUP) {
            group.references.push(makeReference(file.relativePath, read.text, lineStarts, hit))
          }
          brokenByPath.set(missingPath, group)
        }
        return { skipped: false, budgetExceeded: false, refs }
      })
    )
    for (const outcome of outcomes) {
      if (outcome.skipped) skippedFiles += 1
      else checkedFiles += 1
      if (outcome.budgetExceeded) budgetStopped = true
    }
    if (budgetStopped) break
  }

  if (budgetStopped) {
    addAutoCheckWarning(
      `已扫描 ${checkedFiles + skippedFiles} 个文件，因扫描预算停止。可稍后重试或减少项目内的超大文件。`
    )
  }

  const groups: AutoCheckGroup[] = []
  let brokenReferenceCount = 0
  for (const [missingPath, group] of [...brokenByPath.entries()].sort((left, right) => {
    return right[1].total - left[1].total || compareText(left[0], right[0])
  })) {
    brokenReferenceCount += group.total
    if (groups.length >= MAX_GROUPS) continue
    groups.push({
      missingPath,
      missingName: relativeBaseName(missingPath),
      references: group.references,
      candidates: candidatesForMissing(missingPath, inventory, caseSensitive)
    })
  }
  if (brokenByPath.size > MAX_GROUPS) {
    warnings.push(`断链分组过多，仅显示前 ${MAX_GROUPS} 组；请先修复部分后重新检查。`)
  }
  if (brokenReferenceCount > MAX_REFERENCES) {
    warnings.push(`断链引用过多，部分条目未显示；请先修复部分后重新检查。`)
  }

  return {
    projectId: Number(options.projectId) || 0,
    projectName: typeof options.projectName === 'string' ? options.projectName : '',
    projectRoot,
    checkedFiles,
    skippedFiles,
    referenceCount,
    brokenReferenceCount,
    groups,
    warnings: warnings.slice(0, MAX_WARNINGS),
    durationMs: Date.now() - startedAt,
    budgetStopped,
    createdAt: new Date().toISOString()
  }
}
