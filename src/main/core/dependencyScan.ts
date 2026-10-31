/**
 * Dependency health engine.
 *
 * This is a read-only project pass built on the same text extraction primitives
 * as the migration scanner. It turns path references into a small dependency
 * graph, classifies files by role, validates common file-health issues and
 * returns beginner-readable issues plus repair candidates.
 *
 * The engine never edits project files and never executes project commands.
 */

import { createHash } from 'node:crypto'
import { promises as fsp, statSync } from 'node:fs'
import nodePath from 'node:path'
import type {
  DependencyCandidate,
  DependencyChange,
  DependencyEdge,
  DependencyHealth,
  DependencyIssue,
  DependencyIssueSeverity,
  DependencyNode,
  DependencyPolicy,
  DependencyReference,
  DependencyRole,
  DependencyScanResult,
  DependencySummary,
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
import {
  isInside,
  normalizeSlashes,
  relativeBaseName,
  resolveProjectRoot
} from './path'
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
  hashFileStreaming,
  MAX_JSON_PARSE_BYTES,
  MAX_STREAM_HASH_BYTES,
  probeTextFile,
  readFullTextFile,
  type ReadBudget,
  type ScanBudgetOptions
} from './safeRead'
import {
  buildLineStarts,
  extractLineContext,
  lineColumnFromStarts
} from './text'

export interface DependencyScanOptions {
  projectId: number
  projectName: string
  projectRoot: string
  rules: MatchRule[]
  ignoreRules: IgnoreRule[]
  caseSensitive: boolean
  maxFileSizeKb: number
  /** Project-relative paths the user chose to skip. */
  ignoredPaths?: string[]
  /**
   * When set, only files with one of these lowercase extensions are
   * content-scanned for path references. Existence/health checks still see the
   * whole inventory. Installed software uses this to scan configuration files
   * only (bundled scripts and logs are runtime-resolved and pure noise).
   */
  contentExtensions?: string[]
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
  context: string
  line: number
  column: number
}

interface ResolvedReference {
  source: WalkedFile
  hit: RawReference
  targetPath: string
  existed: boolean
  targetWasDirectory: boolean
}

interface FileCheck {
  health: DependencyHealth
  details: string[]
  sha256: string | null
}

const READ_CONCURRENCY = 8
const MAX_NODES = 700
const MAX_EDGES = 2400
const MAX_ISSUES = 250
const MAX_WARNINGS = 100
const MAX_CANDIDATES = 6
const MAX_REFERENCES_PER_ISSUE = 40
const DEFAULT_MAX_FILE_SIZE_KB = 1_048_576
const POLICY_RELATIVE_PATH = '.pathkeeper/dependency-policy.json'

const ROLE_LABELS: Record<DependencyRole, string> = {
  config: '配置',
  source: '源文件',
  input: '输入',
  cache: '缓存',
  output: '输出',
  unknown: '其他'
}

const CACHE_SEGMENTS = new Set([
  'cache',
  'caches',
  '.cache',
  'tmp',
  'temp',
  '.tmp',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache'
])
const OUTPUT_SEGMENTS = new Set([
  'output',
  'outputs',
  'dist',
  'build',
  'out',
  'results',
  'result',
  'renders',
  'render',
  'generated',
  'release',
  'logs',
  'exports'
])
const INPUT_SEGMENTS = new Set([
  'assets',
  'asset',
  'data',
  'dataset',
  'datasets',
  'input',
  'inputs',
  'models',
  'model',
  'textures',
  'images',
  'image',
  'audio',
  'video',
  'resources',
  'samples',
  'media'
])
const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env'
])
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.php',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.vue',
  '.svelte',
  '.html',
  '.htm',
  '.css',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml'
])
const INPUT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.svg',
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.mp4',
  '.mov',
  '.webm',
  '.csv',
  '.tsv',
  '.parquet',
  '.arrow',
  '.feather',
  '.npy',
  '.npz',
  '.pt',
  '.pth',
  '.onnx',
  '.safetensors',
  '.ckpt',
  '.bin',
  '.pkl',
  '.pickle'
])
const CACHE_EXTENSIONS = new Set(['.tmp', '.cache', '.pyc', '.pyo', '.lock'])
const IMAGE_MAGIC: Record<string, Array<Buffer>> = {
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.gif': [Buffer.from('GIF8')],
  '.webp': [Buffer.from('RIFF')],
  '.bmp': [Buffer.from('BM')]
}

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
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw createAbortError()
}

