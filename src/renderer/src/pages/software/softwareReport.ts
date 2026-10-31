/**
 * Pure helpers behind the “扫描一个软件” report (plan A5/A6).
 *
 * Everything here is presentation logic only: display names, status labels,
 * grouping for the DLL report, the safety copy and the Markdown/JSON export
 * builders. No React and no IPC calls live in this module.
 */

import type {
  BinaryDependency,
  BinaryDependencyOrigin,
  BinaryDependencyStatus,
  DependencyCandidate,
  DependencyIssue,
  DependencyReference,
  SoftwareInfo,
  SoftwareScanResult,
  SoftwareTextScanScope
} from '@shared/types'
import {
  IF_IGNORED_WITHOUT_CANDIDATES,
  STATIC_CHECK_LIMIT_NOTE,
  UNKNOWN_ENGLISH_TITLE,
  humanizeCandidateExplanation,
  humanizeFileView,
  humanizeMissingReason,
  humanizeReferenceUsage,
  humanizeSoftwareFile,
  type HumanConfidence,
  type HumanSoftwareFileView
} from '@shared/fileHumanize'
import { formatDateTime, formatDuration, sanitizeFileName, timestampSlug } from '@renderer/lib/format'

/* ------------------------------------------------------------------ */
/* Safety copy (plan A6) — shown on the page and kept in exports       */
/* ------------------------------------------------------------------ */

export const READ_ONLY_PLEDGE =
  '只读体检：不会启动、不会修改这个软件。这个页面没有任何写入操作。'

export const SAFETY_POINTS: ReadonlyArray<string> = [
  '不启动目标程序，也不调用它的任何代码',
  '不修改软件目录里的文件',
  '不自动下载 DLL 或运行库',
  '不自动提权，不会弹 UAC 要求管理员权限',
  '其他页面的所有写入仍需预检 + 二次确认 + 自动备份'
]

/** Static-check limitations; always visible in the “无法判断” disclosure. */
export const STATIC_CHECK_LIMITS: ReadonlyArray<string> = [
  '运行时用 LoadLibrary 等接口动态加载的 DLL，静态检查通常发现不了。',
  '.NET、Electron、Java 等运行时自己解析的插件与程序集，不在本次检查范围内。',
  '从注册表、环境变量或配置文件里间接读取的路径，可能无法完整识别。',
  '加壳、损坏或非标准格式的程序，可能无法解析导入表。',
  '本次体检不会启动目标软件，所以无法验证“运行起来是否真的正常”。'
]

export const SYSTEM_MISSING_ADVICE =
  '请重新安装软件或对应运行库（如 VC++ Redistributable）。PathKeeper 不会自动下载或修复系统文件。'
export const APP_LOCAL_MISSING_ADVICE =
  '在软件目录里找找同名文件，或向软件作者确认。PathKeeper 不会自动复制 DLL。'
export const UNKNOWN_MISSING_ADVICE =
  '静态检查无法判断它应该来自哪里。建议运行一次软件确认，或向软件作者确认。'

/* ------------------------------------------------------------------ */
/* Path / name helpers                                                 */
/* ------------------------------------------------------------------ */

export function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

export function basenameOf(value: string): string {
  const normalized = stripTrailingSeparators(value).replace(/\\/g, '/')
  const parts = normalized.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? normalized
}

/** Best-effort program name: product name, then description, then file name. */
export function softwareDisplayName(
  info: SoftwareInfo | null | undefined,
  fallback: string
): string {
  const product = info?.productName?.trim()
  if (product) return product
  const description = info?.fileDescription?.trim()
  if (description) return description
  const entry = info?.entryPath?.trim()
  if (entry) return basenameOf(entry)
  const fallbackName = fallback.trim()
  return fallbackName.length > 0 ? fallbackName : '未知软件'
}

export function softwareVersionLabel(info: SoftwareInfo | null | undefined): string {
  const version = info?.productVersion?.trim()
  return version && version.length > 0 ? version : '未知版本'
}

export function softwarePublisherLabel(info: SoftwareInfo | null | undefined): string {
  const company = info?.companyName?.trim()
  return company && company.length > 0 ? company : '未能读取发布者'
}

/* ------------------------------------------------------------------ */
/* Binary dependency presentation                                      */
/* ------------------------------------------------------------------ */

export interface OriginMeta {
  title: string
  hint: string
  technical: string
}

export const ORIGIN_META: Record<BinaryDependencyOrigin, OriginMeta> = {
  'app-local': {
    title: '软件自带',
    hint: '这些文件通常应该在软件自己的安装目录里；缺失一般意味着安装不完整或文件被误删。',
    technical: 'app-local：优先在软件目录和常见子目录（bin/lib/runtime/plugins）中查找'
  },
  system: {
    title: '系统组件',
    hint: '这些通常由 Windows 或运行库（如 VC++ Redistributable）提供，缺失通常是系统或运行库问题。',
    technical: 'system：在 Windows System32 / SysWOW64 / PATH 中查找'
  },
  unknown: {
    title: '无法判断',
    hint: '静态检查无法确认它应该来自哪里，所以只做提示、不下结论。',
    technical: 'unknown：未能在常见位置确认来源'
  }
}

