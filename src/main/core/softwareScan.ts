/**
 * Software scan engine (“扫描一个软件”).
 *
 * This is the read-only core behind the software checkup: it reuses the existing
 * text-reference engine ({@link scanDependencies}) for configuration/script
 * paths and adds a bounded binary pass that reads the static PE import table of
 * the program's own `.exe`/`.dll` files and checks whether each imported DLL is
 * still present.
 *
 * Safety boundaries:
 * - never executes/loads the scanned software;
 * - never writes, never downloads/copies DLLs, never elevates;
 * - only a small, bounded number of binary files is inspected (8 by default),
 *   each with at most 256 import descriptors;
 * - anything that cannot be judged statically is reported honestly as
 *   “not analyzed / unavailable”, never as a false “missing DLL”.
 */

import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'
import type {
  BinaryDependency,
  BinaryDependencyOrigin,
  BinaryDependencyStatus,
  DependencyScanResult,
  IgnoreRule,
  MatchRule,
  SoftwareBinaryAnalysis,
  SoftwareInfo,
  SoftwareScanResult,
  SoftwareTextScanScope
} from '../../shared/types'
import { scanDependencies } from './dependencyScan'
import { CoreError, createAbortError, errorMessage, isAbortError } from './errors'
import { createIgnoreEvaluator, type IgnoreEvaluator } from './ignore'
import { isInside, toProjectRelative } from './path'
import { readPeImports } from './pe'

/** Maximum number of binary files parsed per report. */
export const SOFTWARE_BINARY_FILE_CAP = 8
/** Maximum import descriptors parsed per program. */
export const SOFTWARE_MAX_IMPORTS_PER_PROGRAM = 256
/** Maximum number of distinct DLL rows kept in one report. */
export const SOFTWARE_MAX_DEPENDENCIES = 512
/** Wall-clock budget for the binary pass. */
export const SOFTWARE_BINARY_TIME_BUDGET_MS = 15_000

/**
 * Configuration formats that are content-scanned by default in software mode.
 * Bundled scripts, logs and generated asset maps are resolved at runtime, so
 * reading them produced mostly false “missing file” reports.
 */
export const SOFTWARE_CONFIG_EXTENSIONS = [
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.config'
] as const

/** Software reports never list more text issues than this. */
export const SOFTWARE_TEXT_ISSUE_CAP = 80

/** Runtime/cache folders that never contain meaningful hand-written paths. */
const SOFTWARE_IGNORED_DIRS = [
  'logs',
  'log',
  'crashpad',
  'crashdumps',
  'gpucache',
  'code cache',
  'cache',
  'cacheddata',
  'blob_storage',
  'local storage',
  'session storage',
  'service worker',
  'temp',
  'tmp',
  '.tmp',
  // Vendored dependency payloads shipped inside installers (Python/Node/Electron).
  '_internal',
  'site-packages',
  'vendor',
  'third_party',
  'third-party',
  'bower_components',
  'dist-info',
  '.*',
  '*.dist-info',
  // Bundled language runtimes (Python/Node/Electron) — vendored code and docs.
  'lib',
  'lib64',
  'binaries',
  // Test fixtures are never needed by an installed program at runtime.
  'tests',
  'test',
  'spec',
  'specs'
] as const

/** Sidecar files of runtime data, never configuration. */
const SOFTWARE_IGNORED_SUFFIXES = ['.log', '.dmp', '.etl', '.asar'] as const

/**
 * Installer staging manifests describe how the setup package is laid out, not
 * how the installed program runs; their relative paths do not resolve against
 * the install folder and would only create false “missing file” reports.
 */
const SOFTWARE_IGNORED_FILENAMES = ['setup.json', 'uninstall.json', '[Content_Types].xml'] as const

/**
 * Rules that capture bare path-like tokens from prose, comments and generated
 * code. They are useful for hand-written project text but produce most of the
 * noise inside installed software, so the default software scope does not use
 * them (the “全部文本” scope does).
 */