function normalizeRelative(value: string): string {
  return normalizeSlashes(value).replace(/^\.\/+/, '').replace(/^\/+/, '')
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(message)
}

function hasLikelyFileExtension(raw: string): boolean {
  const clean = raw.split(/[?#]/, 1)[0] ?? ''
  const base = clean.split(/[\\/]/).pop() ?? ''
  if (base.length === 0 || base.startsWith('.')) return false
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return false
  const ext = base.slice(dot + 1)
  return ext.length > 0 && ext.length <= 12 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ext)
}

function fileOrDirectoryExists(projectRoot: string, relativePath: string): { exists: boolean; directory: boolean } {
  const absolute = nodePath.resolve(projectRoot, ...relativePath.split('/'))
  if (!isInside(projectRoot, absolute)) return { exists: false, directory: false }
  try {
    const stats = statSync(absolute)
    return { exists: true, directory: stats.isDirectory() }
  } catch {
    return { exists: false, directory: false }
  }
}

function extensionOf(relativePath: string): string {
  return nodePath.posix.extname(relativePath).toLowerCase()
}

function pathSegments(relativePath: string): string[] {
  return normalizeRelative(relativePath)
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
}

/** Heuristic role classification. Cache/output locations win over extension. */
export function classifyDependencyRole(relativePath: string): DependencyRole {
  const segments = pathSegments(relativePath)
  const base = relativeBaseName(relativePath).toLowerCase()
  const extension = extensionOf(relativePath)
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment)) || CACHE_EXTENSIONS.has(extension)) {
    return 'cache'
  }
  if (segments.some((segment) => OUTPUT_SEGMENTS.has(segment))) {
    return 'output'
  }
  if (CONFIG_EXTENSIONS.has(extension) || base.startsWith('config')) {
    return 'config'
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    // Docs/config-like source files are still source files, but a markdown file
    // in an assets folder is usually a document rather than an input asset.
    return 'source'
  }
  if (segments.some((segment) => INPUT_SEGMENTS.has(segment)) || INPUT_EXTENSIONS.has(extension)) {
    return 'input'
  }
  if (extension.length === 0) return 'unknown'
  return 'unknown'
}

function roleLabel(role: DependencyRole): string {
  return ROLE_LABELS[role]
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
      addWarning(warnings, `无法读取目录 ${relativeDir || '.'}：${errorMessage(error)}`)
      return
    }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      throwIfAborted(signal)
      const name = entry.name
      const relativePath = relativeDir.length === 0 ? name : `${relativeDir}/${name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
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
        // A file that disappears during a read-only walk is simply skipped.
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
        addWarning(warnings, `规则“${rule.name}”已跳过：${validation.error ?? '配置无效。'}`)
        continue
      }
      prepared.push({ rule, compiled: compileMatchRule(rule.pattern, rule.flags) })
    } catch (error) {
      addWarning(warnings, `规则“${rule.name}”已跳过：${errorMessage(error)}`)
    }
  }
  return prepared
}

function leftOverlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end
}

const TOKEN_BREAK = /[\s"'`]/