export const ORIGIN_ORDER: ReadonlyArray<BinaryDependencyOrigin> = [
  'app-local',
  'system',
  'unknown'
]

export const STATUS_LABEL: Record<BinaryDependencyStatus, string> = {
  ok: '已找到',
  missing: '缺失',
  unknown: '未确认'
}

export function binaryAdvice(dependency: BinaryDependency): string {
  if (dependency.status !== 'missing') {
    if (dependency.status === 'unknown') {
      return '这个依赖的状态无法确认，只作为提示，不代表一定有问题。'
    }
    return '已找到这个文件，不需要处理。'
  }
  if (dependency.origin === 'system') return SYSTEM_MISSING_ADVICE
  if (dependency.origin === 'app-local') return APP_LOCAL_MISSING_ADVICE
  return UNKNOWN_MISSING_ADVICE
}

export interface BinaryDependencyGroup {
  origin: BinaryDependencyOrigin
  title: string
  hint: string
  missing: BinaryDependency[]
  found: BinaryDependency[]
}

export function groupBinaryDependencies(
  dependencies: ReadonlyArray<BinaryDependency>
): BinaryDependencyGroup[] {
  return ORIGIN_ORDER.map((origin) => ({
    origin,
    title: ORIGIN_META[origin].title,
    hint: ORIGIN_META[origin].hint,
    missing: dependencies.filter(
      (dependency) => dependency.origin === origin && dependency.status === 'missing'
    ),
    found: dependencies.filter(
      (dependency) => dependency.origin === origin && dependency.status !== 'missing'
    )
  }))
}

export function countMissingBinary(dependencies: ReadonlyArray<BinaryDependency>): number {
  return dependencies.filter((dependency) => dependency.status === 'missing').length
}

export const BINARY_ANALYSIS_LABEL: Record<SoftwareScanResult['binaryAnalysis'], string> = {
  analyzed: '已分析 exe/dll 导入表',
  'not-analyzed': '当前未分析 exe/dll 导入表',
  unavailable: '这次无法分析 exe/dll 导入表'
}

/** P0 fallback copy when the user (or the backend) skipped binary analysis. */
export const NOT_ANALYZED_NOTE =
  '当前未分析 exe/dll 导入表。这次没有检查程序导入的文件（DLL）；可以在上方勾选“检查程序导入的文件（DLL）”后重新体检。'

export const UNAVAILABLE_NOTE =
  '这次无法分析 exe/dll 导入表。可能因为程序不是标准 Windows 程序、被加壳，或者读取被系统拒绝。PathKeeper 不会为此猜测，也不会误报。'

/* ------------------------------------------------------------------ */
/* Text-reference issue presentation                                   */
/* ------------------------------------------------------------------ */

const HEALTH_SUFFIX: Record<DependencyIssue['health'], string> = {
  healthy: '现在看起来正常',
  missing: '现在不在原来的位置',
  unreadable: '暂时读不出来',
  corrupt: '可能已经损坏',
  'format-mismatch': '的格式和扩展名对不上',
  'version-mismatch': '的版本对不上',
  ignored: '已经先跳过了'
}

/** Beginner-readable issue heading built from the shared humanizer. */
export function humanIssueTitle(issue: DependencyIssue): string {
  const view = humanizeFileView(issue.path, { role: issue.role })
  if (issue.health === 'missing') {
    return view.title === UNKNOWN_ENGLISH_TITLE
      ? `找不到这个「${view.typeLabel}」`
      : `找不到这个「${view.title}」`
  }
  const subject =
    view.title === UNKNOWN_ENGLISH_TITLE ? `这个「${view.typeLabel}」` : `「${view.title}」`
  return `${subject}${HEALTH_SUFFIX[issue.health]}`
}

/* ------------------------------------------------------------------ */
/* Text-reference scope (2.1.1)                                        */
/* ------------------------------------------------------------------ */

/** Default text-scan scope; also the fallback for older scan results. */
export const DEFAULT_TEXT_SCAN_SCOPE: SoftwareTextScanScope = 'config'

export const TEXT_SCAN_SCOPE_LABEL: Record<SoftwareTextScanScope, string> = {
  config: '仅配置文件',
  all: '全部文本',
  off: '不检查'
}

export interface TextScanScopeOption {
  value: SoftwareTextScanScope
  /** Full label shown in the confirm card. */
  label: string
  /** Honest trade-off hint shown next to the option. */
  hint: string
}