const SOFTWARE_AMBIGUOUS_RULE_KEYS = new Set(['plain-path-token', 'plain-directory-token'])

/** Package/manifest files of OOXML/docx trees: their relative refs are zipped. */
const SOFTWARE_IGNORED_SOURCE_NAMES = new Set(['[content_types].xml'])

function isIgnoredSoftwareSource(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const base = (normalized.split('/').pop() ?? '').toLowerCase()
  if (SOFTWARE_IGNORED_SOURCE_NAMES.has(base)) return true
  return base.endsWith('.rels')
}

const BINARY_EXTENSIONS = new Set(['.exe', '.dll'])
const COMMON_BINARY_SUBDIRS = ['bin', 'lib', 'runtime', 'plugins'] as const
const MAX_WARNINGS = 100
const MAX_PATH_DIRS = 64

/**
 * Known Windows system components. These are expected to come from the OS /
 * a redistributable, so a missing one is a system/runtime problem and must never
 * be presented as “the software is missing its own file”.
 */
const KNOWN_SYSTEM_STEMS = new Set([
  'kernel32',
  'kernelbase',
  'user32',
  'gdi32',
  'gdiplus',
  'advapi32',
  'shell32',
  'shlwapi',
  'ole32',
  'oleaut32',
  'msvcrt',
  'ntdll',
  'comctl32',
  'comdlg32',
  'combase',
  'ws2_32',
  'wsock32',
  'mswsock',
  'winmm',
  'version',
  'psapi',
  'dbghelp',
  'wininet',
  'winhttp',
  'bcrypt',
  'ncrypt',
  'crypt32',
  'secur32',
  'iphlpapi',
  'uxtheme',
  'dwmapi',
  'mscoree',
  'ucrtbase',
  'opengl32',
  'dxgi',
  'd3d9',
  'd3d10',
  'd3d11',
  'd3d12',
  'd3dcompiler_43',
  'd3dcompiler_47',
  'dxva2',
  'dwrite',
  'd2d1',
  'mfuuid',
  'mfplat',
  'mfreadwrite',
  'mfcore',
  'mfplay',
  'mfmediaengine',
  'rpcrt4',
  'sechost',
  'cfgmgr32',
  'setupapi',
  'wintrust',
  'normaliz',
  'powrprof',
  'profapi',
  'wtsapi32',
  'userenv',
  'netapi32',
  'wldap32',
  'imm32',
  'msimg32',
  'usp10',
  'dnsapi',
  'winspool',
  'winscard',
  'hid',
  'propsys',
  'synchronization',
  'mswsock',
  'urlmon',
  'winhttp',
  'sspicli',
  'bcryptprimitives'
])
const KNOWN_SYSTEM_PREFIXES = [
  'api-ms-win-',
  'ext-ms-',
  'msvcp',
  'msvcr',
  'vcruntime',
  'vcomp',
  'mfc',
  'd3d',
  'dxgi',
  'dwrite',
  'd2d1'
] as const

export interface SoftwareScanOptions {
  projectId: number
  projectName: string
  installRoot: string
  entryPath: string | null
  includeBinary: boolean
  rules: MatchRule[]
  ignoreRules: IgnoreRule[]
  caseSensitive: boolean
  maxFileSizeKb: number
  /** Install-root-relative POSIX paths the user chose to skip in the text pass. */
  ignoredPaths?: string[]
  signal?: AbortSignal
}

/**
 * `scanSoftwarePackage` input. The extra `info` lets the service pass the
 * version metadata it already read during inspection and avoid a second
 * PowerShell metadata query; when omitted the result carries empty info fields.
 */
export interface SoftwareScanInput extends SoftwareScanOptions {
  info?: SoftwareInfo | null
  /** Text-reference scope; defaults to `config`. */
  textScan?: SoftwareTextScanScope
}

export interface SoftwareBinaryAnalysisInput {
  installRoot: string
  entryPath: string | null
  signal?: AbortSignal
  /** Test seam: override the 8-file cap. Values are clamped to 1…64. */
  maxBinaryFiles?: number
  /** Test seam: override the Windows directory used for System32/SysWOW64. */
  systemRoot?: string
  /** Test seam: override the PATH entries searched last. */
  pathDirs?: string[]
}