/**
 * A rule may capture only the tail of a URL or template reference (for example
 * `static.example.com/a.png` inside `https://static.example.com/a.png`). Such
 * spans are not local file paths and must never be reported as dependencies.
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
  if (prefix.includes(':/')) return true
  if (prefix.includes('${')) return true
  if (prefix.includes('{{') || prefix.includes('}}')) return true
  // Protocol-ish prefixes such as `mailto:`; a Windows drive prefix `C:` is
  // captured together with the path, so it is safe.
  if (prefix.endsWith(':') && !/^[A-Za-z]:$/.test(prefix)) return true
  return false
}

function extractReferences(
  text: string,
  rules: PreparedRule[],
  lineStarts: number[],
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
      if (hasUnsafeTokenPrefix(text, start)) continue
      if (!hasLikelyFileExtension(raw)) continue
      if (analyzeReference(raw) === null) continue
      const { line, column } = lineColumnFromStarts(lineStarts, start)
      collected.push({
        start,
        end,
        rule: prepared.rule,
        raw,
        context: extractLineContext(text, lineStarts, start, end - start),
        line,
        column,
        priority: rulePriority(prepared.rule)
      })
    }
  }
  collected.sort(
    (left, right) =>
      right.priority - left.priority ||
      left.start - right.start ||
      right.end - right.start - (left.end - left.start)
  )
  const accepted: RawReference[] = []
  for (const item of collected) {
    if (accepted.some((kept) => leftOverlaps(item, kept))) continue
    accepted.push({
      start: item.start,
      end: item.end,
      rule: item.rule,
      raw: item.raw,
      context: item.context,
      line: item.line,
      column: item.column
    })
  }
  accepted.sort((left, right) => left.start - right.start)
  return accepted
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

function existsCandidate(
  analysis: AnalyzedReference,
  sourceFileRel: string,
  projectRoot: string
): { rel: string; directory: boolean } | null {
  const candidates = resolveReferenceCandidates(analysis, sourceFileRel, projectRoot)
  const preference =
    analysis.style === 'source-relative'
      ? ['source', 'root', 'absolute']
      : ['root', 'source', 'absolute']
  for (const branch of preference) {
    const found = candidates.find((candidate) => candidate.branch === branch)
    if (!found) continue
    const exists = fileOrDirectoryExists(projectRoot, found.rel)
    if (exists.exists) return { rel: found.rel, directory: exists.directory }
  }
  for (const candidate of candidates) {
    const exists = fileOrDirectoryExists(projectRoot, candidate.rel)
    if (exists.exists) return { rel: candidate.rel, directory: exists.directory }
  }
  return null
}

function normalizeStem(value: string): string {
  const base = relativeBaseName(value).toLowerCase()
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).replace(/[^\p{L}\p{N}]+/gu, '')
}

function bigramSimilarity(left: string, right: string): number {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
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

function candidatesFor(
  missingPath: string,
  inventory: WalkedFile[],
  caseSensitive: boolean
): DependencyCandidate[] {
  const missingName = relativeBaseName(missingPath)
  const missingLower = caseSensitive ? missingName : missingName.toLowerCase()
  const missingExtension = extensionOf(missingName)
  const missingStem = normalizeStem(missingName)
  const missingDir = nodePath.posix.dirname(missingPath)
  const ranked: Array<DependencyCandidate & { mtimeMs: number }> = []
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
    if (missingExtension.length === 0 || extensionOf(base) !== missingExtension) continue
    const similarity = bigramSimilarity(missingStem, normalizeStem(base))
    const sameFolder = nodePath.posix.dirname(file.relativePath) === missingDir
    if (similarity < 0.45 && !sameFolder) continue
    ranked.push({
      filePath: file.relativePath,
      reason: sameFolder ? 'same-folder' : 'similar-name',
      score: Math.round(similarity * 55) + (sameFolder ? 35 : 40),
      mtimeMs: file.mtimeMs
    })
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      right.mtimeMs - left.mtimeMs ||
      compareText(left.filePath, right.filePath)
  )
  return ranked.slice(0, MAX_CANDIDATES).map(({ filePath, reason, score }) => ({
    filePath,
    reason,
    score
  }))
}

function healthIssueCopy(
  node: DependencyNode
): { severity: DependencyIssueSeverity; title: string; what: string; why: string; fixHint: string } {
  const label = roleLabel(node.role)
  if (node.health === 'missing') {
    const severity: DependencyIssueSeverity =
      node.role === 'input' || node.role === 'config' || node.role === 'source'
        ? 'blocking'
        : 'warning'
    return {
      severity,
      title: `找不到${label}文件「${node.name}」`,
      what: `项目里有 ${node.incoming} 处引用还指向 ${node.path}，但这个文件现在不在那里。`,
      why:
        node.role === 'cache'
          ? '缓存失效通常只会让程序变慢或重新生成，不一定会损坏数据。'
          : node.role === 'output'
            ? '如果只是旧产物，可以跳过；如果程序依赖它继续处理，就需要修复。'
            : '程序运行时可能找不到文件、报错，或者继续使用旧内容。',
      fixHint:
        node.candidates.length > 0
          ? '软件在项目里找到了可能的同名/相似文件，可以先核对再一键修复。'
          : '先找到文件现在的位置；找不到时可先跳过，或把文件放回项目后重新体检。'
    }
  }
  if (node.health === 'unreadable') {
    return {
      severity: node.role === 'cache' || node.role === 'output' ? 'warning' : 'blocking',
      title: `无法读取「${node.name}」`,
      what: `文件存在，但当前用户没有读取权限，或文件正被其他程序锁定。`,
      why: 'PathKeeper 不会绕过系统权限；相关程序也可能读不到它。',
      fixHint: '关闭占用该文件的程序，或检查文件属性中的权限，然后重新体检。'
    }
  }
  if (node.health === 'corrupt') {
    return {
      severity: node.role === 'input' || node.role === 'config' ? 'blocking' : 'warning',
      title: `「${node.name}」可能已经损坏`,
      what: node.details.join('；') || '文件内容为空，或无法按预期格式读取。',
      why: '损坏的文件可能让程序运行到一半报错，或产出错误结果。',
      fixHint: node.role === 'cache'
        ? '可以先把这份缓存移到备份目录，再让上游程序重新生成。'
        : '从原始来源重新拷贝/导出这个文件，或选择同名的可用副本。'
    }
  }
  if (node.health === 'format-mismatch') {
    return {
      severity: 'warning',
      title: `「${node.name}」的格式和扩展名不一致`,
      what: node.details.join('；') || '文件内容看起来不是这个扩展名对应的格式。',
      why: '读取程序可能拒绝打开它，或者把它当成另一种格式解析。',
      fixHint: '确认文件是否被错误改名；必要时用正确的扩展名保存一份副本。'
    }
  }
  if (node.health === 'version-mismatch') {
    return {
      severity: 'warning',
      title: `「${node.name}」的版本不匹配`,
      what: node.details.join('；') || '项目声明的版本要求与文件中的版本不一致。',
      why: '版本差异可能导致格式不兼容或运行结果异常。',
      fixHint: '按项目要求更新文件，或修改 .pathkeeper/dependency-policy.json 中的版本声明。'
    }
  }
  return {
    severity: 'info',
    title: `「${node.name}」需要关注`,
    what: node.details.join('；') || '依赖检查发现了需要人工确认的项。',
    why: '先看引用位置和文件状态，再决定是否修复。',
    fixHint: '打开文件所在目录核对，或先跳过这一项。'
  }
}

function parsePolicy(raw: unknown): DependencyPolicy | null {
  if (typeof raw !== 'object' || raw === null) return null
  const dependencies = (raw as { dependencies?: unknown }).dependencies
  if (!Array.isArray(dependencies)) return null
  const parsed: DependencyPolicy = { dependencies: [] }
  for (const item of dependencies) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string' || record.path.trim().length === 0) continue
    const entry: DependencyPolicy['dependencies'][number] = {
      path: normalizeRelative(record.path.trim())
    }
    if (typeof record.role === 'string' && ['config', 'source', 'input', 'cache', 'output', 'unknown'].includes(record.role)) {
      entry.role = record.role as DependencyRole
    }
    if (typeof record.versionField === 'string' && record.versionField.trim().length > 0) {
      entry.versionField = record.versionField.trim()
    }
    if (typeof record.minVersion === 'string' && record.minVersion.trim().length > 0) {
      entry.minVersion = record.minVersion.trim()
    }
    if (typeof record.expectedSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.expectedSha256)) {
      entry.expectedSha256 = record.expectedSha256.toLowerCase()
    }
    parsed.dependencies.push(entry)
  }
  return parsed
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function readVersionFromJson(
  absolutePath: string,
  versionField?: string
): Promise<string | null> {
  try {
    const stats = await fsp.stat(absolutePath)
    if (stats.size > MAX_JSON_PARSE_BYTES) return null
    const raw = await fsp.readFile(absolutePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const keys = versionField
        ? [versionField]
        : ['version', 'schema_version', 'schemaVersion', 'format_version', 'formatVersion']
      for (const key of keys) {
        if (typeof record[key] === 'string' && record[key].trim().length > 0) {
          return String(record[key]).trim()
        }
      }
    }
  } catch {
    // JSON parse problems are reported by the normal corrupt check.
  }
  return null
}

async function checkFileHealth(
  projectRoot: string,
  file: WalkedFile,
  maxFileBytes: number,
  budget: ReadBudget,
  signal?: AbortSignal,
  expectedSha256?: string
): Promise<FileCheck> {
  const details: string[] = []
  let sha256: string | null = null
  if (file.size === 0) {
    return { health: 'corrupt', details: ['文件是空的（0 字节）'], sha256: null }
  }
  const extension = extensionOf(file.relativePath)
  let handle
  try {
    handle = await fsp.open(file.absolutePath, 'r')
  } catch (error) {
    const message = errorMessage(error)
    if (/EACCES|EPERM/i.test(message)) {
      return { health: 'unreadable', details: ['没有读取权限，或文件被其他程序占用'], sha256: null }
    }
    return { health: 'unreadable', details: [`读取失败：${truncate(message, 120)}`], sha256: null }
  }

  try {
    if (IMAGE_MAGIC[extension]) {
      const head = Buffer.alloc(16)
      const read = await handle.read(head, 0, head.length, 0)
      const sample = head.subarray(0, read.bytesRead)
      const matches = IMAGE_MAGIC[extension]?.some((magic) => sample.subarray(0, magic.length).equals(magic))
      if (!matches) {
        return {
          health: 'format-mismatch',
          details: [`扩展名是 ${extension}，但文件头不是该图片格式`],
          sha256: null
        }
      }
    }

    // Never JSON.parse an enormous file: 1 GB settings must not turn the health
    // check into a memory bomb. Files above the check limit are reported as
    // unchecked instead of being loaded.
    const jsonCheckLimit = Math.min(maxFileBytes, MAX_JSON_PARSE_BYTES)
    if (extension === '.json') {
      if (file.size > jsonCheckLimit) {
        details.push(
          `未执行 JSON 解析检查：文件 ${Math.ceil(file.size / 1024)} KB 超过检查上限 ${Math.floor(
            jsonCheckLimit / 1024
          )} KB`
        )
      } else {
        const read = await readFullTextFile(file.absolutePath, budget)
        if (read.kind === 'text') {
          try {
            JSON.parse(read.text)
          } catch {
            return {
              health: 'corrupt',
              details: ['JSON 内容不完整或语法有误，无法解析'],
              sha256: null
            }
          }
        }
      }
    }

    if (expectedSha256) {
      if (file.size > MAX_STREAM_HASH_BYTES) {
        details.push('文件过大，未校验 SHA-256')
      } else {
        // Stream the hash so a 100 MB file never becomes a 100 MB string/buffer.
        sha256 = await hashFileStreaming(file.absolutePath, { budget, signal })
        if (sha256 === null) {
          details.push('扫描预算已用完，未校验 SHA-256')
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    const message = errorMessage(error)
    if (/EACCES|EPERM/i.test(message)) {
      return { health: 'unreadable', details: ['没有读取权限，或文件被其他程序占用'], sha256: null }
    }
    return { health: 'unreadable', details: [`读取失败：${truncate(message, 120)}`], sha256: null }
  } finally {
    await handle.close().catch(() => undefined)
  }
  return { health: 'healthy', details, sha256 }
}

function issueSeverityForHealth(
  health: DependencyHealth,
  role: DependencyRole
): DependencyIssueSeverity {
  if (health === 'unreadable' || health === 'corrupt') {
    return role === 'cache' || role === 'output' ? 'warning' : 'blocking'
  }
  if (health === 'missing') {
    return role === 'config' || role === 'source' || role === 'input' ? 'blocking' : 'warning'
  }
  return 'warning'
}

/**
 * Run a full dependency health scan. Pure Node, no writes, no external
 * commands, no network.
 */
