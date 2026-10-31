/**
 * Read-only software health report (plan A5/A6 + 2.1.2 beginner Q&A).
 *
 * Sections: summary, missing DLLs grouped by origin, text-reference path
 * issues, the static-check limits, warnings and technical details. There are
 * deliberately NO repair, download or privilege-escalation actions here: the
 * report is read-only by design.
 *
 * 2.1.2: every text-reference card answers the same four beginner questions in
 * order — 它是什么 / 它有什么用 / 为什么找不到·怎么处理 / 不处理会怎样 — and
 * recommended replacements show a thumbnail (images) or a short text preview.
 * Raw English paths are demoted into each card's 技术细节 disclosure.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PathKeeperApi } from '@shared/api'
import type {
  BinaryDependency,
  DependencyIssue,
  DependencyReference,
  FilePreview,
  SoftwareScanResult
} from '@shared/types'
import {
  AppWindow,
  CircleAlert,
  CircleCheck,
  FileSearch,
  FileText,
  Info,
  Package,
  ShieldCheck,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import { STATIC_CHECK_LIMIT_NOTE, UNKNOWN_ENGLISH_TITLE } from '@shared/fileHumanize'
import { Button, Chip, Notice, Stat, type ChipTone } from '@renderer/components/ui'
import { HelpTip } from '@renderer/components/HelpTip'
import { useApi } from '@renderer/api/context'
import type { PageId } from '@renderer/app-types'
import { formatDateTime, formatDuration } from '@renderer/lib/format'
import {
  BINARY_ANALYSIS_LABEL,
  CONFIDENCE_CHIP_TITLE,
  NOT_ANALYZED_NOTE,
  ORIGIN_META,
  SAFETY_POINTS,
  SOFTWARE_CANDIDATE_DISPLAY_LIMIT,
  STATIC_CHECK_LIMITS,
  STATUS_LABEL,
  TEXT_ISSUE_QA_LABELS,
  TEXT_ISSUE_QA_LEDE,
  TEXT_ISSUES_LEDE,
  UNFIXABLE_GROUP_NOTE,
  UNAVAILABLE_NOTE,
  binaryAdvice,
  countMissingBinary,
  groupBinaryDependencies,
  groupTextIssues,
  summarizeSoftwareResult,
  summarizeTextReport,
  textIssueQa,
  type TextIssueCandidateCopy,
  type TextIssueQaCopy
} from './softwareReport'

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function DependencyRow({ dependency }: { dependency: BinaryDependency }): ReactNode {
  const origin = ORIGIN_META[dependency.origin]
  const missing = dependency.status === 'missing'
  return (
    <li
      className={`software-dep-item${missing ? ' is-missing' : ''}`}
      data-testid="software-dep"
      data-dll={dependency.name}
    >
      <div className="software-dep-main">
        <span className="software-dep-icon" aria-hidden="true">
          <Package size={14} />
        </span>
        <code className="software-dep-name mono">{dependency.name}</code>
        <Chip tone={missing ? 'red' : dependency.status === 'ok' ? 'mint' : 'muted'}>
          {STATUS_LABEL[dependency.status]}
        </Chip>
        <Chip tone="outline">{origin.title}</Chip>
      </div>
      {dependency.importedBy.length > 0 ? (
        <p className="software-dep-ref">
          被这些程序引用：
          {dependency.importedBy.map((file, index) => (
            <span key={`${dependency.name}:${index}:${file}`}>
              {index > 0 ? '、' : ''}
              <code className="mono">{file}</code>
            </span>
          ))}
        </p>
      ) : (
        <p className="software-dep-ref">引用它的程序：未记录</p>
      )}
      <p className={`software-dep-hint${missing ? ' is-warn' : ''}`}>
        <Info size={12} aria-hidden="true" />
        {binaryAdvice(dependency)}
      </p>
      <details className="software-dep-details">
        <summary>技术细节</summary>
        <dl>
          <div>
            <dt>DLL 名称</dt>
            <dd className="mono">{dependency.name}</dd>
          </div>
          <div>
            <dt>解析位置</dt>
            <dd className="mono">{dependency.resolvedPath ?? '未找到（可能缺失）'}</dd>
          </div>
          <div>
            <dt>来源分类</dt>
            <dd>
              {origin.title} · {origin.technical}
            </dd>
          </div>
          <div>
            <dt>引用程序</dt>
            <dd className="mono">
              {dependency.importedBy.length > 0 ? dependency.importedBy.join('、') : '—'}
            </dd>
          </div>
        </dl>
      </details>
    </li>
  )
}

function BinarySection({ result }: { result: SoftwareScanResult }): ReactNode {
  const groups = useMemo(
    () => groupBinaryDependencies(result.binaryDependencies),
    [result.binaryDependencies]
  )
  const missingCount = countMissingBinary(result.binaryDependencies)

  return (
    <section
      className="software-section"
      aria-labelledby="software-deps-title"
      data-testid="software-binary-list"
    >
      <header className="software-section-head">
        <div>
          <p className="plate-kicker mono">01 · 程序依赖</p>
          <h2 id="software-deps-title">缺少的软件依赖</h2>
          <p>
            检查程序导入的文件（DLL）是否在软件目录、系统目录或 PATH 里。这里只做存在性判断，
            不会加载、下载或复制任何 DLL。
          </p>
        </div>
        <Chip tone={missingCount > 0 ? 'red' : 'mint'}>
          {BINARY_ANALYSIS_LABEL[result.binaryAnalysis]}
        </Chip>
      </header>

      {result.binaryAnalysis === 'not-analyzed' ? (
        <Notice tone="info" title="当前未分析 exe/dll 导入表" testId="software-binary-not-analyzed">
          {NOT_ANALYZED_NOTE}
        </Notice>
      ) : result.binaryAnalysis === 'unavailable' ? (
        <Notice
          tone="warn"
          title="这次无法分析 exe/dll 导入表"
          icon={<TriangleAlert size={15} />}
          testId="software-binary-unavailable"
        >
          {UNAVAILABLE_NOTE}
        </Notice>
      ) : result.binaryDependencies.length === 0 ? (
        <div className="software-empty-inline">
          <CircleCheck size={16} aria-hidden="true" />
          <p>
            没有解析到导入项。
            {result.binaryFilesScanned.length === 0
              ? '这次没有找到可解析的程序文件。'
              : '程序文件里没有可识别的 DLL 导入记录。'}
          </p>
        </div>
      ) : (
        <>
          {missingCount === 0 ? (
            <div className="software-success-inline" data-testid="software-deps-ok">
              <CircleCheck size={16} aria-hidden="true" />
              <p>
                导入的 {result.binaryDependencies.length} 项依赖都能找到。
                静态检查无法覆盖动态加载的依赖，建议仍然运行一次软件确认。
              </p>
            </div>
          ) : (
            <p className="software-section-lede">
              共发现 <strong>{missingCount}</strong> 项缺失。下面按来源分组，并给出可执行的处理建议。
            </p>
          )}

          {groups.map((group) => (
            <div
              className="software-dep-group"
              key={group.origin}
              data-testid={`software-deps-${group.origin}`}
            >
              <header className="software-dep-group-head">
                <h3>{group.title}</h3>
                <Chip tone={group.missing.length > 0 ? 'red' : 'muted'}>
                  缺失 {group.missing.length} 项
                </Chip>
              </header>
              <p className="software-dep-group-hint">{group.hint}</p>
              {group.missing.length > 0 ? (
                <ul className="software-dep-list">
                  {group.missing.map((dependency, index) => (
                    <DependencyRow
                      key={`missing:${index}:${dependency.name}`}
                      dependency={dependency}
                    />
                  ))}
                </ul>
              ) : (
                <p className="software-dep-group-empty">这一组没有缺失项。</p>
              )}
              {group.found.length > 0 ? (
                <details className="software-dep-found">
                  <summary>这一组已找到 {group.found.length} 项</summary>
                  <ul className="software-dep-found-list">
                    {group.found.map((dependency, index) => (
                      <li key={`found:${index}:${dependency.name}`}>
                        <code className="mono">{dependency.name}</code>
                        <Chip tone={dependency.status === 'ok' ? 'mint' : 'muted'}>
                          {STATUS_LABEL[dependency.status]}
                        </Chip>
                        <span className="mono software-dep-found-path">
                          {dependency.resolvedPath ?? '未提供路径'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))}

          <Notice tone="info" icon={<ShieldCheck size={15} />} testId="software-deps-boundary">
            软件体检不会自动下载 DLL、不会把系统文件复制进软件目录、也不会自动提权。
            系统组件缺失时，请重新安装软件或对应运行库（如 VC++ Redistributable）。
          </Notice>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Candidate previews (lazy, cached, capped, never blocking)          */
