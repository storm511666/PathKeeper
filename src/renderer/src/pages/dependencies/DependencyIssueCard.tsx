import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import type { PathKeeperApi } from '@shared/api'
import type { DependencyCandidate, DependencyIssue, FilePreview } from '@shared/types'
import {
  AlertTriangle,
  AppWindow,
  Archive,
  ArrowRight,
  Box,
  CircleAlert,
  Code2,
  Copy,
  File,
  FileInput,
  FileSearch,
  FolderOpen,
  Image as ImageIcon,
  Music,
  Package,
  RefreshCw,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  SkipForward,
  Sparkles,
  Table2,
  Video,
  type LucideIcon
} from 'lucide-react'
import { Button, Chip } from '@renderer/components/ui'
import { HelpTip } from '@renderer/components/HelpTip'
import { useApi } from '@renderer/api/context'
import { copyText } from '@renderer/lib/clipboard'
import type { HumanError } from '@renderer/lib/errors'
import {
  UNKNOWN_ENGLISH_TITLE,
  candidateReasonEvidence,
  humanizeFileView,
  type HumanConfidence,
  type HumanFileView
} from '@shared/fileHumanize'

const ROLE_LABEL: Record<DependencyIssue['role'], string> = {
  config: '配置',
  source: '源文件',
  input: '输入',
  cache: '缓存',
  output: '输出',
  unknown: '其他'
}

const SEVERITY_LABEL: Record<DependencyIssue['severity'], string> = {
  blocking: '会阻断使用',
  warning: '需要注意',
  info: '提示'
}

const REASON_LABEL: Record<DependencyCandidate['reason'], string> = {
  'same-name': '同名文件',
  'similar-name': '文件名相近',
  'same-folder': '同目录相似'
}

const HEALTH_LABEL: Record<DependencyIssue['health'], string> = {
  healthy: '正常',
  missing: '找不到文件',
  unreadable: '读取失败',
  corrupt: '文件损坏',
  'format-mismatch': '格式不一致',
  'version-mismatch': '版本不匹配',
  ignored: '已跳过'
}

/** Beginner-friendly continuation for non-missing health states. */
const BEGINNER_HEALTH_SUFFIX: Record<DependencyIssue['health'], string> = {
  healthy: '现在看起来正常',
  missing: '现在不在原来的位置',
  unreadable: '暂时读不出来',
  corrupt: '可能已经损坏',
  'format-mismatch': '的格式和扩展名对不上',
  'version-mismatch': '的版本对不上',
  ignored: '已经先跳过了'
}

const CONFIDENCE_LABEL: Record<HumanConfidence, string> = {
  high: '比较确定',
  medium: '推测',
  low: '不太确定'
}

const HUMAN_ICONS: Record<string, LucideIcon> = {
  settings: Settings2,
  code: Code2,
  archive: Archive,
  sparkles: Sparkles,
  image: ImageIcon,
  table: Table2,
  box: Box,
  music: Music,
  video: Video,
  'file-input': FileInput,
  'app-window': AppWindow,
  package: Package,
  file: File
}

/* ------------------------------------------------------------------ */
/* Candidate previews (lazy, cached, capped, never blocking)           */
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
  relativePath: string,
  enabled: boolean
): FilePreview | null {
  const key = previewCacheKey(projectId, relativePath)
  const [preview, setPreview] = useState<FilePreview | null>(() => {
    const cached = previewCache.get(key)
    return cached === undefined ? null : cached
  })

  useEffect(() => {
    if (!enabled || previewKindFor(relativePath) === null) {
      setPreview(null)
      return
    }
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
  }, [api, enabled, key, projectId, relativePath])

  return enabled ? preview : null
}

function CandidateThumbnail({ preview }: { preview: FilePreview }): ReactNode {
  if (preview.kind !== 'image' || preview.dataUrl === null) return null
  return (
    <span className="dependency-candidate-media" aria-hidden="true">
      <img
        className="dependency-candidate-thumb"
        src={preview.dataUrl}
        alt=""
        loading="lazy"
        data-testid="dependency-candidate-thumb"
      />
    </span>
  )
}