export interface SoftwareBinaryAnalysisResult {
  binaryAnalysis: SoftwareBinaryAnalysis
  /** Program files parsed for imports, relative to the install root. */
  binaryFilesScanned: string[]
  binaryDependencies: BinaryDependency[]
  binaryCapHit: boolean
  warnings: string[]
}

interface BinaryCandidate {
  absolutePath: string
  relativePath: string
}

interface DllResolution {
  resolvedPath: string | null
  /** Where the file was found; null means “not found”. */
  location: 'app-local' | 'system' | 'path' | null
}

type DirectoryIndex = Map<string, string>

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw createAbortError()
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length >= MAX_WARNINGS) return
  if (warnings.includes(message)) return
  warnings.push(message)
}

function normalizeTextScanScope(value: unknown): SoftwareTextScanScope {
  return value === 'all' || value === 'off' ? value : 'config'
}

/**
 * Add software-only ignore rules on top of the project's rules. Runtime data
 * folders (logs, caches, session storage) never hold hand-written paths, and
 * skipping them keeps the walk fast and the report quiet.
 */
function buildSoftwareIgnoreRules(base: readonly IgnoreRule[]): IgnoreRule[] {
  const extra: IgnoreRule[] = []
  let order = 10_000
  for (const pattern of SOFTWARE_IGNORED_DIRS) {
    extra.push({
      id: -(order),
      projectId: 0,
      pattern,
      kind: 'dir',
      label: `软件体检默认跳过 ${pattern}`,
      enabled: true,
      builtin: false,
      sortOrder: order,
      createdAt: ''
    })
    order += 1
  }
  for (const pattern of SOFTWARE_IGNORED_SUFFIXES) {
    extra.push({
      id: -(order),
      projectId: 0,
      pattern,
      kind: 'suffix',
      label: `软件体检默认跳过 ${pattern}`,
      enabled: true,
      builtin: false,
      sortOrder: order,
      createdAt: ''
    })
    order += 1
  }
  for (const pattern of SOFTWARE_IGNORED_FILENAMES) {
    extra.push({
      id: -(order),
      projectId: 0,
      pattern,
      kind: 'glob',
      label: `软件体检默认跳过安装器清单 ${pattern}`,
      enabled: true,
      builtin: false,
      sortOrder: order,
      createdAt: ''
    })
    order += 1
  }
  return [...base, ...extra]
}

/**
 * True when a project-relative *target* path lives in an ignored folder.
 *
 * Only directory rules are considered here: suffix rules ("don't read .png
 * files") describe source files, but an image/model file is still a legitimate
 * dependency target and must not disappear from the report.
 */
function isIgnoredSoftwareTarget(ignore: IgnoreEvaluator, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (normalized.length === 0) return false
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  let prefix = ''
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? ''
    prefix = prefix.length > 0 ? `${prefix}/${segment}` : segment
    if (ignore.isIgnoredDirectory(segment, prefix)) return true
  }
  return false
}

function severityRank(severity: 'blocking' | 'warning' | 'info'): number {
  return severity === 'blocking' ? 0 : severity === 'warning' ? 1 : 2
}

interface FilteredTextReport {
  report: DependencyScanResult
  skipped: number
  truncated: boolean
}

/**
 * Drop references that point into ignored/cache folders (they are not real
 * problems for a read-only software checkup), keep actionable items first and
 * cap the report so a bundled web app cannot flood the UI with noise.
 */