export const TEXT_SCAN_SCOPE_OPTIONS: ReadonlyArray<TextScanScopeOption> = [
  {
    value: 'config',
    label: '仅配置文件（推荐，误报少）',
    hint: '只读 .json/.yaml/.ini/.env 这类配置格式，误报少，速度也快。'
  },
  {
    value: 'all',
    label: '全部文本（更全面，误报更多、更慢）',
    hint: '连脚本、日志、生成的资源清单也一起检查；这些“路径”多为运行时拼接，全量扫描会放大误报。'
  },
  {
    value: 'off',
    label: '不检查',
    hint: '只体检程序信息和 DLL 依赖，不读安装目录里的文本。'
  }
]

/** Honest explanation of why a full-text scan is noisy; shared by UI and exports. */
export const TEXT_SCAN_NOISE_HINT =
  '安装目录里的脚本包、日志、生成资源清单里的“路径”多为运行时拼接，全量扫描会放大误报。'

/** Novice-readable lede for the text-reference section and its exports. */
export const TEXT_ISSUES_LEDE =
  '静态检查只读安装目录里的文本，不会运行这个软件。软件正常工作时，这里列出的多数“路径”只是文本，并不代表出错；真正需要处理的通常只有两种情况：软件自己报“找不到文件”，或者你移动/删除过安装目录里的文件。'

/** Explanation shown for issues that have no likely candidate location. */
export const UNFIXABLE_GROUP_NOTE =
  '这些引用没有在安装目录里找到可能是目标的文件，多为运行时拼接出来的路径或程序内置的资源清单。通常不需要处理；只有软件本身报“找不到文件”，或者你移动/删除过安装目录里的文件时，才需要进一步排查。'

/** How many candidate locations the read-only report shows per issue. */
export const SOFTWARE_CANDIDATE_DISPLAY_LIMIT = 3

export const CANDIDATE_REASON_LABEL: Record<DependencyCandidate['reason'], string> = {
  'same-name': '同名文件',
  'similar-name': '文件名相近',
  'same-folder': '同目录相似'
}

export function candidateReasonLabel(reason: DependencyCandidate['reason']): string {
  return CANDIDATE_REASON_LABEL[reason] ?? '可能相关'
}

/* ------------------------------------------------------------------ */
/* Text-reference Q&A (2.1.2 · 四问四答)                                */
/* ------------------------------------------------------------------ */

/** Fixed order of the four beginner questions every text-issue card answers. */
export const TEXT_ISSUE_QA_LABELS = {
  what: '它是什么？',
  usage: '它有什么用？',
  why: '为什么找不到 / 怎么处理？',
  ifIgnored: '不处理会怎样？'
} as const

/** One-line orientation above the issue cards (UI; also written to exports). */
export const TEXT_ISSUE_QA_LEDE =
  '每一项都按“它是什么 → 它有什么用 → 为什么找不到 / 怎么处理 → 不处理会怎样”四步说明；英文原始路径收在每张卡片的“技术细节”里。'

export const CONFIDENCE_LABEL: Record<HumanConfidence, string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export const CONFIDENCE_CHIP_TITLE =
  '可信度是根据文件名、扩展名和所在目录推测的，不代表一定正确；原始路径可在“技术细节”里核对。'

/** “不处理会怎样” for issues that do have candidate locations. */
export const IF_IGNORED_WITH_CANDIDATES =
  '不处理一般不会立刻出问题：只有软件真正用到这个文件时，才可能报“找不到文件”或某个功能不可用；如果它只是脚本里的备用路径，也可能完全没影响。'

const NO_REFERENCE_USAGE =
  '没有记录到它是被哪段文本引用的，可能是软件运行时才拼出来的路径。'
const WHAT_IT_IS_FALLBACK = '这是一个被软件引用的文件，暂时没有更细的说明。'
const WHAT_FOR_FALLBACK = '软件启动或运行时会读取它；读不到时可能出现“找不到文件”或功能缺失。'
const MISSING_REASON_FALLBACK_WITH_CANDIDATES =
  '它现在不在原来的位置，可能是重装或移动过文件，也可能是软件本来就没带这个文件。可以看看下面列出的候选位置。'
const MISSING_REASON_FALLBACK_WITHOUT_CANDIDATES =
  '静态检查没能在安装目录里找到它，也没找到相似的文件；这类路径经常是软件运行时才拼出来的，不一定是真的缺失。'
const IF_IGNORED_FALLBACK =
  '一般可以先不处理；如果软件本身报“找不到文件”，再回到这张卡按建议排查。'
const ADVICE_FALLBACK =
  '如果你最近移动或删除过安装目录里的文件，可以检查一下；没有的话可以先不处理。'

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Beginner title built from the 2.1.2 software view (「账户图标」), falling back
 * to the honest type label when the English file name cannot be explained.
 * `humanIssueTitle` stays exported for backwards compatibility; the cards use
 * this richer title because the software view knows more file kinds.
 */