/* ------------------------------------------------------------------ */

const PREVIEW_REQUEST_CAP = 60
const PREVIEW_MAX_BYTES = 1_048_576
const PREVIEW_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'svg'
])
const PREVIEW_TEXT_EXTENSIONS = new Set([
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'py',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'vue',
  'svelte',
  'html',
  'htm',
  'css',
  'sh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'md',
  'mdx',
  'txt',
  'csv',
  'tsv',
  'log',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'cs',
  'c',
  'cpp',
  'h',
  'hpp',
  'php'
])

const previewCache = new Map<string, FilePreview | null>()
/** In-flight requests, so StrictMode double-mounts / duplicate rows share one call. */
const previewPending = new Map<string, Promise<FilePreview | null>>()
let previewRequestsLeft = PREVIEW_REQUEST_CAP

function previewKindFor(relativePath: string): 'image' | 'text' | null {
  const base = relativePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  const extension = base.slice(dot + 1).toLowerCase()
  if (PREVIEW_IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (PREVIEW_TEXT_EXTENSIONS.has(extension)) return 'text'
  return null
}

function previewCacheKey(projectId: number, relativePath: string): string {
  return `${projectId}\u0000${relativePath}`
}

async function requestFilePreview(
  api: PathKeeperApi,
  projectId: number,
  relativePath: string
): Promise<FilePreview | null> {
  const key = previewCacheKey(projectId, relativePath)
  const cached = previewCache.get(key)
  if (cached !== undefined) return cached
  const pending = previewPending.get(key)
  if (pending !== undefined) return pending
  if (previewKindFor(relativePath) === null) return null
  if (previewRequestsLeft <= 0) return null
  previewRequestsLeft -= 1
  const request = (async (): Promise<FilePreview | null> => {
    try {
      const preview = await api.files.preview(projectId, relativePath)
      // Never render previews for large files, even if the main process sent one.
      const result = preview.size > PREVIEW_MAX_BYTES ? null : preview
      previewCache.set(key, result)
      return result
    } catch {
      // Read-only nicety: silently degrade, never surface an error or log.
      previewCache.set(key, null)
      return null
    }
  })().finally(() => {
    previewPending.delete(key)
  })
  previewPending.set(key, request)
  return request
}

function useCandidatePreview(
  api: PathKeeperApi,
  projectId: number,
  relativePath: string
): FilePreview | null {
  const key = previewCacheKey(projectId, relativePath)
  const [preview, setPreview] = useState<FilePreview | null>(() => {
    const cached = previewCache.get(key)
    return cached === undefined ? null : cached
  })

  useEffect(() => {
    setPreview(null)
    if (previewKindFor(relativePath) === null) return
    const cached = previewCache.get(key)
    if (cached !== undefined) {
      setPreview(cached)
      return
    }
    let active = true
    void requestFilePreview(api, projectId, relativePath).then((result) => {
      if (active) setPreview(result)
    })
    return () => {
      active = false
    }
  }, [api, key, projectId, relativePath])

  return preview
}

function CandidatePreviewMedia({
  projectId,
  candidate
}: {
  projectId: number
  candidate: TextIssueCandidateCopy
}): ReactNode {
  const api = useApi()
  const preview = useCandidatePreview(api, projectId, candidate.filePath)
  if (preview === null) return null
  if (preview.kind === 'image' && typeof preview.dataUrl === 'string' && preview.dataUrl.length > 0) {
    return (
      <span className="software-candidate-media">
        <img
          className="software-candidate-thumb"
          src={preview.dataUrl}
          alt=""
          loading="lazy"
          data-testid="software-path-candidate-thumb"
        />
      </span>
    )
  }
  if (preview.kind === 'text') {
    const lines = Array.isArray(preview.lines) ? preview.lines.slice(0, 2) : []
    if (lines.length === 0) return null
    return (
      <pre
        className="software-candidate-preview mono"
        aria-hidden="true"
        title={candidate.title}
        data-testid="software-path-candidate-preview"
      >
        {lines.join('\n')}
      </pre>
    )
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Text-reference issue cards — 四问四答                               */
/* ------------------------------------------------------------------ */

function confidenceTone(confidence: TextIssueQaCopy['confidence']): ChipTone {
  if (confidence === 'high') return 'mint'
  if (confidence === 'low') return 'muted'
  return 'brass'
}

function ConfidenceChip({ qa }: { qa: TextIssueQaCopy }): ReactNode {
  return (
    <Chip
      tone={confidenceTone(qa.confidence)}
      title={CONFIDENCE_CHIP_TITLE}
      className="software-confidence-chip"
    >
      推测·{qa.confidenceLabel}
    </Chip>
  )
}

function PathIssueHead({
  issue,
  qa
}: {
  issue: DependencyIssue
  qa: TextIssueQaCopy
}): ReactNode {
  return (
    <header className="software-issue-head">
      <span className="software-issue-icon" aria-hidden="true">
        {issue.health === 'missing' ? <CircleAlert size={16} /> : <FileText size={16} />}
      </span>
      <div className="software-issue-title">
        <h3>{qa.title}</h3>
        <p className="software-issue-type">
          <Chip tone="outline">{qa.typeLabel}</Chip>
          <ConfidenceChip qa={qa} />
          {qa.unknownTitle ? (
            <span className="software-issue-honest">{UNKNOWN_ENGLISH_TITLE}</span>
          ) : null}
          <span className="software-issue-location">位置：{qa.locationLabel}</span>
        </p>
      </div>
    </header>
  )
}

function IssueReferences({
  references,
  testId
}: {
  references: DependencyReference[]
  testId: string
}): ReactNode {
  if (references.length === 0) {
    return <p className="software-qa-muted">没有记录到引用位置。</p>
  }
  return (
    <details className="software-qa-refs" data-testid={testId}>
      <summary>引用位置（{references.length} 处）</summary>
      <ul>
        {references.map((reference, index) => (
          <li key={`${index}:${reference.filePath}:${reference.line}:${reference.ruleName}`}>
            <code className="mono">
              {reference.filePath}:{reference.line}
            </code>
            <span>{reference.ruleName}</span>
            <code className="mono software-issue-context">{reference.context}</code>
          </li>
        ))}
      </ul>
    </details>
  )
}

function CandidateRow({
  projectId,
  candidate
}: {
  projectId: number
  candidate: TextIssueCandidateCopy
}): ReactNode {
  return (
    <li className="software-candidate" data-testid="software-path-candidate">
      <CandidatePreviewMedia projectId={projectId} candidate={candidate} />
      <div className="software-candidate-body">
        <p className="software-candidate-title-row">
          <span className="software-candidate-title">{candidate.title}</span>
          <Chip tone="outline">{candidate.typeLabel}</Chip>
          <Chip tone={candidate.reason === 'same-name' ? 'mint' : 'brass'}>
            {candidate.reasonLabel}
          </Chip>
        </p>
        <p className="software-candidate-explain" data-testid="software-path-candidate-explain">
          {candidate.explanation}
        </p>
        <details className="software-candidate-raw">
          <summary>原始路径</summary>
          <code className="mono">{candidate.filePath}</code>
        </details>
      </div>
    </li>
  )
}

function PathIssueCandidates({
  projectId,
  qa
}: {
  projectId: number
  qa: TextIssueQaCopy
}): ReactNode {
  const shown = qa.candidates.slice(0, SOFTWARE_CANDIDATE_DISPLAY_LIMIT)
  return (
    <div className="software-candidates" data-testid="software-path-candidates">
      <p className="software-candidates-label">
        <FileSearch size={13} aria-hidden="true" />
        可能是它的文件（按相似度只列前 {SOFTWARE_CANDIDATE_DISPLAY_LIMIT} 个）
        <HelpTip>
          只根据文件名、文件名相似度和所在文件夹来推测，不代表一定正确。
          软件体检不会自动替换任何文件；选中前先看一眼缩略图/内容。
        </HelpTip>
      </p>
      <p className="software-candidates-note">
        图片会显示缩略图，文本会显示前两行；英文原始路径折叠在每一行的“原始路径”里。
      </p>
      <ul className="software-candidate-list">
        {shown.map((candidate, index) => (
          <CandidateRow
            key={`${candidate.filePath}:${index}`}
            projectId={projectId}
            candidate={candidate}
          />
        ))}
      </ul>
      {qa.candidates.length > shown.length ? (
        <p className="software-candidates-more">
          还有 {qa.candidates.length - shown.length} 个候选，去“智能检查”里查看全部。
        </p>
      ) : null}
    </div>
  )
}

function FixableTextIssue({
  issue,
  projectId,
  projectName,
  onNavigate
}: {
  issue: DependencyIssue
  projectId: number
  projectName: string
  onNavigate: (page: PageId) => void
}): ReactNode {
  const qa = useMemo(() => textIssueQa(issue, { projectName }), [issue, projectName])
  const headingKey =
    typeof issue.id === 'string' && issue.id.length > 0 ? issue.id : issue.path
  return (
    <li className="software-issue" data-testid="software-path-issue">
      <article className="software-issue-card" data-testid="software-path-fixable">
        <PathIssueHead issue={issue} qa={qa} />

        <section
          className="software-qa"
          aria-labelledby={`software-path-what-${headingKey}`}
          data-testid="software-path-what"
        >
          <h4 id={`software-path-what-${headingKey}`}>{TEXT_ISSUE_QA_LABELS.what}</h4>
          <p>{qa.whatItIs}</p>
        </section>

        <section
          className="software-qa"
          aria-labelledby={`software-path-usage-${headingKey}`}
          data-testid="software-path-usage"
        >
          <h4 id={`software-path-usage-${headingKey}`}>{TEXT_ISSUE_QA_LABELS.usage}</h4>
          <p>{qa.whatFor}</p>
          <p className="software-qa-sub">引用方式：{qa.usage}</p>
          <IssueReferences
            references={qa.references}
            testId="software-path-references"
          />
        </section>

        <section
          className="software-qa"
          aria-labelledby={`software-path-why-${headingKey}`}
          data-testid="software-path-why"
        >
          <h4 id={`software-path-why-${headingKey}`}>{TEXT_ISSUE_QA_LABELS.why}</h4>
          <p>{qa.missingReason}</p>
          <p className="software-qa-advice">
            <strong>可以这样处理：</strong>
            {qa.advice}
          </p>
          <PathIssueCandidates projectId={projectId} qa={qa} />
        </section>

        <section
          className="software-qa is-if-ignored"
          aria-labelledby={`software-path-if-ignored-${headingKey}`}
          data-testid="software-path-if-ignored"
        >
          <h4 id={`software-path-if-ignored-${headingKey}`}>{TEXT_ISSUE_QA_LABELS.ifIgnored}</h4>
          <p>{qa.ifIgnored}</p>
          <p className="software-qa-limit">{STATIC_CHECK_LIMIT_NOTE}</p>
        </section>

        <div className="software-issue-card-actions">
          <Button
            variant="default"
            size="sm"
            icon={<Sparkles size={14} />}
            onClick={() => onNavigate('dependencies')}
            data-testid="software-path-open-dependencies"
          >
            去“智能检查”逐项处理
          </Button>
          <span className="software-issue-actions-note">
            那边处理时仍有预检 + 二次确认 + 自动备份，不会直接改文件。
          </span>
        </div>

        <details className="software-issue-technical" data-testid="software-path-technical">
          <summary>技术细节（原始路径与识别依据）</summary>
          <div>
            <p>
              原始路径：<code className="mono">{issue.path}</code>
            </p>
            <p>位置：{qa.locationLabel}</p>
            <p>
              文件类型：{qa.typeLabel} · 识别可信度：推测·{qa.confidenceLabel}（根据文件名、扩展名和目录推测）
            </p>
            <p>引用方式：{qa.usage}</p>
            <IssueReferences
              references={qa.references}
              testId="software-path-technical-references"
            />
            <p className="software-qa-muted">原始说明（来自扫描器）：{issue.what}</p>
            {typeof issue.why === 'string' && issue.why.length > 0 ? (
              <p className="software-qa-muted">为什么要注意：{issue.why}</p>
            ) : null}
          </div>
        </details>
      </article>
    </li>
  )
}

function UnfixableTextIssues({
  issues,
  projectName
}: {
  issues: DependencyIssue[]
  projectName: string
}): ReactNode {
  return (
    <details className="software-path-unfixable" data-testid="software-path-unfixable">
      <summary>
        <span>还有 {issues.length} 项无法定位（多为运行时拼接/内置资源清单）</span>
        <Chip tone="muted">通常不用处理</Chip>
      </summary>
      <div className="software-path-unfixable-body">
        <p className="software-path-unfixable-note">{UNFIXABLE_GROUP_NOTE}</p>
        <ul className="software-unfixable-list">
          {issues.map((issue, index) => {
            const qa = textIssueQa(issue, { projectName })
            return (
              <li key={`${issue.id ?? issue.path}:${index}`} data-testid="software-path-issue">
                <div className="software-unfixable-head">
                  <span className="software-unfixable-title">{qa.title}</span>
                  <Chip tone="outline">{qa.typeLabel}</Chip>
                  <ConfidenceChip qa={qa} />
                  {qa.unknownTitle ? (
                    <span className="software-issue-honest">{UNKNOWN_ENGLISH_TITLE}</span>
                  ) : null}
                </div>
                <p className="software-unfixable-line" data-testid="software-path-unfixable-what">
                  <strong>{TEXT_ISSUE_QA_LABELS.what}</strong>
                  {qa.whatItIs}
                </p>
                <p className="software-unfixable-line" data-testid="software-path-unfixable-usage">
                  <strong>{TEXT_ISSUE_QA_LABELS.usage}</strong>
                  {qa.whatFor}
                </p>
                <p
                  className="software-unfixable-line is-if-ignored"
                  data-testid="software-path-unfixable-ignored"
                >
                  <strong>{TEXT_ISSUE_QA_LABELS.ifIgnored}</strong>
                  {qa.ifIgnored}
                </p>
                <details className="software-unfixable-raw">
                  <summary>原始路径</summary>
                  <code className="mono">{issue.path}</code>
                </details>
              </li>
            )
          })}
        </ul>
      </div>
    </details>
  )
}

function TextIssuesSection({
  result,
  onNavigate
}: {
  result: SoftwareScanResult
  onNavigate: (page: PageId) => void
}): ReactNode {
  const report = result.textReport
  const issues = report?.issues ?? []
  const stats = summarizeTextReport(result)
  const groups = groupTextIssues(issues)
  return (
    <section
      className="software-section"
      aria-labelledby="software-path-title"
      data-testid="software-text-issues"
    >
      <header className="software-section-head">
        <div>
          <p className="plate-kicker mono">02 · 文本路径</p>
          <h2 id="software-path-title">配置/脚本里的路径问题</h2>
          <p>{TEXT_ISSUES_LEDE}</p>
          <p className="software-qa-lede">{TEXT_ISSUE_QA_LEDE}</p>
        </div>
        <div className="software-path-status">
          <span className="software-path-scope-wrap" data-testid="software-path-scope-label">
            <Chip tone="outline" title="这次文本检查使用的范围">
              范围：{stats.scopeLabel}
            </Chip>
          </span>
          <Chip tone={issues.length > 0 ? 'brass' : 'mint'}>路径问题 {issues.length} 项</Chip>
        </div>
      </header>

      {stats.skipped > 0 ? (
        <Notice tone="info" compact testId="software-path-skipped-count">
          另有 {stats.skipped} 条引用指向缓存/被忽略的目录，未计入问题。
        </Notice>
      ) : null}

      {stats.truncated ? (
        <Notice tone="warn" compact testId="software-path-truncated">
          同类问题过多，仅展示前一部分；去“智能检查”可以看完整列表。
        </Notice>
      ) : null}

      {report === null ? (
        <Notice tone="info" title="这次没有执行路径检查" testId="software-path-skipped">
          {stats.scope === 'off'
            ? '检查范围选择了“不检查”，所以这次只做了程序信息和 DLL 检查。需要检查文本路径时，把上方的范围切换到“仅配置文件”或“全部文本”后重新体检。'
            : '“智能检查”可能已在设置里关闭，或者当前没有启用的匹配规则，所以这次只做了程序信息检查。可以在设置里打开后重新体检。'}
        </Notice>
      ) : issues.length === 0 ? (
        <>
          <div className="software-success-inline" data-testid="software-path-ok">
            <CircleCheck size={16} aria-hidden="true" />
            <p>
              没有发现配置/脚本里的路径问题（检查了 {stats.checkedFiles} 个文件，范围：
              {stats.scopeLabel}）。
            </p>
          </div>
          {stats.scope === 'config' ? (
            <p className="software-path-tip">
              如果软件本身报“找不到文件”，可以把上方的检查范围切换到“全部文本”再体检一次；
              范围越大，误报也会越多。
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="software-section-lede">
            共 <strong>{issues.length}</strong> 项：可定位处理 {groups.fixable.length} 项、无法定位{' '}
            {groups.unfixable.length} 项。先看“可定位处理”，再决定要不要管“无法定位”。
          </p>

          {groups.fixable.length > 0 ? (
            <section className="software-path-group" aria-labelledby="software-path-fixable-title">
              <header className="software-path-group-head">
                <h3 id="software-path-fixable-title">可定位处理（{groups.fixable.length} 项）</h3>
                <Chip tone="brass">找到了可能的位置</Chip>
              </header>
              <p className="software-path-group-hint">
                这些引用在安装目录里找到了可能对应的文件。每张卡按四个问题依次说明，
                候选文件会显示缩略图或文字预览；软件体检只读，真正处理请到“智能检查”逐项确认
                （那边有预检、二次确认和自动备份）。
              </p>
              <ul className="software-issue-list">
                {groups.fixable.map((issue, index) => (
                  <FixableTextIssue
                    key={`${issue.id ?? issue.path}:${index}`}
                    issue={issue}
                    projectId={result.projectId}
                    projectName={result.projectName}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </section>
          ) : (
            <p className="software-path-all-unfixable">
              这次没有找到可以定位处理的问题；下面的“无法定位”通常不需要处理。
            </p>
          )}

          {groups.unfixable.length > 0 ? (
            <UnfixableTextIssues
              issues={groups.unfixable}
              projectName={result.projectName}
            />
          ) : null}

          <div className="software-issue-actions">
            <Button
              variant="default"
              size="sm"
              icon={<Sparkles size={14} />}
              onClick={() => onNavigate('dependencies')}
              data-testid="software-goto-dependencies"
            >
              去“智能检查”逐项确认
            </Button>
            <span className="software-issue-actions-note">
              那边的修复同样会先预检、二次确认并自动备份；软件体检页本身没有写入操作。
            </span>
          </div>
        </>
      )}
    </section>
  )
}

function LimitsSection({ result }: { result: SoftwareScanResult }): ReactNode {
  return (
    <details className="software-limits" data-testid="software-limitations">
      <summary>
        <span className="software-limits-title">
          <HelpTip>静态检查只能看文件，不能运行软件，所以一定存在查不到的情况。</HelpTip>
          无法判断的部分（静态检查的局限）
        </span>
        <Chip tone="muted">建议运行一次软件确认</Chip>
      </summary>
      <div className="software-limits-body">
        <p>
          下面这些依赖类型不在本次体检能覆盖的范围内。它们显示不出来，不代表一定有问题，
          而是“无法判断”：
        </p>
        <ul>
          {STATIC_CHECK_LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
        {result.binaryCapHit ? (
          <p className="software-limits-cap">
            <TriangleAlert size={13} aria-hidden="true" />
            本次解析的导入项超过上限，只分析了前一部分。其余导入项没有参与判断。
          </p>
        ) : null}
      </div>
    </details>
  )
}

function TechnicalDetails({ result }: { result: SoftwareScanResult }): ReactNode {
  const summary = summarizeSoftwareResult(result)
  const textStats = summarizeTextReport(result)
  const scanned =
    result.binaryFilesScanned.length > 0 ? result.binaryFilesScanned.join('、') : '无'
  return (
    <details className="software-technical" data-testid="software-technical">
      <summary>技术细节</summary>
      <dl>
        <div>
          <dt>软件名 / 版本</dt>
          <dd>
            {summary.name} · {summary.version}
          </dd>
        </div>
        <div>
          <dt>安装根目录</dt>
          <dd className="mono">{result.installRoot}</dd>
        </div>
        <div>
          <dt>入口程序</dt>
          <dd className="mono">{result.entryPath ?? '未指定'}</dd>
        </div>
        <div>
          <dt>二进制分析</dt>
          <dd>{BINARY_ANALYSIS_LABEL[result.binaryAnalysis]}</dd>
        </div>
        <div>
          <dt>已解析程序文件</dt>
          <dd className="mono">{scanned}</dd>
        </div>
        <div>
          <dt>导入项上限</dt>
          <dd>{result.binaryCapHit ? '已触发（结果可能不完整）' : '未触发'}</dd>
        </div>
        <div>
          <dt>路径检查范围</dt>
          <dd>{summary.pathScopeLabel}</dd>
        </div>
        <div>
          <dt>文本引用跳过 / 截断</dt>
          <dd>
            跳过 {textStats.skipped} 条 · {textStats.truncated ? '已截断显示' : '未截断'}
          </dd>
        </div>
        <div>
          <dt>文本引用检查</dt>
          <dd>
            {result.textReport
              ? `检查 ${result.textReport.summary.checkedFiles} 个文件 · 发现 ${result.textReport.issues.length} 项问题`
              : '未执行'}
          </dd>
        </div>
        <div>
          <dt>体检耗时</dt>
          <dd>{formatDuration(result.durationMs)}</dd>
        </div>
        <div>
          <dt>生成时间</dt>
          <dd>{formatDateTime(result.createdAt)}</dd>
        </div>
      </dl>
    </details>
  )
}

/* ------------------------------------------------------------------ */
/* Main panel                                                          */
/* ------------------------------------------------------------------ */

export function SoftwareReportPanel({
  result,
  onNavigate
}: {
  result: SoftwareScanResult
  onNavigate: (page: PageId) => void
}): ReactNode {
  const summary = summarizeSoftwareResult(result)
  const textStats = summarizeTextReport(result)
  const textGroups = groupTextIssues(result.textReport?.issues ?? [])
  const hasProblems = summary.missingBinary > 0 || summary.pathIssues > 0
  return (
    <div className="software-report" data-testid="software-report">
      <section className="software-summary" aria-labelledby="software-summary-title">
        <div className="software-summary-head">
          <div>
            <p className="plate-kicker mono">体检报告</p>
            <h2 id="software-summary-title">{summary.name}</h2>
            <p className="software-summary-meta-line">
              <Chip tone="outline">版本 {summary.version}</Chip>
              <Chip tone="outline">{summary.publisher}</Chip>
              <Chip tone="mint" title="只读体检，不会修改软件">
                <ShieldCheck size={11} aria-hidden="true" /> 只读
              </Chip>
            </p>
          </div>
          <div className="software-summary-status">
            <span className="software-summary-label">总体状态</span>
            <strong className={hasProblems ? 'is-warn' : 'is-ok'}>{summary.statusLine}</strong>
          </div>
        </div>

        <div className="software-summary-grid" data-testid="software-summary">
          <Stat
            label="缺少的软件依赖"
            value={summary.missingBinary}
            tone={summary.missingBinary > 0 ? 'red' : 'mint'}
          />
          <Stat
            label="路径问题"
            value={textStats.hasReport ? summary.pathIssues : '—'}
            tone={
              !textStats.hasReport ? 'muted' : summary.pathIssues > 0 ? 'brass' : 'mint'
            }
          />
          <Stat label="已解析程序文件" value={summary.binaryFiles} />
          <Stat label="体检耗时" value={formatDuration(result.durationMs)} />
        </div>

        <dl className="software-summary-facts">
          <div>
            <dt>软件名</dt>
            <dd>{summary.name}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{summary.version}</dd>
          </div>
          <div>
            <dt>安装位置</dt>
            <dd className="mono">{result.installRoot}</dd>
          </div>
          <div>
            <dt>分析状态</dt>
            <dd>{BINARY_ANALYSIS_LABEL[result.binaryAnalysis]}</dd>
          </div>
          <div>
            <dt>路径检查范围</dt>
            <dd>{summary.pathScopeLabel}</dd>
          </div>
        </dl>

        {summary.missingBinary > 0 ? (
          <div className="software-summary-alert" data-testid="software-summary-alert">
            <TriangleAlert size={16} aria-hidden="true" />
            <p>
              {summary.missingBinary} 项软件依赖找不到。先看下面“缺少的软件依赖”里标着“系统组件”还是“软件自带”。
              系统组件缺失通常需要重新安装软件或运行库；软件自带缺失可以先在软件目录里找找同名文件。
            </p>
          </div>
        ) : summary.pathIssues > 0 ? (
          <div className="software-summary-alert is-warn" data-testid="software-summary-alert">
            <CircleAlert size={16} aria-hidden="true" />
            <p>
              软件依赖都能找到，但“{textStats.scopeLabel}”范围里还有 {summary.pathIssues} 项文本路径问题：
              可定位处理 {textGroups.fixable.length} 项、无法定位 {textGroups.unfixable.length} 项。
              先看下面的“可定位处理”；“无法定位”的多为运行时拼接，通常不用处理。
            </p>
          </div>
        ) : !textStats.hasReport ? (
          <div className="software-summary-alert is-warn" data-testid="software-summary-alert">
            <Info size={16} aria-hidden="true" />
            <p>
              软件依赖都能找到，但这次没有执行文本路径检查
              {textStats.scope === 'off' ? '（你选择了“不检查”）' : '（智能检查可能在设置里关闭了）'}。
              需要检查配置/脚本里的路径时，把上方的范围切换一下再重新体检。
            </p>
          </div>
        ) : (
          <div className="software-summary-alert is-ok" data-testid="software-summary-alert">
            <CircleCheck size={16} aria-hidden="true" />
            <p>
              这次没有发现缺失的软件依赖或路径问题（文本检查范围：{textStats.scopeLabel}）。
              静态检查有局限，建议运行一次软件确认实际表现。
            </p>
          </div>
        )}
      </section>

      <BinarySection result={result} />
      <TextIssuesSection result={result} onNavigate={onNavigate} />

      {result.warnings.length > 0 ? (
        <section
          className="software-section software-warnings"
          aria-labelledby="software-warnings-title"
          data-testid="software-warnings"
        >
          <header className="software-section-head">
            <div>
              <p className="plate-kicker mono">03 · 警告</p>
              <h2 id="software-warnings-title">体检过程中的提示</h2>
              <p>这些提示不影响结论，但说明结果可能有盲区。</p>
            </div>
            <Chip tone="brass">{result.warnings.length} 条</Chip>
          </header>
          <ul>
            {result.warnings.map((warning, index) => (
              <li key={`warning:${index}:${warning}`}>
                <TriangleAlert size={13} aria-hidden="true" />
                {warning}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <LimitsSection result={result} />
      <TechnicalDetails result={result} />

      <footer className="software-report-footer">
        <p>
          <ShieldCheck size={13} aria-hidden="true" />
          {SAFETY_POINTS.join(' · ')}
        </p>
        <Button
          variant="ghost"
          size="sm"
          icon={<AppWindow size={13} />}
          onClick={() => onNavigate('dependencies')}
        >
          去“智能检查”
        </Button>
      </footer>
    </div>
  )
}