function filterSoftwareTextReport(
  report: DependencyScanResult,
  ignoreRules: readonly IgnoreRule[]
): FilteredTextReport {
  // Directory rules only: see isIgnoredSoftwareTarget.
  const ignore = createIgnoreEvaluator(
    ignoreRules.filter((rule) => rule.kind === 'dir')
  )
  const kept: DependencyScanResult['issues'] = []
  let skipped = 0
  for (const issue of report.issues) {
    if (isIgnoredSoftwareTarget(ignore, issue.path)) {
      skipped += 1
      continue
    }
    if (
      issue.references.length > 0 &&
      issue.references.every((reference) => isIgnoredSoftwareSource(reference.filePath))
    ) {
      skipped += 1
      continue
    }
    kept.push(issue)
  }
  kept.sort((left, right) => {
    const leftActionable = left.candidates.length > 0 ? 0 : 1
    const rightActionable = right.candidates.length > 0 ? 0 : 1
    return (
      leftActionable - rightActionable ||
      severityRank(left.severity) - severityRank(right.severity) ||
      compareText(left.path, right.path)
    )
  })
  const truncated = kept.length > SOFTWARE_TEXT_ISSUE_CAP
  const visible = truncated ? kept.slice(0, SOFTWARE_TEXT_ISSUE_CAP) : kept
  const next: DependencyScanResult = {
    ...report,
    issues: visible,
    summary: {
      ...report.summary,
      issueCount: visible.length,
      autoFixable: visible.filter((issue) => issue.canAutoFix).length
    }
  }
  return { report: next, skipped, truncated }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function extensionOf(fileName: string): string {
  return nodePath.extname(fileName).toLowerCase()
}

function dllStem(name: string): string {
  const base = nodePath.basename(name).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function isApiSetModule(name: string): boolean {
  const lower = nodePath.basename(name).toLowerCase()
  return lower.startsWith('api-ms-win-') || lower.startsWith('ext-ms-')
}

/** True when the module is expected to come from Windows / a VC++ runtime. */
export function isKnownSystemModule(name: string): boolean {
  if (isApiSetModule(name)) return true
  const stem = dllStem(name)
  if (KNOWN_SYSTEM_STEMS.has(stem)) return true
  return KNOWN_SYSTEM_PREFIXES.some((prefix) => stem.startsWith(prefix))
}

function normalizeMaxBinaryFiles(value: unknown): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : SOFTWARE_BINARY_FILE_CAP
  return Math.min(Math.max(parsed, 1), 64)
}

/** Index a directory into lowercase-name → absolute path. Missing dirs map empty. */
async function indexDirectory(absDir: string): Promise<DirectoryIndex> {
  const files: DirectoryIndex = new Map()
  try {
    const entries = await fsp.readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      // Never follow symbolic links here: the scan is read-only and must not
      // wander outside the install root through a crafted link.
      if (!entry.isFile()) continue
      files.set(entry.name.toLowerCase(), nodePath.join(absDir, entry.name))
    }
  } catch {
    // Missing or unreadable directories simply do not contribute matches.
  }
  return files
}

function buildPathDirs(override?: string[]): string[] {
  if (Array.isArray(override)) {
    return override
      .filter((dir): dir is string => typeof dir === 'string' && nodePath.isAbsolute(dir))
      .slice(0, MAX_PATH_DIRS)
  }
  const raw = process.env['PATH'] ?? process.env['Path'] ?? ''
  const dirs: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(';')) {
    const cleaned = part.trim().replace(/^"(.*)"$/, '$1')
    if (cleaned.length === 0 || !nodePath.isAbsolute(cleaned)) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(cleaned)
    if (dirs.length >= MAX_PATH_DIRS) break
  }
  return dirs
}

/**
 * DLL resolution order required by the plan: install root → common subdirs
 * (`bin`/`lib`/`runtime`/`plugins`) → `System32` → `SysWOW64` → `PATH`.
 * Directory listings are cached, so a report costs a handful of readdirs.
 */