function softwareIssueTitle(issue: DependencyIssue, view: HumanSoftwareFileView): string {
  const typeLabel = textOf(view?.typeLabel, '文件')
  const rawTitle = typeof view?.title === 'string' ? view.title.trim() : ''
  const known = rawTitle.length > 0 && rawTitle !== UNKNOWN_ENGLISH_TITLE
  if (issue.health === 'missing') {
    return known ? `找不到这个「${rawTitle}」` : `找不到这个「${typeLabel}」`
  }
  const subject = known ? `「${rawTitle}」` : `这个「${typeLabel}」`
  return `${subject}${HEALTH_SUFFIX[issue.health] ?? '需要留意'}`
}

/** Defensive accessors: older scan payloads may omit arrays the type expects. */
export function candidatesOf(issue: DependencyIssue): DependencyCandidate[] {
  return Array.isArray(issue.candidates) ? issue.candidates : []
}

export function referencesOf(issue: DependencyIssue): DependencyReference[] {
  return Array.isArray(issue.references) ? issue.references : []
}

export interface TextIssueCandidateCopy {
  filePath: string
  reason: DependencyCandidate['reason']
  reasonLabel: string
  /** Ranking confidence kept for backwards-compatible exports. */
  score: number
  /** Humanized candidate title (may be the honest unknown-name fallback). */
  title: string
  typeLabel: string
  /** What the candidate might be / what changes if it replaces the missing file. */
  explanation: string
}

export interface TextIssueQaCopy {
  view: HumanSoftwareFileView
  title: string
  typeLabel: string
  /** True when the English file name could not be explained honestly. */
  unknownTitle: boolean
  /** Chinese-leaning location line; the raw English path stays in 技术细节. */
  locationLabel: string
  confidence: HumanConfidence
  confidenceLabel: string
  whatItIs: string
  whatFor: string
  /** How the file is referenced (rules + surrounding text), in plain Chinese. */
  usage: string
  /** Why it cannot be found and how to deal with it. */
  missingReason: string
  /** What happens if the user does nothing. */
  ifIgnored: string
  /** Concrete next step (backend fixHint with a humanized fallback). */
  advice: string
  references: DependencyReference[]
  candidates: TextIssueCandidateCopy[]
}

/**
 * Builds the complete beginner Q&A copy for one text-reference issue.
 *
 * Pure presentation logic shared by the report cards and both export formats,
 * so the screen and the file always tell the same story. Never throws: missing
 * optional fields and unusual payloads fall back to honest generic copy.
 */
export function textIssueQa(
  issue: DependencyIssue,
  options: { projectName?: string } = {}
): TextIssueQaCopy {
  const view = humanizeSoftwareFile(issue.path, options)
  const legacyView = humanizeFileView(issue.path, { role: issue.role })
  const candidates = candidatesOf(issue)
  const references = referencesOf(issue)
  const hasCandidates = candidates.length > 0
  const firstReference = references[0]
  const rawUsage = firstReference
    ? humanizeReferenceUsage({
        ruleName: firstReference.ruleName,
        ruleCategory: firstReference.ruleCategory,
        context: firstReference.context
      })
    : ''
  const rawConfidence: unknown = view ? view.confidence : undefined
  const confidence: HumanConfidence =
    rawConfidence === 'high' || rawConfidence === 'medium' || rawConfidence === 'low'
      ? rawConfidence
      : legacyView.confidence
  const rawTitle = typeof view?.title === 'string' ? view.title.trim() : ''
  const unknownTitle = rawTitle.length === 0 || rawTitle === UNKNOWN_ENGLISH_TITLE
  return {
    view,
    title: softwareIssueTitle(issue, view),
    typeLabel: textOf(view?.typeLabel, '文件'),
    unknownTitle,
    locationLabel: textOf(view?.locationLabel, legacyView.pathBreadcrumb),
    confidence,
    confidenceLabel: CONFIDENCE_LABEL[confidence] ?? '中',
    whatItIs: textOf(view?.whatItIs, textOf(issue.what, WHAT_IT_IS_FALLBACK)),
    whatFor: textOf(view?.whatFor, WHAT_FOR_FALLBACK),
    usage: textOf(rawUsage, NO_REFERENCE_USAGE),
    missingReason: textOf(
      humanizeMissingReason(hasCandidates),
      hasCandidates
        ? MISSING_REASON_FALLBACK_WITH_CANDIDATES
        : MISSING_REASON_FALLBACK_WITHOUT_CANDIDATES
    ),
    ifIgnored: hasCandidates
      ? IF_IGNORED_WITH_CANDIDATES
      : textOf(IF_IGNORED_WITHOUT_CANDIDATES, IF_IGNORED_FALLBACK),
    advice: textOf(issue.fixHint, ADVICE_FALLBACK),
    references,
    candidates: candidates.map((candidate) => {
      const candidateView = humanizeSoftwareFile(candidate.filePath, options)
      const reasonLabel = candidateReasonLabel(candidate.reason)
      let explanation = ''
      try {
        explanation = humanizeCandidateExplanation(candidate.reason)
      } catch {
        explanation = ''
      }
      return {
        filePath: candidate.filePath,
        reason: candidate.reason,
        reasonLabel,
        score: typeof candidate.score === 'number' ? candidate.score : 0,
        title: textOf(candidateView?.title, basenameOf(candidate.filePath)),
        typeLabel: textOf(candidateView?.typeLabel, '文件'),
        explanation: textOf(
          explanation,
          `它可能和原来的文件是同一个（${reasonLabel}）；替换后引用会指向这个文件。选中前请先看一眼内容。`
        )
      }
    })
  }
}