export async function scanDependencies(
  options: DependencyScanOptions
): Promise<DependencyScanResult> {
  if (!options || typeof options !== 'object') {
    throw new CoreError('INVALID_PATH', '依赖检查参数无效。')
  }
  const startedAt = Date.now()
  const projectRoot = resolveProjectRoot(options.projectRoot)
  const warnings: string[] = []
  const rules = prepareRules(Array.isArray(options.rules) ? options.rules : [], warnings)
  if (rules.length === 0) {
    throw new CoreError('NO_RULES', '没有启用的匹配规则，无法检查依赖。')
  }
  const ignore = createIgnoreEvaluator(Array.isArray(options.ignoreRules) ? options.ignoreRules : [])
  const contentExtensionSet =
    Array.isArray(options.contentExtensions) && options.contentExtensions.length > 0
      ? new Set(options.contentExtensions.map((extension) => extension.toLowerCase()))
      : null
  const maxFileBytes =
    (Number.isFinite(options.maxFileSizeKb) && Number(options.maxFileSizeKb) > 0
      ? Math.floor(Number(options.maxFileSizeKb))
      : DEFAULT_MAX_FILE_SIZE_KB) * 1024
  const caseSensitive = options.caseSensitive === true
  const ignoredPaths = new Set((options.ignoredPaths ?? []).map(normalizeRelative))
  const budget = createReadBudget(options.budget)
  let budgetStopped = false
  throwIfAborted(options.signal)

  const inventory = await walkProjectFiles(projectRoot, ignore, warnings, options.signal)
  const inventoryByPath = new Map(inventory.map((file) => [file.relativePath, file]))
  const basenameIndex = new Map<string, WalkedFile[]>()
  for (const file of inventory) {
    const key = caseSensitive ? relativeBaseName(file.relativePath) : relativeBaseName(file.relativePath).toLowerCase()
    const list = basenameIndex.get(key) ?? []
    list.push(file)
    basenameIndex.set(key, list)
  }

  const resolved: ResolvedReference[] = []
  let checkedFiles = 0
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
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }
        // Software mode scans configuration formats only; other text files stay
        // in the inventory (health checks still work) but are not parsed.
        if (contentExtensionSet !== null && !contentExtensionSet.has(extensionOf(file.relativePath))) {
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }
        if (file.size > maxFileBytes) {
          addWarning(warnings, `文件过大，已跳过依赖文本扫描：${file.relativePath}`)
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }

        // Head sniff first: never load a binary/large file into memory here.
        let probe
        try {
          probe = await probeTextFile(file.absolutePath, budget)
        } catch (error) {
          if (isAbortError(error)) throw error
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }
        if (budgetExhausted(budget)) {
          return { checked: false, budgetExceeded: true, refs: [] as ResolvedReference[] }
        }
        if (probe.encoding === 'binary' || probe.encoding === 'unsupported') {
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }
        if (file.size > FULL_READ_MAX_BYTES) {
          addWarning(warnings, `文件较大（超过 16 MB），已跳过依赖文本扫描：${file.relativePath}`)
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }

        let read
        try {
          read = await readFullTextFile(file.absolutePath, budget)
        } catch {
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }
        if (read.kind === 'budget-exhausted') {
          return { checked: false, budgetExceeded: true, refs: [] as ResolvedReference[] }
        }
        if (read.kind !== 'text') {
          return { checked: false, budgetExceeded: false, refs: [] as ResolvedReference[] }
        }
        const lineStarts = buildLineStarts(read.text)
        const hits = extractReferences(read.text, rules, lineStarts, options.signal)
        const refs: ResolvedReference[] = []
        for (const hit of hits) {
          const analysis = analyzeReference(hit.raw)
          if (!analysis) continue
          if (analysis.style === 'basename') {
            const key = caseSensitive ? relativeBaseName(hit.raw) : relativeBaseName(hit.raw).toLowerCase()
            const matches = basenameIndex.get(key) ?? []
            if (matches.length !== 1) continue
            refs.push({
              source: file,
              hit,
              targetPath: matches[0]!.relativePath,
              existed: true,
              targetWasDirectory: false
            })
            continue
          }
          const existing = existsCandidate(analysis, file.relativePath, projectRoot)
          if (existing) {
            refs.push({
              source: file,
              hit,
              targetPath: existing.rel,
              existed: true,
              targetWasDirectory: existing.directory
            })
            continue
          }
          const missing = canonicalMissingPath(analysis, file.relativePath, projectRoot)
          if (!missing) continue
          refs.push({
            source: file,
            hit,
            targetPath: missing,
            existed: false,
            targetWasDirectory: false
          })
        }
        return { checked: true, budgetExceeded: false, refs }
      })
    )
    for (const outcome of outcomes) {
      if (outcome.checked) checkedFiles += 1
      if (outcome.budgetExceeded) budgetStopped = true
      resolved.push(...outcome.refs)
    }
    if (budgetStopped) break
  }

  if (budgetStopped) {
    addWarning(
      warnings,
      `已扫描 ${checkedFiles} 个文件，因扫描预算停止。1 GB 是单文件上限而不是推荐值；可减少项目内的超大文件后重试。`
    )
  }

  // Load optional policy file. It lets advanced users declare version/checksum
  // expectations; absent policy simply means those checks are skipped.
  let policy: DependencyPolicy | null = null
  const policyFile = inventoryByPath.get(POLICY_RELATIVE_PATH)
  if (policyFile) {
    if (policyFile.size > MAX_JSON_PARSE_BYTES) {
      addWarning(warnings, '依赖策略文件过大，已忽略版本策略。')
    } else {
      try {
        policy = parsePolicy(JSON.parse(await fsp.readFile(policyFile.absolutePath, 'utf8')))
      } catch {
        addWarning(warnings, '依赖策略文件 .pathkeeper/dependency-policy.json 无法解析，已忽略版本策略。')
      }
    }
  }
  const policyByPath = new Map(
    (policy?.dependencies ?? []).map((dependency) => [normalizeRelative(dependency.path), dependency])
  )

  // Nodes: referenced/source files first, then declared policy files, then
  // representative input/config/cache/output inventory files. The cap keeps the
  // graph responsive on very large projects.
  const nodeMap = new Map<string, DependencyNode>()
  const addNode = (relativePath: string): DependencyNode | null => {
    const normalized = normalizeRelative(relativePath)
    if (normalized.length === 0 || nodeMap.has(normalized)) return nodeMap.get(normalized) ?? null
    if (nodeMap.size >= MAX_NODES) {
      addWarning(warnings, `依赖节点超过 ${MAX_NODES} 个，关系图只展示前 ${MAX_NODES} 个。`)
      return null
    }
    const file = inventoryByPath.get(normalized)
    const role = policyByPath.get(normalized)?.role ?? classifyDependencyRole(normalized)
    const node: DependencyNode = {
      id: `node_${hashId(normalized)}`,
      path: normalized,
      name: relativeBaseName(normalized),
      role,
      health: file ? 'healthy' : 'missing',
      exists: Boolean(file),
      size: file?.size ?? null,
      modifiedAt: file ? new Date(file.mtimeMs).toISOString() : null,
      incoming: 0,
      outgoing: 0,
      candidates: [],
      details: []
    }
    nodeMap.set(normalized, node)
    return node
  }

  for (const ref of resolved) {
    addNode(ref.source.relativePath)
    addNode(ref.targetPath)
  }
  for (const dependency of policy?.dependencies ?? []) addNode(dependency.path)
  for (const file of inventory) {
    if (nodeMap.size >= MAX_NODES) break
    const role = classifyDependencyRole(file.relativePath)
    if (role === 'config' || role === 'cache' || role === 'output' || role === 'input') {
      addNode(file.relativePath)
    }
  }

  // Edges.
  const edges: DependencyEdge[] = []
  const seenEdges = new Set<string>()
  for (const ref of resolved) {
    const sourceNode = nodeMap.get(normalizeRelative(ref.source.relativePath))
    const targetNode = nodeMap.get(normalizeRelative(ref.targetPath))
    if (!sourceNode || !targetNode) continue
    const edgeKey = `${sourceNode.id}\u0000${targetNode.id}\u0000${ref.hit.line}\u0000${ref.hit.raw}`
    if (seenEdges.has(edgeKey)) continue
    if (edges.length >= MAX_EDGES) {
      addWarning(warnings, `依赖关系超过 ${MAX_EDGES} 条，只展示前 ${MAX_EDGES} 条。`)
      break
    }
    seenEdges.add(edgeKey)
    edges.push({
      id: `edge_${hashId(edgeKey)}`,
      from: sourceNode.id,
      to: targetNode.id,
      sourcePath: sourceNode.path,
      targetPath: targetNode.path,
      line: ref.hit.line,
      ruleName: ref.hit.rule.name,
      ruleCategory: ref.hit.rule.category as RuleCategory,
      rawText: ref.hit.raw,
      context: ref.hit.context
    })
    sourceNode.outgoing += 1
    targetNode.incoming += 1
  }

  // Health checks for existing nodes.
  const existingNodes = [...nodeMap.values()].filter((node) => node.exists)
  for (let offset = 0; offset < existingNodes.length; offset += READ_CONCURRENCY) {
    throwIfAborted(options.signal)
    const batch = existingNodes.slice(offset, offset + READ_CONCURRENCY)
    await Promise.all(
      batch.map(async (node) => {
        const file = inventoryByPath.get(node.path)
        if (!file) return
        const policyEntry = policyByPath.get(node.path)
        const check = await checkFileHealth(
          projectRoot,
          file,
          maxFileBytes,
          budget,
          options.signal,
          policyEntry?.expectedSha256
        )
        if (check.health === 'healthy' && policyEntry?.expectedSha256 && check.sha256) {
          if (check.sha256 !== policyEntry.expectedSha256) {
            node.health = 'corrupt'
            node.details = ['文件内容与策略中记录的 SHA-256 不一致']
          }
        }
        if (check.health === 'healthy' && policyEntry?.minVersion) {
          const versionCheckLimit = Math.min(maxFileBytes, MAX_JSON_PARSE_BYTES)
          if (file.size > versionCheckLimit) {
            node.details = [
              `未读取版本声明：文件 ${Math.ceil(file.size / 1024)} KB 超过检查上限 ${Math.floor(
                versionCheckLimit / 1024
              )} KB；策略要求至少 ${policyEntry.minVersion}`
            ]
          } else {
            const version = await readVersionFromJson(file.absolutePath, policyEntry.versionField)
            if (!version) {
              node.health = 'version-mismatch'
              node.details = [`策略要求至少 ${policyEntry.minVersion}，但文件没有声明版本`]
            } else if (compareVersions(version, policyEntry.minVersion) < 0) {
              node.health = 'version-mismatch'
              node.details = [`文件版本 ${version} 低于要求的 ${policyEntry.minVersion}`]
            }
          }
        }
        if (check.health !== 'healthy') {
          node.health = check.health
          node.details = check.details
        } else if (check.details.length > 0) {
          node.details = check.details
        }
      })
    )
  }

  // Mark ignored nodes and attach candidates to missing nodes.
  for (const node of nodeMap.values()) {
    if (!node.exists) {
      node.candidates = candidatesFor(node.path, inventory, caseSensitive)
    }
    if (ignoredPaths.has(node.path)) node.health = 'ignored'
  }

  // Build issues from nodes that are not healthy/ignored.
  const issues: DependencyIssue[] = []
  for (const node of nodeMap.values()) {
    if (node.health === 'healthy' || node.health === 'ignored') continue
    const relatedEdges = edges.filter((edge) => edge.to === node.id)
    // Don't complain about an unreferenced corrupt/format file that happened to
    // be swept in as a role sample; only report it when it is declared by the
    // policy or is otherwise referenced.
    if (relatedEdges.length === 0 && !policyByPath.has(node.path)) continue
    const copy = healthIssueCopy(node)
    const severity = issueSeverityForHealth(node.health, node.role)
    issues.push({
      id: `issue_${hashId(node.id)}`,
      nodeId: node.id,
      path: node.path,
      name: node.name,
      role: node.role,
      health: node.health,
      severity,
      title: copy.title,
      what: copy.what,
      why: copy.why,
      fixHint: copy.fixHint,
      candidates: node.candidates,
      references: relatedEdges.slice(0, MAX_REFERENCES_PER_ISSUE).map((edge) => ({
        filePath: edge.sourcePath,
        line: edge.line,
        column: 1,
        ruleName: edge.ruleName,
        ruleCategory: edge.ruleCategory,
        rawText: edge.rawText,
        context: edge.context
      })),
      canAutoFix: node.health === 'missing' && node.candidates.length > 0,
      canReselect: node.health === 'missing' || node.health === 'unreadable' || node.health === 'corrupt',
      canRebuildCache: node.role === 'cache' && node.exists,
      canSkip: true
    })
    if (issues.length >= MAX_ISSUES) break
  }
  issues.sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.path.localeCompare(right.path, 'zh-CN')
  )

  const roleCounts: Record<DependencyRole, number> = {
    config: 0,
    source: 0,
    input: 0,
    cache: 0,
    output: 0,
    unknown: 0
  }
  let healthyNodes = 0
  for (const node of nodeMap.values()) {
    roleCounts[node.role] += 1
    if (node.health === 'healthy') healthyNodes += 1
  }
  const summary: DependencySummary = {
    checkedFiles,
    totalNodes: nodeMap.size,
    totalEdges: edges.length,
    healthyNodes,
    issueCount: issues.length,
    autoFixable: issues.filter((issue) => issue.canAutoFix).length,
    ignoredCount: [...nodeMap.values()].filter((node) => node.health === 'ignored').length,
    roleCounts
  }

  return {
    projectId: Number(options.projectId) || 0,
    projectName: typeof options.projectName === 'string' ? options.projectName : '',
    projectRoot,
    nodes: [...nodeMap.values()],
    edges,
    issues,
    summary,
    warnings: warnings.slice(0, MAX_WARNINGS),
    durationMs: Date.now() - startedAt,
    budgetStopped,
    createdAt: new Date().toISOString()
  }
}

function severityRank(severity: DependencyIssueSeverity): number {
  if (severity === 'blocking') return 2
  if (severity === 'warning') return 1
  return 0
}

/** Used by the backend watcher: compare stored nodes with the disk. */
export function diffDependencyNode(
  projectRoot: string,
  node: Pick<DependencyNode, 'path' | 'exists' | 'size' | 'modifiedAt'>
): DependencyChange | null {
  const absolute = nodePath.resolve(projectRoot, ...node.path.split('/'))
  if (!isInside(projectRoot, absolute)) return null
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    if (node.exists) {
      return { path: node.path, kind: 'missing', before: '存在', after: null }
    }
    return null
  }
  if (!stats.isFile()) return null
  if (!node.exists) {
    return { path: node.path, kind: 'appeared', before: null, after: '出现' }
  }
  if (node.size !== stats.size || node.modifiedAt === null || Date.parse(node.modifiedAt) < stats.mtimeMs - 2000) {
    return { path: node.path, kind: 'modified', before: '旧版本', after: '已变化' }
  }
  return null
}