async function createDllResolver(input: SoftwareBinaryAnalysisInput): Promise<(name: string) => Promise<DllResolution>> {
  const installRoot = nodePath.resolve(input.installRoot)
  const rootIndex = await indexDirectory(installRoot)
  const subdirIndexes = new Map<string, DirectoryIndex>()
  const systemRoot = input.systemRoot ?? process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  let system32Index: DirectoryIndex | null = null
  let syswow64Index: DirectoryIndex | null = null
  const pathDirs = buildPathDirs(input.pathDirs)

  return async (name: string): Promise<DllResolution> => {
    throwIfAborted(input.signal)
    const lower = nodePath.basename(name).toLowerCase()
    const inRoot = rootIndex.get(lower)
    if (inRoot) return { resolvedPath: inRoot, location: 'app-local' }
    for (const subdir of COMMON_BINARY_SUBDIRS) {
      let index = subdirIndexes.get(subdir)
      if (!index) {
        index = await indexDirectory(nodePath.join(installRoot, subdir))
        subdirIndexes.set(subdir, index)
      }
      const found = index.get(lower)
      if (found) return { resolvedPath: found, location: 'app-local' }
    }
    if (system32Index === null) system32Index = await indexDirectory(nodePath.join(systemRoot, 'System32'))
    const inSystem32 = system32Index.get(lower)
    if (inSystem32) return { resolvedPath: inSystem32, location: 'system' }
    if (syswow64Index === null) syswow64Index = await indexDirectory(nodePath.join(systemRoot, 'SysWOW64'))
    const inSyswow64 = syswow64Index.get(lower)
    if (inSyswow64) return { resolvedPath: inSyswow64, location: 'system' }
    for (const dir of pathDirs) {
      throwIfAborted(input.signal)
      const candidate = nodePath.join(dir, name)
      try {
        const stats = await fsp.stat(candidate)
        if (stats.isFile()) return { resolvedPath: candidate, location: 'path' }
      } catch {
        // Not in this PATH entry.
      }
    }
    return { resolvedPath: null, location: null }
  }
}

function classifyResolvedModule(
  name: string,
  resolution: DllResolution
): { origin: BinaryDependencyOrigin; status: BinaryDependencyStatus } {
  const knownSystem = isKnownSystemModule(name)
  // API Set contracts are resolved by the loader from the OS; never report them
  // as missing even though no file with that name exists on disk.
  if (isApiSetModule(name)) return { origin: 'system', status: 'ok' }
  if (resolution.location === 'app-local') return { origin: 'app-local', status: 'ok' }
  if (resolution.location === 'system') return { origin: 'system', status: 'ok' }
  if (resolution.location === 'path') {
    // Found on PATH: it resolves, but we cannot prove where it came from.
    return { origin: knownSystem ? 'system' : 'unknown', status: 'ok' }
  }
  if (knownSystem) return { origin: 'system', status: 'missing' }
  return { origin: 'app-local', status: 'missing' }
}

function dependencySortRank(item: BinaryDependency): number {
  const statusRank = item.status === 'missing' ? 0 : item.status === 'unknown' ? 1 : 2
  const originRank = item.origin === 'app-local' ? 0 : item.origin === 'unknown' ? 1 : 2
  return statusRank * 3 + originRank
}

async function collectBinaryCandidates(
  installRoot: string,
  entryPath: string | null,
  warnings: string[]
): Promise<BinaryCandidate[]> {
  const candidates: BinaryCandidate[] = []
  const seen = new Set<string>()
  const add = (absolutePath: string): void => {
    const key = absolutePath.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      absolutePath,
      relativePath: normalizeRelativePath(toProjectRelative(installRoot, absolutePath))
    })
  }

  if (entryPath && extensionOf(entryPath) === '.exe') {
    add(entryPath)
  }
  let rootBinaries: string[] = []
  try {
    const entries = await fsp.readdir(installRoot, { withFileTypes: true })
    rootBinaries = entries
      .filter((entry) => entry.isFile() && BINARY_EXTENSIONS.has(extensionOf(entry.name)))
      .map((entry) => entry.name)
      .sort(compareText)
  } catch (error) {
    addWarning(warnings, `无法读取软件安装目录：${errorMessage(error)}`)
    return candidates
  }
  for (const name of rootBinaries) add(nodePath.join(installRoot, name))
  return candidates
}

