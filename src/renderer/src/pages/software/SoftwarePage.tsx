/**
 * “扫描一个软件” page (plan A5 + A6).
 *
 * Flow: pick an .exe/.lnk or install directory → confirm the detected metadata
 * and options → add the software project (first run) → run a read-only scan →
 * render the report with Markdown/JSON export.
 *
 * Safety (plan A6): this page never starts the target program, never modifies
 * it, never downloads DLLs and never asks for elevation. It contains no write
 * actions at all; even the “去智能检查” path only navigates.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AppSettings,
  Project,
  SoftwareInspectResult,
  SoftwarePickMode,
  SoftwareScanResult,
  SoftwareTextScanScope
} from '@shared/types'
import {
  AppWindow,
  CircleAlert,
  FileJson,
  FileText,
  FolderOpen,
  HelpCircle,
  Info,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { Button, Chip, Notice, Spinner } from '@renderer/components/ui'
import { HelpTip } from '@renderer/components/HelpTip'
import { useToast } from '@renderer/components/Toast'
import { humanizeError, type HumanError } from '@renderer/lib/errors'
import { formatDateTime, formatDuration } from '@renderer/lib/format'
import type { PageId } from '@renderer/app-types'
import { SoftwareReportPanel } from './SoftwareReportPanel'
import {
  DEFAULT_TEXT_SCAN_SCOPE,
  READ_ONLY_PLEDGE,
  SAFETY_POINTS,
  TEXT_SCAN_NOISE_HINT,
  TEXT_SCAN_SCOPE_LABEL,
  TEXT_SCAN_SCOPE_OPTIONS,
  basenameOf,
  buildSoftwareJsonReport,
  buildSoftwareMarkdownReport,
  softwareDisplayName,
  softwarePublisherLabel,
  softwareReportFileName,
  softwareVersionLabel,
  textScanScopeLabel,
  textScanScopeOf
} from './softwareReport'

/* ------------------------------------------------------------------ */
/* Small shared pieces                                                 */
/* ------------------------------------------------------------------ */

function CheckLine({
  checked,
  onChange,
  label,
  hint,
  testId,
  disabled = false
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  testId: string
  disabled?: boolean
}): ReactNode {
  return (
    <label className="software-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="software-check-copy">
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  )
}

/**
 * Honest “路径引用检查范围” picker shown before a scan starts.
 *
 * Installed programs contain bundled scripts, logs and generated asset maps
 * whose paths are assembled at runtime; a full-text pass mostly produces
 * false positives, so the default is config files only.
 */