/**
 * Tolerate older backends/mock fixtures that predate the 2.1.1 contract:
 * an absent scope means the historical default (`config`).
 */
export function textScanScopeOf(result: SoftwareScanResult): SoftwareTextScanScope {
  const scope = result.textScanScope
  return scope === 'config' || scope === 'all' || scope === 'off'
    ? scope
    : DEFAULT_TEXT_SCAN_SCOPE
}

export function textScanScopeLabel(scope: SoftwareTextScanScope): string {
  return TEXT_SCAN_SCOPE_LABEL[scope] ?? TEXT_SCAN_SCOPE_LABEL[DEFAULT_TEXT_SCAN_SCOPE]
}

/** Missing/non-numeric skipped counts from older payloads become 0. */
export function textIssuesSkippedOf(result: SoftwareScanResult): number {
  const count = result.textIssuesSkipped
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

export function textIssuesTruncatedOf(result: SoftwareScanResult): boolean {
  return result.textIssuesTruncated === true
}

export interface SoftwareTextIssueGroups {
  /** Issues with at least one likely candidate location. */
  fixable: DependencyIssue[]
  /** Issues where static analysis could not suggest a location. */
  unfixable: DependencyIssue[]
}

export function groupTextIssues(
  issues: ReadonlyArray<DependencyIssue>
): SoftwareTextIssueGroups {
  const fixable: DependencyIssue[] = []
  const unfixable: DependencyIssue[] = []
  for (const issue of issues) {
    if (Array.isArray(issue.candidates) && issue.candidates.length > 0) fixable.push(issue)
    else unfixable.push(issue)
  }
  return { fixable, unfixable }
}

export interface SoftwareTextReportSummary {
  scope: SoftwareTextScanScope
  scopeLabel: string
  /** False when the text scan did not run (scope off / settings / no rules). */
  hasReport: boolean
  checkedFiles: number
  total: number
  fixable: number
  unfixable: number
  skipped: number
  truncated: boolean
}

export function summarizeTextReport(result: SoftwareScanResult): SoftwareTextReportSummary {
  const report = result.textReport
  const issues = report?.issues ?? []
  const groups = groupTextIssues(issues)
  const scope = textScanScopeOf(result)
  return {
    scope,
    scopeLabel: TEXT_SCAN_SCOPE_LABEL[scope],
    hasReport: report !== null,
    checkedFiles: report?.summary.checkedFiles ?? 0,
    total: issues.length,
    fixable: groups.fixable.length,
    unfixable: groups.unfixable.length,
    skipped: textIssuesSkippedOf(result),
    truncated: textIssuesTruncatedOf(result)
  }
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export interface SoftwareSummary {
  name: string
  version: string
  publisher: string
  missingBinary: number
  pathIssues: number
  /** Which text-scan scope produced `pathIssues`, in plain Chinese. */
  pathScopeLabel: string
  binaryFiles: number
  statusLine: string
}

export function summarizeSoftwareResult(result: SoftwareScanResult): SoftwareSummary {
  const missingBinary = countMissingBinary(result.binaryDependencies)
  const pathIssues = result.textReport?.issues.length ?? 0
  const pathScopeLabel = textScanScopeLabel(textScanScopeOf(result))
  const pathStatus = result.textReport === null ? '路径检查未执行' : `路径问题 ${pathIssues} 项`
  return {
    name: softwareDisplayName(result.info, result.projectName),
    version: softwareVersionLabel(result.info),
    publisher: softwarePublisherLabel(result.info),
    missingBinary,
    pathIssues,
    pathScopeLabel,
    binaryFiles: result.binaryFilesScanned.length,
    statusLine: `缺少的软件依赖 ${missingBinary} 项 / ${pathStatus}`
  }
}

/* ------------------------------------------------------------------ */
/* Export helpers                                                      */
/* ------------------------------------------------------------------ */

function formatMissingList(
  dependencies: ReadonlyArray<BinaryDependency>,
  heading: string,
  lines: string[]
): void {
  lines.push(`### ${heading}`, '')
  if (dependencies.length === 0) {
    lines.push('（无缺失）', '')
    return
  }
  for (const dependency of dependencies) {
    lines.push(`- **${dependency.name}** — ${STATUS_LABEL[dependency.status]}`)
    const importedBy =
      dependency.importedBy.length > 0 ? dependency.importedBy.join('、') : '（未记录）'
    lines.push(`  - 被引用：${importedBy}`)
    lines.push(`  - 解析位置：${dependency.resolvedPath ?? '未找到（可能缺失）'}`)
    lines.push(`  - 建议：${binaryAdvice(dependency)}`)
  }
  lines.push('')
}

function formatFoundList(group: BinaryDependencyGroup, lines: string[]): void {
  if (group.found.length === 0) return
  lines.push(`<details><summary>${group.title} · 已找到 ${group.found.length} 项</summary>`, '')
  for (const dependency of group.found) {
    const importedBy =
      dependency.importedBy.length > 0 ? dependency.importedBy.join('、') : '（未记录）'
    lines.push(
      `- ${dependency.name} — ${STATUS_LABEL[dependency.status]} — ${dependency.resolvedPath ?? '未提供路径'}（被引用：${importedBy}）`
    )
  }
  lines.push('', '</details>', '')
}

function formatPathIssues(result: SoftwareScanResult, lines: string[]): void {
  lines.push('## 二、配置/脚本里的路径问题', '')
  const report = result.textReport
  const stats = summarizeTextReport(result)
  lines.push(`路径引用检查范围：${stats.scopeLabel}`, '')
  lines.push(`> ${TEXT_SCAN_NOISE_HINT}`, '')
  lines.push(`> ${TEXT_ISSUES_LEDE}`, '')
  lines.push(`> ${TEXT_ISSUE_QA_LEDE}`, '')
  lines.push(`> ${STATIC_CHECK_LIMIT_NOTE}`, '')
  if (stats.skipped > 0) {
    lines.push(`另有 ${stats.skipped} 条引用指向缓存/被忽略的目录，未计入问题。`, '')
  }
  if (stats.truncated) {
    lines.push('同类问题过多，仅展示前一部分；完整列表请到“智能检查”查看。', '')
  }
  if (!report) {
    lines.push(
      stats.scope === 'off'
        ? '这次没有执行文本路径检查（检查范围选择了“不检查”）。需要检查时，把范围切换到“仅配置文件”或“全部文本”后重新体检。'
        : '这次没有执行配置/脚本的路径检查（“智能检查”可能已在设置里关闭，或没有启用的匹配规则）。',
      ''
    )
    return
  }
  if (report.issues.length === 0) {
    lines.push(
      `没有发现配置/脚本里的路径问题（检查了 ${stats.checkedFiles} 个文件，范围：${stats.scopeLabel}）。`,
      ''
    )
  } else {
    const groups = groupTextIssues(report.issues)
    lines.push(
      `共 ${stats.total} 项：可定位处理 ${groups.fixable.length} 项，无法定位 ${groups.unfixable.length} 项。`,
      ''
    )
    if (groups.fixable.length > 0) {
      lines.push(`### 可定位处理（${groups.fixable.length} 项）`, '')
      lines.push(
        '这些引用在安装目录里找到了可能对应的文件。软件体检只读，不在这里修复；到“智能检查”处理时仍有预检、二次确认和自动备份。',
        ''
      )
      groups.fixable.forEach((issue, index) => {
        const copy = textIssueQa(issue, { projectName: result.projectName })
        lines.push(`#### ${index + 1}. ${copy.title}`, '')
        if (copy.unknownTitle) {
          lines.push(`- 文件名说明：${UNKNOWN_ENGLISH_TITLE}（只能按类型和位置说明）`)
        }
        lines.push(
          `- ${TEXT_ISSUE_QA_LABELS.what}它是${copy.typeLabel}（可信度：推测·${copy.confidenceLabel}）。${copy.whatItIs}`
        )
        lines.push(`- ${TEXT_ISSUE_QA_LABELS.usage}${copy.whatFor}引用方式：${copy.usage}`)
        lines.push(`- ${TEXT_ISSUE_QA_LABELS.why}${copy.missingReason}`)
        lines.push(`  - 建议：${copy.advice}`)
        lines.push(`- ${TEXT_ISSUE_QA_LABELS.ifIgnored}${copy.ifIgnored}`)
        lines.push(`  - ${STATIC_CHECK_LIMIT_NOTE}`)
        lines.push('- 可能的位置（按相似度排序）：')
        const shown = copy.candidates.slice(0, SOFTWARE_CANDIDATE_DISPLAY_LIMIT)
        for (const candidate of shown) {
          lines.push(
            `  - 「${candidate.title}」· ${candidate.typeLabel} · ${candidate.reasonLabel}`
          )
          lines.push(`    - 路径：\`${candidate.filePath}\``)
          lines.push(`    - 它可能是什么 / 替换后怎样：${candidate.explanation}`)
        }
        if (copy.candidates.length > shown.length) {
          lines.push(
            `  - …还有 ${copy.candidates.length - shown.length} 个候选，请在“智能检查”里查看。`
          )
        }
        if (copy.references.length > 0) {
          lines.push('- 引用位置：')
          for (const reference of copy.references) {
            lines.push(
              `  - \`${reference.filePath}:${reference.line}\`（规则：${reference.ruleName}）上下文：${reference.context}`
            )
          }
        }
        lines.push('- 技术细节：')
        lines.push(`  - 原始路径：\`${issue.path}\``)
        lines.push(`  - 位置：${copy.locationLabel}`)
        lines.push('')
      })
    }
    if (groups.unfixable.length > 0) {
      lines.push(`### 无法定位（${groups.unfixable.length} 项）`, '')
      lines.push(`> ${UNFIXABLE_GROUP_NOTE}`, '')
      for (const issue of groups.unfixable) {
        const copy = textIssueQa(issue, { projectName: result.projectName })
        lines.push(`- ${copy.title}`)
        if (copy.unknownTitle) {
          lines.push(`  - 文件名说明：${UNKNOWN_ENGLISH_TITLE}（只能按类型和位置说明）`)
        }
        lines.push(`  - ${TEXT_ISSUE_QA_LABELS.what} ${copy.whatItIs}`)
        lines.push(`  - ${TEXT_ISSUE_QA_LABELS.usage} ${copy.whatFor}`)
        lines.push(`  - ${TEXT_ISSUE_QA_LABELS.ifIgnored} ${copy.ifIgnored}`)
        lines.push(`  - 原始路径：\`${issue.path}\``)
      }
      lines.push('')
    }
  }
  if (report.warnings.length > 0) {
    lines.push('路径检查的技术警告：', '')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }
}

export function buildSoftwareMarkdownReport(result: SoftwareScanResult): string {
  const summary = summarizeSoftwareResult(result)
  const lines: string[] = []
  lines.push(`# 软件体检报告 · ${summary.name}`, '')
  lines.push(
    '> 本报告由 PathKeeper 只读生成：没有启动、修改或上传这个软件的任何内容。',
    '> 所有写入动作仍然需要预检 + 二次确认 + 自动备份（软件体检页本身没有写入操作）。',
    ''
  )

  lines.push('## 概要', '')
  lines.push(`- 软件名称：${summary.name}`)
  lines.push(`- 版本：${summary.version}`)
  lines.push(`- 发布者：${summary.publisher}`)
  lines.push(`- 安装位置：${result.installRoot}`)
  lines.push(`- 入口文件：${result.entryPath ?? '未指定（只扫描安装目录）'}`)
  lines.push(`- 总体状态：${summary.statusLine}`)
  lines.push(`- 路径引用检查范围：${summary.pathScopeLabel}`)
  lines.push(`- 二进制分析：${BINARY_ANALYSIS_LABEL[result.binaryAnalysis]}`)
  lines.push(`- 体检耗时：${formatDuration(result.durationMs)}`)
  lines.push(`- 生成时间：${formatDateTime(new Date().toISOString())}`)
  lines.push('')

  lines.push('## 一、软件依赖（exe/dll 导入表）', '')
  lines.push(`分析状态：${BINARY_ANALYSIS_LABEL[result.binaryAnalysis]}`, '')
  if (result.binaryAnalysis === 'not-analyzed') {
    lines.push(NOT_ANALYZED_NOTE, '')
  } else if (result.binaryAnalysis === 'unavailable') {
    lines.push(UNAVAILABLE_NOTE, '')
  } else {
    const scanned =
      result.binaryFilesScanned.length > 0
        ? result.binaryFilesScanned.map((file) => `\`${file}\``).join('、')
        : '（没有可解析的程序文件）'
    lines.push(`已解析的程序文件：${scanned}`, '')
    if (result.binaryCapHit) {
      lines.push('> 导入项数量超过上限，本次只分析了能处理的部分。', '')
    }
    const groups = groupBinaryDependencies(result.binaryDependencies)
    if (result.binaryDependencies.length === 0) {
      lines.push('没有解析到导入项。', '')
    } else {
      for (const group of groups) {
        formatMissingList(group.missing, `${group.title}（缺失 ${group.missing.length} 项）`, lines)
        formatFoundList(group, lines)
      }
    }
  }

  formatPathIssues(result, lines)

  lines.push('## 三、无法判断的部分', '')
  lines.push('静态检查无法覆盖下面这些情况，所以请把它们当作“未确认”，而不是“没问题”：', '')
  for (const limit of STATIC_CHECK_LIMITS) lines.push(`- ${limit}`)
  lines.push('')

  lines.push('## 四、警告与说明', '')
  if (result.warnings.length === 0) {
    lines.push('本次体检没有技术警告。', '')
  } else {
    for (const warning of result.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('## 五、技术细节', '')
  lines.push(`- 项目 ID：${result.projectId}`)
  lines.push(`- 安装根目录：${result.installRoot}`)
  lines.push(`- 入口程序：${result.entryPath ?? '无'}`)
  lines.push(`- 二进制分析状态：${result.binaryAnalysis}`)
  lines.push(
    `- 已解析程序文件：${
      result.binaryFilesScanned.length > 0 ? result.binaryFilesScanned.join('、') : '无'
    }`
  )
  lines.push(`- 导入项上限是否触发：${result.binaryCapHit ? '是' : '否'}`)
  const textStats = summarizeTextReport(result)
  lines.push(`- 路径引用检查范围：${textStats.scopeLabel}（${textStats.scope}）`)
  lines.push(`- 文本引用跳过的条目：${textStats.skipped > 0 ? `${textStats.skipped} 条` : '无'}`)
  lines.push(`- 文本引用是否截断：${textStats.truncated ? '是（仅展示前一部分）' : '否'}`)
  lines.push(
    `- 文本引用检查：${
      result.textReport
        ? `检查 ${result.textReport.summary.checkedFiles} 个文件，发现 ${result.textReport.issues.length} 项问题`
        : '未执行'
    }`
  )
  lines.push('')

  lines.push('## 安全说明', '')
  for (const point of SAFETY_POINTS) lines.push(`- ${point}`)
  lines.push('', '—— PathKeeper · 本地运行，不联网、不上传。', '')

  return lines.join('\n')
}

export function buildSoftwareJsonReport(result: SoftwareScanResult): string {
  const textStats = summarizeTextReport(result)
  const groups = groupTextIssues(result.textReport?.issues ?? [])
  const qaOf = (issue: DependencyIssue): TextIssueQaCopy =>
    textIssueQa(issue, { projectName: result.projectName })
  return JSON.stringify(
    {
      app: 'PathKeeper',
      reportVersion: 3,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      safety: SAFETY_POINTS,
      staticCheckLimits: STATIC_CHECK_LIMITS,
      textReferences: {
        scope: textStats.scope,
        scopeLabel: textStats.scopeLabel,
        executed: textStats.hasReport,
        explanation: TEXT_ISSUES_LEDE,
        qaLede: TEXT_ISSUE_QA_LEDE,
        qa: TEXT_ISSUE_QA_LABELS,
        staticCheckLimitNote: STATIC_CHECK_LIMIT_NOTE,
        noiseHint: TEXT_SCAN_NOISE_HINT,
        checkedFiles: textStats.checkedFiles,
        issueCount: textStats.total,
        fixableCount: groups.fixable.length,
        unfixableCount: groups.unfixable.length,
        skippedCount: textStats.skipped,
        truncated: textStats.truncated,
        unfixableNote: UNFIXABLE_GROUP_NOTE,
        fixable: groups.fixable.map((issue) => {
          const copy = qaOf(issue)
          return {
            // 2.1.1 fields (kept for backwards compatibility).
            title: copy.title,
            path: issue.path,
            health: issue.health,
            role: issue.role,
            what: issue.what,
            why: issue.why,
            advice: issue.fixHint,
            // 2.1.2 Q&A fields.
            typeLabel: copy.typeLabel,
            unknownTitle: copy.unknownTitle,
            confidence: copy.confidence,
            whatItIs: copy.whatItIs,
            whatFor: copy.whatFor,
            usage: copy.usage,
            missingReason: copy.missingReason,
            ifIgnored: copy.ifIgnored,
            candidates: copy.candidates.map((candidate) => ({
              filePath: candidate.filePath,
              reason: candidate.reason,
              reasonLabel: candidate.reasonLabel,
              score: candidate.score,
              title: candidate.title,
              typeLabel: candidate.typeLabel,
              explanation: candidate.explanation
            })),
            references: copy.references
          }
        }),
        unfixable: groups.unfixable.map((issue) => {
          const copy = qaOf(issue)
          return {
            // 2.1.1 fields (kept for backwards compatibility).
            title: copy.title,
            path: issue.path,
            health: issue.health,
            role: issue.role,
            // 2.1.2 Q&A fields.
            typeLabel: copy.typeLabel,
            unknownTitle: copy.unknownTitle,
            confidence: copy.confidence,
            whatItIs: copy.whatItIs,
            whatFor: copy.whatFor,
            usage: copy.usage,
            missingReason: copy.missingReason,
            ifIgnored: copy.ifIgnored
          }
        })
      },
      software: result
    },
    null,
    2
  )
}

export function softwareReportFileName(
  result: SoftwareScanResult,
  extension: 'md' | 'json'
): string {
  const name = sanitizeFileName(`${softwareDisplayName(result.info, result.projectName)}-软件体检`)
  return `${name}-${timestampSlug()}.${extension}`
}