/**
 * Analyse only the binary side of a software report. Exported separately so the
 * service can run it independently from the text pass and merge the fields into
 * a {@link SoftwareScanResult}.
 *
 * - Only the entry `.exe` plus root-level `.exe`/`.dll` files are inspected.
 * - At most {@link SOFTWARE_BINARY_FILE_CAP} files, 256 imports per program and
 *   512 DLL rows are kept; hitting a cap is reported via `binaryCapHit` + a
 *   Chinese warning, never silently.
 * - Throws only for an invalid install root or an aborted signal.
 */
export async function analyzeSoftwareBinary(
  input: SoftwareBinaryAnalysisInput
): Promise<SoftwareBinaryAnalysisResult> {
  const startedAt = Date.now()
  const warnings: string[] = []
  const empty: SoftwareBinaryAnalysisResult = {
    binaryAnalysis: 'unavailable',
    binaryFilesScanned: [],
    binaryDependencies: [],
    binaryCapHit: false,
    warnings
  }
  if (!input || typeof input !== 'object') {
    throw new CoreError('INVALID_PROJECT_ROOT', '软件扫描参数无效。')
  }
  if (typeof input.installRoot !== 'string' || input.installRoot.trim().length === 0) {
    throw new CoreError('INVALID_PROJECT_ROOT', '软件安装目录不能为空。')
  }
  const installRoot = nodePath.resolve(input.installRoot.trim())
  try {
    const stats = await fsp.stat(installRoot)
    if (!stats.isDirectory()) {
      throw new CoreError('INVALID_PROJECT_ROOT', '软件安装目录不是文件夹。')
    }
  } catch (error) {
    if (error instanceof CoreError) throw error
    throw new CoreError('INVALID_PROJECT_ROOT', `无法读取软件安装目录：${errorMessage(error)}`)
  }
  throwIfAborted(input.signal)

  const fileCap = normalizeMaxBinaryFiles(input.maxBinaryFiles)
  const candidates = await collectBinaryCandidates(installRoot, input.entryPath, warnings)
  if (candidates.length === 0) {
    addWarning(warnings, '在软件安装目录顶层没有找到可分析的 .exe / .dll 程序文件，无法检查 DLL 依赖。')
    return empty
  }

  let binaryCapHit = false
  if (candidates.length > fileCap) {
    binaryCapHit = true
    addWarning(warnings, `安装目录顶层共有 ${candidates.length} 个程序文件，最多分析 ${fileCap} 个，其余已跳过。`)
  }
  const selected = candidates.slice(0, fileCap)

  const aggregate = new Map<
    string,
    { name: string; importedBy: string[]; resolution: DllResolution | null }
  >()
  const resolveDll = await createDllResolver(input)
  const scannedFiles: string[] = []
  let parsedFiles = 0
  for (const candidate of selected) {
    throwIfAborted(input.signal)
    if (Date.now() - startedAt > SOFTWARE_BINARY_TIME_BUDGET_MS) {
      binaryCapHit = true
      addWarning(warnings, '程序导入分析超过时间预算（15 秒），已停止剩余文件，这是部分结果。')
      break
    }
    let result
    try {
      result = await readPeImports(candidate.absolutePath, {
        maxImports: SOFTWARE_MAX_IMPORTS_PER_PROGRAM,
        ...(input.signal ? { signal: input.signal } : {})
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      addWarning(warnings, `读取程序「${candidate.relativePath}」失败：${errorMessage(error)}`)
      continue
    }
    for (const warning of result.warnings) {
      addWarning(warnings, `程序「${candidate.relativePath}」：${warning}`)
    }
    if (result.truncated) {
      binaryCapHit = true
      addWarning(warnings, `程序「${candidate.relativePath}」的导入项超过上限，只分析了前 ${SOFTWARE_MAX_IMPORTS_PER_PROGRAM} 个。`)
    }
    if (result.status !== 'parsed') {
      addWarning(warnings, `无法解析程序「${candidate.relativePath}」的导入表：${result.reason}`)
      continue
    }
    parsedFiles += 1
    scannedFiles.push(candidate.relativePath)
    for (const name of result.imports) {
      const key = name.toLowerCase()
      let entry = aggregate.get(key)
      if (!entry) {
        entry = { name, importedBy: [], resolution: null }
        aggregate.set(key, entry)
      }
      if (!entry.importedBy.includes(candidate.relativePath)) {
        entry.importedBy.push(candidate.relativePath)
      }
    }
  }

  if (parsedFiles === 0) {
    return {
      binaryAnalysis: 'unavailable',
      binaryFilesScanned: [],
      binaryDependencies: [],
      binaryCapHit,
      warnings
    }
  }

  const dependencies: BinaryDependency[] = []
  for (const entry of aggregate.values()) {
    throwIfAborted(input.signal)
    const resolution = entry.resolution ?? (await resolveDll(entry.name))
    entry.resolution = resolution
    const classification = classifyResolvedModule(entry.name, resolution)
    dependencies.push({
      name: entry.name,
      resolvedPath: resolution.resolvedPath,
      origin: classification.origin,
      status: classification.status,
      importedBy: [...entry.importedBy].sort(compareText)
    })
  }
  dependencies.sort(
    (left, right) =>
      dependencySortRank(left) - dependencySortRank(right) ||
      left.name.localeCompare(right.name, 'zh-CN')
  )
  if (dependencies.length > SOFTWARE_MAX_DEPENDENCIES) {
    binaryCapHit = true
    addWarning(
      warnings,
      `DLL 依赖共有 ${dependencies.length} 项，超过上限 ${SOFTWARE_MAX_DEPENDENCIES} 项，只展示前 ${SOFTWARE_MAX_DEPENDENCIES} 项。`
    )
  }

  return {
    binaryAnalysis: 'analyzed',
    binaryFilesScanned: scannedFiles,
    binaryDependencies: dependencies.slice(0, SOFTWARE_MAX_DEPENDENCIES),
    binaryCapHit,
    warnings
  }
}

function emptySoftwareInfo(entryPath: string | null): SoftwareInfo {
  return {
    productName: null,
    fileDescription: null,
    productVersion: null,
    companyName: null,
    entryPath,
    iconDataUrl: null
  }
}

function normalizeEntryPath(
  installRoot: string,
  entryPath: string | null | undefined,
  warnings: string[]
): string | null {
  if (typeof entryPath !== 'string' || entryPath.trim().length === 0) return null
  const raw = entryPath.trim()
  const absolute = nodePath.isAbsolute(raw) ? nodePath.resolve(raw) : nodePath.resolve(installRoot, raw)
  if (!isInside(installRoot, absolute)) {
    addWarning(warnings, '程序入口不在软件安装目录内，已忽略入口文件；仍会扫描安装目录。')
    return null
  }
  return absolute
}

/**
 * Scan one installed program: text references (existing engine) + binary DLL
 * dependencies. Pure Node core, read-only, deterministic; never starts the
 * scanned software.
 */
export async function scanSoftwarePackage(options: SoftwareScanInput): Promise<SoftwareScanResult> {
  if (!options || typeof options !== 'object') {
    throw new CoreError('INVALID_PATH', '软件扫描参数无效。')
  }
  if (typeof options.installRoot !== 'string' || options.installRoot.trim().length === 0) {
    throw new CoreError('INVALID_PROJECT_ROOT', '软件安装目录不能为空。')
  }
  const startedAt = Date.now()
  const installRoot = nodePath.resolve(options.installRoot.trim())
  const warnings: string[] = []
  try {
    const stats = await fsp.stat(installRoot)
    if (!stats.isDirectory()) {
      throw new CoreError('INVALID_PROJECT_ROOT', '软件安装目录不是文件夹。')
    }
  } catch (error) {
    if (error instanceof CoreError) throw error
    throw new CoreError('INVALID_PROJECT_ROOT', `无法读取软件安装目录：${errorMessage(error)}`)
  }
  throwIfAborted(options.signal)
  const entryPath = normalizeEntryPath(installRoot, options.entryPath, warnings)
  const textScan = normalizeTextScanScope(options.textScan)
  const softwareIgnoreRules = buildSoftwareIgnoreRules(
    Array.isArray(options.ignoreRules) ? options.ignoreRules : []
  )
  const baseRules = Array.isArray(options.rules) ? options.rules : []
  // Config scope skips ambiguous “bare token” rules: comments, license text and
  // installer metadata would otherwise be reported as missing files.
  const textRules =
    textScan === 'config'
      ? baseRules.filter((rule) => !SOFTWARE_AMBIGUOUS_RULE_KEYS.has(rule.ruleKey ?? ''))
      : baseRules

  let textReport: DependencyScanResult | null = null
  let textIssuesSkipped = 0
  let textIssuesTruncated = false

  if (textScan === 'off') {
    addWarning(warnings, '这次没有检查配置里的文本路径引用（你选择了“不检查”）。')
  } else {
    try {
      const rawReport = await scanDependencies({
        projectId: options.projectId,
        projectName: options.projectName,
        projectRoot: installRoot,
        rules: textRules,
        ignoreRules: softwareIgnoreRules,
        caseSensitive: options.caseSensitive === true,
        maxFileSizeKb: options.maxFileSizeKb,
        ...(textScan === 'config'
          ? { contentExtensions: [...SOFTWARE_CONFIG_EXTENSIONS] }
          : {}),
        ...(options.ignoredPaths ? { ignoredPaths: options.ignoredPaths } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
      const filtered = filterSoftwareTextReport(rawReport, softwareIgnoreRules)
      textReport = filtered.report
      textIssuesSkipped = filtered.skipped
      textIssuesTruncated = filtered.truncated
      if (textIssuesSkipped > 0) {
        addWarning(
          warnings,
          `另有 ${textIssuesSkipped} 条引用指向日志/缓存/被忽略的目录，未计入路径问题。`
        )
      }
      if (textIssuesTruncated) {
        addWarning(
          warnings,
          `文本路径问题较多，报告只展示前 ${SOFTWARE_TEXT_ISSUE_CAP} 项（可处理项优先）。`
        )
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'NO_RULES') {
        addWarning(warnings, '没有启用的匹配规则，已跳过文本路径引用检查。')
      } else {
        addWarning(warnings, `文本路径引用检查失败：${errorMessage(error)}`)
      }
      textReport = null
    }
  }

  let binary: SoftwareBinaryAnalysisResult
  if (options.includeBinary === true) {
    try {
      binary = await analyzeSoftwareBinary({
        installRoot,
        entryPath,
        ...(options.signal ? { signal: options.signal } : {})
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      binary = {
        binaryAnalysis: 'unavailable',
        binaryFilesScanned: [],
        binaryDependencies: [],
        binaryCapHit: false,
        warnings: []
      }
      addWarning(warnings, `程序导入分析失败：${errorMessage(error)}`)
    }
  } else {
    binary = {
      binaryAnalysis: 'not-analyzed',
      binaryFilesScanned: [],
      binaryDependencies: [],
      binaryCapHit: false,
      warnings: []
    }
    // Keep the honest P0 limitation visible in exported reports, not only in UI copy.
    addWarning(warnings, '当前未分析 exe/dll 导入表，本次报告只包含文本路径引用。')
  }
  for (const warning of binary.warnings) addWarning(warnings, warning)

  const info: SoftwareInfo = options.info
    ? { ...options.info, entryPath }
    : emptySoftwareInfo(entryPath)

  return {
    projectId: Number(options.projectId) || 0,
    projectName: typeof options.projectName === 'string' ? options.projectName : '',
    installRoot,
    entryPath,
    info,
    binaryAnalysis: binary.binaryAnalysis,
    binaryFilesScanned: binary.binaryFilesScanned,
    binaryDependencies: binary.binaryDependencies,
    binaryCapHit: binary.binaryCapHit,
    textScanScope: textScan,
    textIssuesSkipped,
    textIssuesTruncated,
    textReport,
    warnings: warnings.slice(0, MAX_WARNINGS),
    durationMs: Date.now() - startedAt,
    createdAt: new Date().toISOString()
  }
}