function ScopeChooser({
  value,
  disabled = false,
  onChange
}: {
  value: SoftwareTextScanScope
  disabled?: boolean
  onChange: (scope: SoftwareTextScanScope) => void
}): ReactNode {
  return (
    <fieldset
      className="software-scope-fieldset"
      data-testid="software-text-scope"
      disabled={disabled}
    >
      <legend>路径引用检查范围</legend>
      <p className="software-scope-noise-hint">{TEXT_SCAN_NOISE_HINT}</p>
      <div className="software-scope-options">
        {TEXT_SCAN_SCOPE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`software-scope-option${value === option.value ? ' is-active' : ''}`}
          >
            <input
              type="radio"
              name="software-text-scope-choice"
              value={option.value}
              checked={value === option.value}
              data-testid={`software-text-scope-${option.value}`}
              onChange={() => onChange(option.value)}
            />
            <span className="software-scope-option-copy">
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function SoftwareIcon({ dataUrl }: { dataUrl: string | null }): ReactNode {
  if (dataUrl) {
    return (
      <span className="software-app-icon">
        <img src={dataUrl} alt="" width={44} height={44} />
      </span>
    )
  }
  return (
    <span className="software-app-icon is-fallback" aria-hidden="true">
      <AppWindow size={24} />
    </span>
  )
}

function ErrorCard({
  error,
  onRetry
}: {
  error: HumanError
  onRetry: () => void
}): ReactNode {
  return (
    <section className="software-error-card" role="alert" data-testid="software-error">
      <span className="software-error-icon" aria-hidden="true">
        <CircleAlert size={22} />
      </span>
      <div>
        <h2>{error.title}</h2>
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
      <Button variant="primary" size="sm" onClick={onRetry} data-testid="software-retry">
        重新体检
      </Button>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Setup / confirm cards                                               */
/* ------------------------------------------------------------------ */

function SelectionCard({
  picking,
  error,
  onPick
}: {
  picking: SoftwarePickMode | null
  error: HumanError | null
  onPick: (mode: SoftwarePickMode) => void
}): ReactNode {
  return (
    <section className="software-setup-card" data-testid="software-setup">
      <div className="software-setup-head">
        <span className="software-setup-icon" aria-hidden="true">
          <ScanSearch size={30} />
        </span>
        <div>
          <h2>扫描一个软件</h2>
          <p>{READ_ONLY_PLEDGE}</p>
        </div>
      </div>

      <div className="software-setup-actions">
        <Button
          variant="primary"
          size="md"
          icon={<AppWindow size={15} />}
          loading={picking === 'file'}
          disabled={picking !== null}
          data-testid="software-select-exe"
          onClick={() => onPick('file')}
        >
          选择 .exe / 快捷方式
        </Button>
        <Button
          variant="default"
          size="md"
          icon={<FolderOpen size={15} />}
          loading={picking === 'directory'}
          disabled={picking !== null}
          data-testid="software-select-dir"
          onClick={() => onPick('directory')}
        >
          选择安装目录
        </Button>
      </div>

      <ul className="software-setup-hints">
        <li>支持 Windows 程序（.exe）和它的快捷方式（.lnk）；也可以直接选择软件安装目录。</li>
        <li>
          安装目录通常类似 <code className="mono">C:\Program Files\软件名</code>；
          不确定时，可以从快捷方式右键“打开文件所在位置”。
        </li>
        <li>软件体检只读：不会启动、不会修改这个软件，也不会自动下载 DLL。</li>
      </ul>

      {error ? (
        <Notice tone="danger" title={error.title} testId="software-pick-error">
          <p>{error.message}</p>
          {error.steps.length > 0 ? (
            <ol>
              {error.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
        </Notice>
      ) : null}
    </section>
  )
}

function ConfirmCard({
  draft,
  includeBinary,
  includeSubdirs,
  textScope,
  starting,
  error,
  project,
  dependencyCheckEnabled,
  onToggleBinary,
  onToggleSubdirs,
  onScopeChange,
  onStart,
  onReselect,
  onCancel
}: {
  draft: SoftwareInspectResult
  includeBinary: boolean
  includeSubdirs: boolean
  textScope: SoftwareTextScanScope
  starting: boolean
  error: HumanError | null
  project: Project | null
  dependencyCheckEnabled: boolean
  onToggleBinary: (checked: boolean) => void
  onToggleSubdirs: (checked: boolean) => void
  onScopeChange: (scope: SoftwareTextScanScope) => void
  onStart: () => void
  onReselect: () => void
  onCancel: () => void
}): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true })
  }, [draft])

  const name = softwareDisplayName(draft.info, basenameOf(draft.rootPath))
  const version = softwareVersionLabel(draft.info)
  const publisher = softwarePublisherLabel(draft.info)
  return (
    <section
      ref={containerRef}
      className="software-confirm-card"
      data-testid="software-confirm"
      role="region"
      aria-labelledby="software-confirm-title"
      tabIndex={-1}
    >
      <header className="software-confirm-head">
        <SoftwareIcon dataUrl={draft.info.iconDataUrl} />
        <div>
          <p className="plate-kicker mono">已识别</p>
          <h2 id="software-confirm-title">
            {name}
            <span className="software-confirm-version">{version}</span>
          </h2>
          <p className="software-confirm-publisher">发布者：{publisher}</p>
        </div>
      </header>

      <dl className="software-confirm-facts">
        <div>
          <dt>安装位置</dt>
          <dd className="mono">{draft.rootPath}</dd>
        </div>
        <div>
          <dt>入口文件</dt>
          <dd className="mono">{draft.entryPath ?? '未指定（只扫描安装目录）'}</dd>
        </div>
        <div>
          <dt>扫描范围</dt>
          <dd>安装目录里的文本路径（范围见下方选择）+ 程序导入的文件（DLL，可选）</dd>
        </div>
      </dl>

      <ScopeChooser value={textScope} disabled={starting} onChange={onScopeChange} />

      {draft.warnings.length > 0 ? (
        <Notice tone="info" title="选择时的提示" testId="software-inspect-warnings">
          <ul>
            {draft.warnings.map((warning, index) => (
              <li key={`inspect-warning:${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="software-confirm-options">
        <CheckLine
          checked={includeBinary}
          onChange={onToggleBinary}
          label="检查程序导入的文件（DLL）"
          hint="解析 exe/dll 的导入表，只读文件头；不加载、不运行程序。"
          testId="software-include-binary"
          disabled={starting}
        />
        <CheckLine
          checked={includeSubdirs}
          onChange={onToggleSubdirs}
          label="包含子目录（默认开）"
          hint="当前版本安装目录扫描固定包含子目录，这个开关暂时只作为提示。"
          testId="software-include-subdirs"
          disabled
        />
      </div>

      {!dependencyCheckEnabled ? (
        <Notice tone="info" testId="software-dependency-disabled-note">
          智能检查在设置里是关闭状态。软件体检仍然只读展示结果，不会自动修复任何引用；
          需要处理路径问题时，请先到设置里重新打开智能检查。
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title={error.title} testId="software-start-error">
          <p>{error.message}</p>
          {error.steps.length > 0 ? (
            <ol>
              {error.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
        </Notice>
      ) : null}

      <div className="software-confirm-actions">
        <Button
          variant="primary"
          size="md"
          icon={<ScanSearch size={15} />}
          loading={starting}
          disabled={starting}
          data-testid="software-start-scan"
          onClick={onStart}
        >
          开始体检
        </Button>
        <Button variant="default" size="md" onClick={onReselect} disabled={starting}>
          重新选择
        </Button>
        <Button variant="ghost" size="md" onClick={onCancel} disabled={starting}>
          {project?.kind === 'software' ? '返回报告' : '取消'}
        </Button>
        <span className="software-confirm-note">
          <ShieldCheck size={13} aria-hidden="true" />
          确认后只读体检，不会启动或修改这个软件
        </span>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export interface SoftwarePageProps {
  project: Project | null
  settings: AppSettings
  /** Inspection handed over by the welcome screen / sidebar action. */
  draft: SoftwareInspectResult | null
  onDraftConsumed: () => void
  /** App refreshes its project list, switches the active project and persists it. */
  onSoftwareCreated: (project: Project) => Promise<void>
  onNavigate: (page: PageId) => void
}

export function SoftwarePage({
  project,
  settings,
  draft: externalDraft,
  onDraftConsumed,
  onSoftwareCreated,
  onNavigate
}: SoftwarePageProps): ReactNode {
  const api = useApi()
  const toast = useToast()

  const [draft, setDraft] = useState<SoftwareInspectResult | null>(externalDraft)
  const [picking, setPicking] = useState<SoftwarePickMode | null>(null)
  const [pickError, setPickError] = useState<HumanError | null>(null)
  const [includeBinary, setIncludeBinary] = useState(true)
  const [includeSubdirs, setIncludeSubdirs] = useState(true)
  const [textScope, setTextScope] = useState<SoftwareTextScanScope>(DEFAULT_TEXT_SCAN_SCOPE)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<HumanError | null>(null)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<SoftwareScanResult | null>(null)
  const [scanError, setScanError] = useState<HumanError | null>(null)
  const [exporting, setExporting] = useState<'markdown' | 'json' | null>(null)
  /* Icon returned by the picker; the scan result may not repeat it. */
  const [softwareIcon, setSoftwareIcon] = useState<string | null>(null)

  const requestSequence = useRef(0)
  const autoScanKey = useRef<string | null>(null)
  const expectedProject = useRef<number | null>(null)
  const lastProjectKey = useRef<number | null>(project?.id ?? null)
  const includeBinaryRef = useRef(includeBinary)
  const textScopeRef = useRef(textScope)

  useEffect(() => {
    includeBinaryRef.current = includeBinary
  }, [includeBinary])

  useEffect(() => {
    textScopeRef.current = textScope
  }, [textScope])

  /* Consume an inspection result handed over by App (welcome / sidebar flow). */
  useEffect(() => {
    if (!externalDraft) return
    setDraft(externalDraft)
    setSoftwareIcon(externalDraft.info.iconDataUrl)
    setPickError(null)
    setStartError(null)
    onDraftConsumed()
  }, [externalDraft, onDraftConsumed])

  /* Reset visible state when the active project changes; keep it when the
     change is the project we just created from the confirm card. */
  const projectKey = project?.id ?? null
  useEffect(() => {
    if (lastProjectKey.current === projectKey) return
    lastProjectKey.current = projectKey
    const expected = projectKey !== null && expectedProject.current === projectKey
    expectedProject.current = null
    if (expected) return
    requestSequence.current += 1
    setScanning(false)
    setResult(null)
    setScanError(null)
    setDraft(null)
    setPickError(null)
    setStartError(null)
    setSoftwareIcon(null)
    setTextScope(DEFAULT_TEXT_SCAN_SCOPE)
  }, [projectKey])

  const runScan = useCallback(
    async (
      target: Project,
      include: boolean,
      scope: SoftwareTextScanScope,
      announce = false
    ): Promise<void> => {
      const sequence = requestSequence.current + 1
      requestSequence.current = sequence
      setScanning(true)
      setScanError(null)
      try {
        const next = await api.software.scan({
          projectId: target.id,
          includeBinary: include,
          textScan: scope
        })
        if (sequence !== requestSequence.current) return
        setResult(next)
        if (announce) {
          toast.success('软件体检完成', '报告只读生成，没有启动或修改这个软件。')
        }
      } catch (error) {
        if (sequence !== requestSequence.current) return
        setScanError(humanizeError(error))
      } finally {
        if (sequence === requestSequence.current) setScanning(false)
      }
    },
    [api, toast]
  )

  /* Auto-scan once when a software project is opened (read-only, cancellable). */
  useEffect(() => {
    if (!project || project.kind !== 'software') {
      autoScanKey.current = null
      return
    }
    const key = `project:${project.id}`
    if (autoScanKey.current === key) return
    autoScanKey.current = key
    void runScan(project, includeBinaryRef.current, textScopeRef.current)
  }, [project, runScan])

  const handlePick = useCallback(
    async (mode: SoftwarePickMode): Promise<void> => {
      if (picking !== null || starting) return
      setPicking(mode)
      setPickError(null)
      setStartError(null)
      try {
        const inspected = await api.software.pick(mode)
        if (!inspected) return
        setDraft(inspected)
        setSoftwareIcon(inspected.info.iconDataUrl)
        setIncludeBinary(true)
      } catch (error) {
        const human = humanizeError(error)
        setPickError(human)
        toast.error('没有选中软件', human.message)
      } finally {
        setPicking(null)
      }
    },
    [api, picking, starting, toast]
  )

  const handleStart = useCallback(async (): Promise<void> => {
    const inspected = draft
    if (!inspected || starting) return
    setStarting(true)
    setStartError(null)
    try {
      /* Creating (or re-using) the software project is idempotent in the main
         process: the same install root converts/switches to that project. This
         also covers “扫描另一个软件” while a software project is already open. */
      const productName = inspected.info.productName?.trim()
      const created = await api.software.add({
        rootPath: inspected.rootPath,
        entryPath: inspected.entryPath,
        ...(productName ? { name: productName } : {})
      })
      expectedProject.current = created.id
      autoScanKey.current = `project:${created.id}`
      await onSoftwareCreated(created)
      setDraft(null)
      setResult(null)
      setScanError(null)
      await runScan(created, includeBinary, textScope, true)
    } catch (error) {
      setStartError(humanizeError(error))
    } finally {
      setStarting(false)
    }
  }, [api, draft, includeBinary, onSoftwareCreated, runScan, starting, textScope])

  const handleRescan = useCallback((): void => {
    if (!project || project.kind !== 'software' || scanning || starting) return
    void runScan(project, includeBinary, textScope, true)
  }, [includeBinary, project, runScan, scanning, starting, textScope])

  /**
   * The compact report-header selector: changing the scope immediately rescans
   * with that scope, so the report and the selector never disagree for long.
   * The confirm card uses `setTextScope` directly; its scan starts on “开始体检”.
   */
  const handleTextScopeChange = useCallback(
    (nextScope: SoftwareTextScanScope): void => {
      setTextScope(nextScope)
      if (!project || project.kind !== 'software' || scanning || starting) return
      void runScan(project, includeBinary, nextScope, true)
    },
    [includeBinary, project, runScan, scanning, starting]
  )

  const handleReveal = useCallback((): void => {
    if (!project || project.kind !== 'software') return
    void api.projects.reveal(project.id).catch((error: unknown) => {
      const human = humanizeError(error)
      toast.error('无法打开软件目录', human.message)
    })
  }, [api, project, toast])

  const handleExport = useCallback(
    async (format: 'markdown' | 'json'): Promise<void> => {
      if (!result || exporting !== null) return
      setExporting(format)
      try {
        const content =
          format === 'markdown'
            ? buildSoftwareMarkdownReport(result)
            : buildSoftwareJsonReport(result)
        const saved = await api.dialogs.saveTextFile({
          defaultName: softwareReportFileName(result, format === 'markdown' ? 'md' : 'json'),
          content
        })
        if (saved) {
          toast.success('报告已导出', saved)
        } else {
          toast.info('已取消导出', '没有写入任何文件。')
        }
      } catch (error) {
        const human = humanizeError(error)
        toast.error('导出失败', human.message)
      } finally {
        setExporting(null)
      }
    },
    [api, exporting, result, toast]
  )

  /** Ask the main process to stop the running software scan. */
  const handleCancelScan = useCallback((): void => {
    void api.scanCancel().catch(() => undefined)
    toast.info('正在停止扫描…', '已请求停止，本次扫描不会写入任何文件。')
  }, [api, toast])

  const isSoftwareProject = project?.kind === 'software'
  const headInfo = result?.info ?? null
  const headName = softwareDisplayName(headInfo, project?.name ?? '')
  const headVersion = headInfo ? softwareVersionLabel(headInfo) : null

  let body: ReactNode
  if (draft) {
    body = (
      <ConfirmCard
        draft={draft}
        includeBinary={includeBinary}
        includeSubdirs={includeSubdirs}
        textScope={textScope}
        starting={starting}
        error={startError}
        project={project}
        dependencyCheckEnabled={settings.dependencyCheckEnabled}
        onToggleBinary={setIncludeBinary}
        onToggleSubdirs={setIncludeSubdirs}
        onScopeChange={setTextScope}
        onStart={() => void handleStart()}
        onReselect={() => void handlePick(draft.entryPath ? 'file' : 'directory')}
        onCancel={() => {
          setDraft(null)
          setStartError(null)
        }}
      />
    )
  } else if (!isSoftwareProject) {
    body = <SelectionCard picking={picking} error={pickError} onPick={(mode) => void handlePick(mode)} />
  } else if (scanning && !result) {
    body = (
      <section className="software-loading-card" data-testid="software-loading">
        <Spinner label="正在体检这个软件…" />
        <p>
          读取程序信息并检查文本路径引用（范围：{TEXT_SCAN_SCOPE_LABEL[textScope]}）。
          全程只读，不会启动这个软件。
        </p>
      </section>
    )
  } else if (scanError && !result) {
    body = <ErrorCard error={scanError} onRetry={handleRescan} />
  } else if (result) {
    body = (
      <>
        {scanError ? (
          <Notice
            tone="warn"
            title={scanError.title}
            testId="software-rescan-error"
            actions={
              <Button variant="default" size="sm" onClick={handleRescan}>
                重新体检
              </Button>
            }
          >
            {scanError.message}
            {scanError.steps.length > 0 ? ` 建议：${scanError.steps[0]}` : null}
          </Notice>
        ) : scanning ? (
          <Notice tone="info" compact testId="software-rescanning">
            <Spinner label="正在重新体检…" />
          </Notice>
        ) : null}
        <SoftwareReportPanel result={result} onNavigate={onNavigate} />
      </>
    )
  } else {
    body = (
      <section className="software-start-card" data-testid="software-start">
        <span className="software-setup-icon" aria-hidden="true">
          <ScanSearch size={30} />
        </span>
        <div>
          <h2>还没有体检记录</h2>
          <p>
            {READ_ONLY_PLEDGE} 体检会检查程序信息、导入的 DLL，以及配置/脚本里的路径引用；
            路径引用的检查范围可以在页面上方选择（默认仅配置文件）。
          </p>
          <CheckLine
            checked={includeBinary}
            onChange={setIncludeBinary}
            label="检查程序导入的文件（DLL）"
            testId="software-start-include-binary"
          />
        </div>
        <Button
          variant="primary"
          size="md"
          icon={<ScanSearch size={15} />}
          loading={scanning}
          onClick={handleRescan}
          data-testid="software-start-scan"
        >
          开始体检
        </Button>
      </section>
    )
  }

  return (
    <div className="page software-page" data-testid="software-page">
      {isSoftwareProject && !draft ? (
        <header className="software-head" data-testid="software-header">
          <div className="software-head-main">
            <SoftwareIcon dataUrl={headInfo?.iconDataUrl ?? softwareIcon} />
            <div className="software-head-copy">
              <p className="page-kicker mono">
                软件体检 · 只读报告
                <HelpTip>
                  软件体检不会启动或修改这个软件。缺失系统组件时只给出重装建议，
                  不会自动下载 DLL，也不会自动提权。
                </HelpTip>
              </p>
              <h1 className="page-title">
                {headName}
                {headVersion && headVersion !== '未知版本' ? (
                  <span className="software-head-version">{headVersion}</span>
                ) : null}
              </h1>
              <p className="software-head-meta">
                <Chip tone="mint" title="只读体检，不修改这个软件">
                  <ShieldCheck size={11} aria-hidden="true" /> 只读
                </Chip>
                <Chip tone="outline">软件项目</Chip>
                <code className="software-head-path mono" title={project?.rootPath ?? ''}>
                  {project?.rootPath ?? ''}
                </code>
              </p>
              {result ? (
                <p className="software-head-status">
                  上次体检：{formatDateTime(result.createdAt)} · 耗时{' '}
                  {formatDuration(result.durationMs)}
                </p>
              ) : null}
            </div>
          </div>
          <div className="software-head-actions">
            <CheckLine
              checked={includeBinary}
              onChange={setIncludeBinary}
              label="检查 DLL 导入"
              testId="software-include-binary-rescan"
              disabled={scanning || starting}
            />
            <Button
              variant="primary"
              icon={<RefreshCw size={14} />}
              loading={scanning}
              disabled={starting}
              data-testid="software-rescan"
              title={`用当前选择的范围（${TEXT_SCAN_SCOPE_LABEL[textScope]}）重新体检`}
              onClick={handleRescan}
            >
              重新体检
            </Button>
            {scanning ? (
              <Button
                variant="ghost"
                size="md"
                data-testid="software-cancel-scan"
                onClick={handleCancelScan}
              >
                停止扫描
              </Button>
            ) : null}
            <Button
              variant="default"
              icon={<FolderOpen size={14} />}
              disabled={!isSoftwareProject}
              data-testid="software-reveal"
              onClick={handleReveal}
            >
              在文件夹中显示
            </Button>
            <Button
              variant="default"
              icon={<FileText size={14} />}
              disabled={!result}
              loading={exporting === 'markdown'}
              data-testid="software-export-md"
              onClick={() => void handleExport('markdown')}
            >
              导出 Markdown
            </Button>
            <Button
              variant="default"
              icon={<FileJson size={14} />}
              disabled={!result}
              loading={exporting === 'json'}
              data-testid="software-export-json"
              onClick={() => void handleExport('json')}
            >
              导出 JSON
            </Button>
          </div>
          <div className="software-head-scope" data-testid="software-scope-bar">
            <label className="software-scope-control">
              <span className="software-scope-control-label">路径引用检查范围</span>
              <select
                className="software-scope-select"
                data-testid="software-text-scope-select"
                value={textScope}
                disabled={scanning || starting}
                aria-label="路径引用检查范围（切换后会自动重新体检）"
                onChange={(event) =>
                  handleTextScopeChange(event.target.value as SoftwareTextScanScope)
                }
              >
                {TEXT_SCAN_SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {TEXT_SCAN_SCOPE_LABEL[option.value]}
                  </option>
                ))}
              </select>
            </label>
            {result ? (
              <span className="software-scope-chip-wrap" data-testid="software-text-scope-chip">
                <Chip tone="outline" title="上次体检实际使用的文本检查范围">
                  报告范围：{textScanScopeLabel(textScanScopeOf(result))}
                </Chip>
              </span>
            ) : null}
            <span className="software-scope-bar-hint">
              切换范围会自动重新体检；只读，不会修改这个软件。
            </span>
          </div>
        </header>
      ) : (
        <header className="page-head">
          <div className="page-head-main">
            <p className="page-kicker mono">
              软件体检 · 只读
              <HelpTip>
                PathKeeper 只读取程序信息和安装目录里的文本路径，不会运行这个软件。
              </HelpTip>
            </p>
            <h1 className="page-title">扫描一个软件</h1>
            <p className="page-lede">
              选一个 Windows 程序或它的安装目录，PathKeeper 会只读检查程序信息、导入的 DLL，
              以及配置/脚本里写着的路径。不会启动、不会修改这个软件。
            </p>
          </div>
          <div className="page-head-meta">
            <span className="page-meta-label">安全边界</span>
            <span className="software-head-safe mono">
              <ShieldCheck size={12} aria-hidden="true" /> 只读 · 不启动 · 不下载
            </span>
            <span className="page-meta-hint">不需要管理员权限</span>
          </div>
        </header>
      )}

      <p className="software-sr-only" role="status" aria-live="polite">
        {scanning ? '正在体检软件…' : result ? '软件体检完成' : ''}
      </p>

      {body}

      {!draft && !isSoftwareProject ? (
        <Notice tone="info" icon={<Info size={15} />} testId="software-safety-note">
          <p>{READ_ONLY_PLEDGE}</p>
          <ul className="software-safety-list">
            {SAFETY_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <footer className="software-footer">
        <span>
          <ShieldCheck size={13} aria-hidden="true" /> 只读体检 · 不启动软件 · 不下载 DLL ·
          不自动提权
        </span>
        <div className="software-footer-actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<HelpCircle size={13} />}
            onClick={() => onNavigate('settings')}
          >
            检查设置
          </Button>
          {isSoftwareProject ? (
            <span className="software-footer-hint">
              <TriangleAlert size={12} aria-hidden="true" />
              静态检查有局限，建议运行一次软件确认
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  )
}