function CandidateTextPreview({
  preview,
  title
}: {
  preview: FilePreview
  title: string
}): ReactNode {
  if (preview.kind !== 'text') return null
  const lines = preview.lines.slice(0, 2)
  if (lines.length === 0) return null
  return (
    <pre
      className="dependency-candidate-preview mono"
      aria-hidden="true"
      title={title}
      data-testid="dependency-candidate-preview"
    >
      {lines.join('\n')}
    </pre>
  )
}

/* ------------------------------------------------------------------ */
/* Beginner title helpers                                              */
/* ------------------------------------------------------------------ */

function beginnerIssueTitle(issue: DependencyIssue, view: HumanFileView): string {
  const unknown = view.title === UNKNOWN_ENGLISH_TITLE
  if (issue.health === 'missing') {
    return unknown ? `找不到这个「${view.typeLabel}」` : `找不到这张「${view.title}」`
  }
  const subject = unknown ? `这个「${view.typeLabel}」` : `「${view.title}」`
  return `${subject}${BEGINNER_HEALTH_SUFFIX[issue.health]}`
}

interface BeginnerCandidateOptionProps {
  api: PathKeeperApi
  projectId: number
  candidate: DependencyCandidate
  selected: boolean
  tabbable: boolean
  onSelect?: (candidatePath: string) => void
}

/**
 * One beginner candidate row: readable title/type/breadcrumb/evidence, an
 * optional lazy thumbnail (image) or 1–2 line preview (code/config), and the
 * untouched raw path folded into a disclosure.
 */
function BeginnerCandidateOption({
  api,
  projectId,
  candidate,
  selected,
  tabbable,
  onSelect
}: BeginnerCandidateOptionProps): ReactNode {
  const view = useMemo(() => humanizeFileView(candidate.filePath), [candidate.filePath])
  const preview = useCandidatePreview(api, projectId, candidate.filePath, true)
  return (
    <div className={`dependency-candidate-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={tabbable ? 0 : -1}
        className={`dependency-candidate dependency-candidate-beginner${
          selected ? ' is-selected' : ''
        }`}
        data-testid="dependency-candidate"
        data-candidate-path={candidate.filePath}
        onClick={() => onSelect?.(candidate.filePath)}
      >
        <span className="dependency-candidate-radio" aria-hidden="true" />
        <span className="dependency-candidate-body">
          <span className="dependency-candidate-title-row">
            <span className="dependency-candidate-title" data-testid="dependency-candidate-title">
              {view.title}
            </span>
            <Chip tone={candidate.reason === 'same-name' ? 'mint' : 'brass'}>
              {REASON_LABEL[candidate.reason]}
            </Chip>
          </span>
          <span className="dependency-candidate-summary">
            {view.typeLabel} · {view.pathBreadcrumb}
          </span>
          <span className="dependency-candidate-why">
            为什么推荐：{candidateReasonEvidence(candidate.reason)}
          </span>
          {/* Raw path stays reachable for screen readers and e2e without
              cluttering the beginner layout. */}
          <span className="sr-only">{candidate.filePath}</span>
          {preview !== null ? <CandidateThumbnail preview={preview} /> : null}
        </span>
      </button>
      {preview !== null ? (
        <CandidateTextPreview preview={preview} title={view.title} />
      ) : null}
      <details className="dependency-candidate-raw">
        <summary>原始路径</summary>
        <code className="mono">{candidate.filePath}</code>
      </details>
    </div>
  )
}

export interface DependencyIssueCardProps {
  issue: DependencyIssue
  projectId: number
  beginnerMode: boolean
  selectedPath: string | null
  busy: boolean
  autoRepairEnabled: boolean
  error: HumanError | null
  onSelect?: (candidatePath: string) => void
  onAutoFix?: () => void
  onReselect?: () => void
  onRebuildCache?: () => void
  onSkip?: () => void
}

export function DependencyIssueCard({
  issue,
  projectId,
  beginnerMode,
  selectedPath,
  busy,
  autoRepairEnabled,
  error,
  onSelect,
  onAutoFix,
  onReselect,
  onRebuildCache,
  onSkip
}: DependencyIssueCardProps): ReactNode {
  const api = useApi()
  const view = useMemo(
    () => humanizeFileView(issue.path, { role: issue.role }),
    [issue.path, issue.role]
  )
  const HumanIcon = HUMAN_ICONS[view.icon] ?? File
  const selectedCandidate =
    issue.candidates.find((candidate) => candidate.filePath === selectedPath) ?? null
  const customSelected =
    selectedPath !== null && selectedCandidate === null ? selectedPath : null
  const customView = useMemo(
    () => (customSelected !== null ? humanizeFileView(customSelected) : null),
    [customSelected]
  )
  const severityIcon =
    issue.severity === 'blocking' ? (
      <CircleAlert size={18} aria-hidden="true" />
    ) : (
      <AlertTriangle size={18} aria-hidden="true" />
    )

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    []
  )

  const handleCopyPath = (): void => {
    void copyText(issue.path).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 2200)
    })
  }

  const handleReveal = (): void => {
    void api.system.showProjectFile(projectId, issue.path).catch(() => {
      // Latest OS state may be surprising; keep the card interactive and quiet.
    })
  }

  /* Roving focus + arrow-key navigation for the candidate radio group. */
  const activeCandidatePath = selectedPath ?? issue.candidates[0]?.filePath ?? null
  const handleCandidateKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const radios = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    )
    if (radios.length === 0) return
    const current = radios.findIndex((radio) => radio === document.activeElement)
    if (current < 0) return
    event.preventDefault()
    let next = current
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (current + 1) % radios.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (current - 1 + radios.length) % radios.length
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = radios.length - 1
    }
    const target = radios[next]
    if (!target) return
    target.focus()
    const candidatePath = target.dataset.candidatePath
    if (candidatePath !== undefined) onSelect?.(candidatePath)
  }

  const renderAdvancedCandidate = (candidate: DependencyCandidate): ReactNode => {
    const isSelected = candidate.filePath === selectedPath
    return (
      <button
        key={candidate.filePath}
        type="button"
        role="radio"
        aria-checked={isSelected}
        tabIndex={candidate.filePath === activeCandidatePath ? 0 : -1}
        className={`dependency-candidate${isSelected ? ' is-selected' : ''}`}
        data-testid="dependency-candidate"
        data-candidate-path={candidate.filePath}
        onClick={() => onSelect?.(candidate.filePath)}
      >
        <span className="dependency-candidate-radio" aria-hidden="true" />
        <code className="dependency-candidate-path mono">{candidate.filePath}</code>
        <Chip tone={candidate.reason === 'same-name' ? 'mint' : 'brass'}>
          {REASON_LABEL[candidate.reason]}
        </Chip>
      </button>
    )
  }

  return (
    <article
      className={`dependency-issue severity-${issue.severity}${beginnerMode ? ' is-beginner' : ''}`}
      data-testid="dependency-issue"
    >
      <header className="dependency-issue-head">
        <span className={`dependency-issue-icon severity-${issue.severity}`} aria-hidden="true">
          {severityIcon}
        </span>
        <div className="dependency-issue-title">
          <div className="dependency-issue-kicker">
            <Chip tone={issue.severity === 'blocking' ? 'red' : 'brass'}>
              {SEVERITY_LABEL[issue.severity]}
            </Chip>
            {beginnerMode ? (
              <>
                <span className="dependency-issue-human-icon" aria-hidden="true">
                  <HumanIcon size={13} />
                </span>
                <Chip tone="outline">{view.roleLabel}</Chip>
              </>
            ) : (
              <Chip tone="outline">{ROLE_LABEL[issue.role]}</Chip>
            )}
            <span className="dependency-issue-health">{HEALTH_LABEL[issue.health]}</span>
          </div>
          <h3 data-testid={beginnerMode ? 'dependency-human-title' : undefined}>
            {beginnerMode ? beginnerIssueTitle(issue, view) : issue.title}
          </h3>
          {beginnerMode ? (
            <>
              <p className="dependency-issue-type-line" data-testid="dependency-human-summary">
                它是：<strong>{view.typeLabel}</strong> · {view.explanation}
              </p>
              <nav
                className="dependency-issue-breadcrumb"
                aria-label="文件位置"
                data-testid="dependency-human-breadcrumb"
              >
                <span className="dependency-issue-breadcrumb-label">位置：</span>
                <span className="dependency-issue-breadcrumb-text">{view.pathBreadcrumb}</span>
              </nav>
            </>
          ) : (
            <code className="dependency-issue-path mono">{issue.path}</code>
          )}
        </div>
      </header>

      <div className="dependency-issue-copy">
        <p>
          {beginnerMode && issue.health === 'missing'
            ? issue.references.length > 0
              ? `项目里还有 ${issue.references.length} 处引用在找它。`
              : '它现在不在原来的位置，项目里的引用可能找不到它。'
            : issue.what}
        </p>
        <p className="dependency-issue-why">
          <strong>为什么要注意：</strong>
          {issue.why}
        </p>
        <p className="dependency-issue-hint">
          <strong>建议：</strong>
          {issue.fixHint}
        </p>
      </div>

      {beginnerMode ? (
        <details className="dependency-issue-technical" data-testid="dependency-issue-technical">
          <summary>技术细节（原始路径）</summary>
          <div className="dependency-issue-technical-body">
            <code
              className="dependency-issue-original-path mono"
              data-testid="dependency-original-path"
            >
              {issue.path}
            </code>
            <p className="dependency-issue-technical-meta">
              文件角色：{view.roleLabel}（{view.role}） · 识别可信度：
              {CONFIDENCE_LABEL[view.confidence]}
            </p>
            <div className="dependency-issue-technical-actions">
              <Button
                variant="ghost"
                size="sm"
                icon={<Copy size={13} />}
                onClick={handleCopyPath}
                data-testid="dependency-copy-path"
              >
                {copied ? '已复制原始路径' : '复制原始路径'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<FolderOpen size={13} />}
                onClick={handleReveal}
                data-testid="dependency-reveal-path"
              >
                在文件夹中显示
              </Button>
            </div>
          </div>
        </details>
      ) : null}

      {issue.candidates.length > 0 || customSelected ? (
        <div className="dependency-issue-candidates">
          <p className="dependency-issue-candidates-label">
            <FileSearch size={13} aria-hidden="true" />
            {beginnerMode
              ? '找找看，这些文件可能是它，选中一个再继续：'
              : '软件猜它可能在这些位置，选一个再修复：'}
            <HelpTip>
              同名/名字相近只是线索，不代表一定正确。请先看一眼文件内容或位置，
              选错了会改错引用；所有写入前都会自动备份。
            </HelpTip>
          </p>
          {beginnerMode ? (
            <p className="dependency-issue-candidates-note">
              推荐理由只基于软件能确认的线索：文件名相同、文件名相近、或者原来就在同一个文件夹。
            </p>
          ) : null}
          <div
            className="dependency-candidate-list"
            role="radiogroup"
            aria-label={beginnerMode ? `「${view.title}」的候选文件` : `${issue.path} 的候选位置`}
            onKeyDown={handleCandidateKeyDown}
          >
            {customSelected ? (
              beginnerMode ? (
                <div className="dependency-candidate-row is-selected">
                  <button
                    type="button"
                    role="radio"
                    aria-checked
                    tabIndex={customSelected === activeCandidatePath ? 0 : -1}
                    className="dependency-candidate dependency-candidate-beginner is-selected"
                    data-candidate-path={customSelected}
                    onClick={() => onSelect?.(customSelected)}
                  >
                    <span className="dependency-candidate-radio" aria-hidden="true" />
                    <span className="dependency-candidate-body">
                      <span className="dependency-candidate-title-row">
                        <span className="dependency-candidate-title">
                          {customView?.title ?? customSelected}
                        </span>
                        <Chip tone="brass">你选择的文件</Chip>
                      </span>
                      <span className="dependency-candidate-summary">
                        {customView !== null
                          ? `${customView.typeLabel} · ${customView.pathBreadcrumb}`
                          : customSelected}
                      </span>
                      <span className="sr-only">{customSelected}</span>
                    </span>
                  </button>
                  <details className="dependency-candidate-raw">
                    <summary>原始路径</summary>
                    <code className="mono">{customSelected}</code>
                  </details>
                </div>
              ) : (
                <button
                  type="button"
                  role="radio"
                  aria-checked
                  tabIndex={customSelected === activeCandidatePath ? 0 : -1}
                  className="dependency-candidate is-selected"
                  data-candidate-path={customSelected}
                  onClick={() => onSelect?.(customSelected)}
                >
                  <span className="dependency-candidate-radio" aria-hidden="true" />
                  <code className="dependency-candidate-path mono">{customSelected}</code>
                  <Chip tone="brass">你选择的文件</Chip>
                </button>
              )
            ) : null}
            {issue.candidates.map((candidate) =>
              beginnerMode ? (
                <BeginnerCandidateOption
                  key={candidate.filePath}
                  api={api}
                  projectId={projectId}
                  candidate={candidate}
                  selected={candidate.filePath === selectedPath}
                  tabbable={candidate.filePath === activeCandidatePath}
                  onSelect={onSelect}
                />
              ) : (
                renderAdvancedCandidate(candidate)
              )
            )}
          </div>
        </div>
      ) : (
        <p className="dependency-issue-empty">
          没有找到相似的现成文件。你可以自己选择新位置，或先跳过这一项。
        </p>
      )}

      {error ? (
        <div className="dependency-issue-error" role="alert">
          <strong>{error.title}</strong>
          <p>{error.message}</p>
          <ol>
            {error.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {error.technical ? (
            <details>
              <summary>技术细节</summary>
              <code className="mono">{error.technical}</code>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="dependency-issue-actions">
        {issue.canAutoFix && autoRepairEnabled ? (
          <Button
            variant="primary"
            size="sm"
            icon={<ArrowRight size={14} />}
            loading={busy}
            disabled={!selectedPath}
            data-testid="dependency-autofix"
            onClick={onAutoFix}
          >
            {beginnerMode ? '用这个文件' : '一键修复这条引用'}
          </Button>
        ) : null}
        {issue.canReselect && autoRepairEnabled ? (
          <Button
            variant="default"
            size="sm"
            icon={<FolderOpen size={14} />}
            disabled={busy}
            data-testid="dependency-reselect"
            onClick={onReselect}
          >
            {beginnerMode ? '我自己选' : '我自己选文件'}
          </Button>
        ) : null}
        {issue.canRebuildCache && autoRepairEnabled ? (
          <Button
            variant="default"
            size="sm"
            icon={<RefreshCw size={14} />}
            disabled={busy}
            data-testid="dependency-rebuild-cache"
            onClick={onRebuildCache}
          >
            重建缓存
          </Button>
        ) : null}
        {issue.canSkip ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<SkipForward size={14} />}
            disabled={busy}
            data-testid="dependency-skip"
            onClick={onSkip}
          >
            先跳过
          </Button>
        ) : null}
        {!autoRepairEnabled ? (
          <span className="dependency-issue-disabled-hint">
            自动修复建议已在设置中关闭，你仍可以先跳过，或去设置里打开。
          </span>
        ) : null}
        <span className="dependency-issue-safe">
          <ShieldQuestion size={13} aria-hidden="true" />
          修复前会备份，不会直接删除文件
        </span>
      </div>

      {issue.references.length > 0 ? (
        <details className="dependency-issue-refs">
          <summary>查看引用位置（{issue.references.length} 处）</summary>
          <ul>
            {issue.references.map((reference) => (
              <li key={`${reference.filePath}:${reference.line}:${reference.ruleName}`}>
                <code className="mono">
                  {reference.filePath}:{reference.line}
                </code>
                <span>{reference.ruleName}</span>
                <code className="mono dependency-issue-context">{reference.context}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {beginnerMode ? (
        <p className="dependency-issue-safe-footnote">
          <ShieldCheck size={12} aria-hidden="true" />
          原始英文路径仍保留在“技术细节”里，可随时复制或切回高级模式核对。
        </p>
      ) : null}
    </article>
  )
}
