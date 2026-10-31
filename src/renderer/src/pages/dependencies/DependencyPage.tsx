import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AppSettings,
  DependencyChangesResult,
  DependencyIssue,
  DependencyScanResult,
  Project
} from '@shared/types'
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  HeartPulse,
  HelpCircle,
  MousePointerClick,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench
} from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { useConfirm } from '@renderer/components/Confirm'
import { Modal } from '@renderer/components/Modal'
import { Button, Chip, Notice, Spinner, Stat } from '@renderer/components/ui'
import { HelpTip } from '@renderer/components/HelpTip'
import { errorCode, humanizeError, type HumanError } from '@renderer/lib/errors'
import type { PageId } from '@renderer/app-types'
import { DependencyGraph } from './DependencyGraph'
import { DependencyIssueCard } from './DependencyIssueCard'

const STEPS = [
  ['01', '选择工程', '选一个项目'],
  ['02', '自动检查', '软件自己找问题'],
  ['03', '处理问题', '修复或先跳过'],
  ['04', '完成', '确认结果']
] as const

function StepsBar({ current }: { current: number }): ReactNode {
  return (
    <ol className="deps-steps" aria-label="体检步骤">
      {STEPS.map(([index, title, sub], position) => {
        const number = position + 1
        const state = number < current ? 'done' : number === current ? 'active' : 'todo'
        return (
          <li key={index} className={`deps-step is-${state}`}>
            <span className="deps-step-index mono">{state === 'done' ? '✓' : index}</span>
            <span className="deps-step-copy">
              <strong>{title}</strong>
              <small>{sub}</small>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export interface DependencyPageProps {
  project: Project
  settings: AppSettings
  changeSignal: number
  latestChanges: DependencyChangesResult | null
  onNavigate: (page: PageId) => void
}

export function DependencyPage({
  project,
  settings,
  changeSignal,
  latestChanges,
  onNavigate
}: DependencyPageProps): ReactNode {
  const api = useApi()
  const toast = useToast()
  const confirm = useConfirm()
  const requestSequence = useRef(0)
  const lastChangeSignal = useRef(changeSignal)
  const [scan, setScan] = useState<DependencyScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanError, setScanError] = useState<HumanError | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string>>({})
  const [issueErrors, setIssueErrors] = useState<Record<string, HumanError | null>>({})
  const [busyIssue, setBusyIssue] = useState<string | null>(null)
  const [fixingAll, setFixingAll] = useState(false)
  const [changeNotice, setChangeNotice] = useState<DependencyChangesResult | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const selectedFor = useCallback(
    (issue: DependencyIssue): string | null =>
      selectedPaths[issue.id] ?? issue.candidates[0]?.filePath ?? null,
    [selectedPaths]
  )

  const runScan = useCallback(async (): Promise<void> => {
    if (!settings.dependencyCheckEnabled) return
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    setLoading(true)
    setScanError(null)
    setCancelled(false)
    setCancelling(false)
    try {
      const result = await api.dependencies.scan(project.id)
      if (sequence !== requestSequence.current) return
      setScan(result)
      const nextSelected: Record<string, string> = {}
      for (const issue of result.issues) {
        const first = issue.candidates[0]
        if (first) nextSelected[issue.id] = first.filePath
      }
      setSelectedPaths(nextSelected)
      setIssueErrors({})
      setChangeNotice(null)
    } catch (error) {
      if (sequence !== requestSequence.current) return
      // A user-requested stop is not a failure: show a calm "已取消" state.
      if (errorCode(error) === 'SCAN_CANCELLED') {
        setCancelled(true)
        return
      }
      setScanError(humanizeError(error))
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [api, project.id, settings.dependencyCheckEnabled])

  const handleCancelScan = useCallback(async (): Promise<void> => {
    if (cancelling) return
    setCancelling(true)
    try {
      await api.scanCancel()
    } catch {
      // The scan may have finished a moment before the click; nothing to do.
    } finally {
      setCancelling(false)
    }
  }, [api, cancelling])

  /* Auto scan when the project or the relevant settings change. */
  useEffect(() => {
    setScan(null)
    setScanError(null)
    setChangeNotice(null)
    setSelectedPaths({})
    setIssueErrors({})
    setCancelled(false)
    setCancelling(false)
    if (!settings.dependencyCheckEnabled) {
      setLoading(false)
      return
    }
    if (settings.dependencyAutoScanOnOpen) {
      void runScan()
    }
  }, [
    project.id,
    settings.dependencyCheckEnabled,
    settings.dependencyAutoScanOnOpen,
    runScan
  ])

  /* Watch changes while this page is open; all manual or disabled. */
  useEffect(() => {
    if (changeSignal === lastChangeSignal.current || !latestChanges) return
    lastChangeSignal.current = changeSignal
    setChangeNotice(latestChanges)
  }, [changeSignal, latestChanges])

  const refresh = useCallback((): void => {
    void runScan()
  }, [runScan])

  const validationHumanError = useCallback(
    (issue: DependencyIssue, errors: string[], warnings: string[]): HumanError => ({
      title: '这个文件暂时不能用来修复',
      message: errors[0] ?? '修复前检查没有通过。',
      steps: [
        '确认你选的是项目里的一个真实文件',
        '文件名和扩展名要和原来一致，避免选错内容',
        ...(warnings.length > 0 ? [`提醒：${warnings[0]}`] : [])
      ],
      technical: errors.join('；') || null,
      code: 'DEPENDENCY_PREFLIGHT_FAILED'
    }),
    []
  )

  const repairWithPath = useCallback(
    async (issue: DependencyIssue, newPath: string): Promise<void> => {
      setBusyIssue(issue.id)
      setIssueErrors((current) => ({ ...current, [issue.id]: null }))
      try {
        const validation = await api.dependencies.validateFix({
          projectId: project.id,
          oldPath: issue.path,
          newPath
        })
        if (!validation.valid) {
          setIssueErrors((current) => ({
            ...current,
            [issue.id]: validationHumanError(issue, validation.errors, validation.warnings)
          }))
          return
        }
        const accepted = await confirm({
          title: '确认修复这条引用？',
          description: (
            <>
              将把项目里指向 <code className="mono">{issue.path}</code> 的引用改为{' '}
              <code className="mono">{newPath}</code>。
            </>
          ),
          details: (
            <div className="dependency-confirm-details">
              <p>
                预计修改 {issue.references.length} 处引用。写入前会自动创建备份，
                如果发现不对，可以在“迁移历史”里回滚。
              </p>
              {validation.warnings.length > 0 ? (
                <p className="dependency-confirm-warning">
                  {validation.warnings.join('；')}
                </p>
              ) : null}
              <p>只修改文本中的路径，不会移动、删除或覆盖你的文件。</p>
            </div>
          ),
          confirmLabel: '修复并备份',
          testId: 'confirm-dependency-repair',
          confirmTestId: 'confirm-dependency-repair-accept'
        })
        if (!accepted) return
        const result = await api.dependencies.repair({
          projectId: project.id,
          oldPath: issue.path,
          newPath
        })
        toast.success(
          '已修复并自动备份',
          `${result.changedFiles} 个文件 · ${result.replacements} 处引用 · 剩余 ${result.remainingIssueCount} 项`
        )
        await runScan()
      } catch (error) {
        setIssueErrors((current) => ({
          ...current,
          [issue.id]: humanizeError(error)
        }))
      } finally {
        setBusyIssue(null)
      }
    },
    [api, confirm, project.id, runScan, toast, validationHumanError]
  )

  const handleAutoFix = useCallback(
    (issue: DependencyIssue): void => {
      const newPath = selectedFor(issue)
      if (!newPath) return
      void repairWithPath(issue, newPath)
    },
    [repairWithPath, selectedFor]
  )

  const handleReselect = useCallback(
    async (issue: DependencyIssue): Promise<void> => {
      try {
        const selected = await api.dialogs.pickProjectPath({
          projectId: project.id,
          side: 'new',
          kind: 'file'
        })
        if (!selected) return
        setSelectedPaths((current) => ({ ...current, [issue.id]: selected.relPath }))
        setIssueErrors((current) => ({ ...current, [issue.id]: null }))
        await repairWithPath(issue, selected.relPath)
      } catch (error) {
        setIssueErrors((current) => ({
          ...current,
          [issue.id]: humanizeError(error)
        }))
      }
    },
    [api, project.id, repairWithPath]
  )

  const handleSkip = useCallback(
    async (issue: DependencyIssue): Promise<void> => {
      setBusyIssue(issue.id)
      try {
        await api.dependencies.ignore(project.id, issue.path, true)
        toast.info('已跳过这项', '以后可以在“已跳过”里恢复，或重新体检。')
        await runScan()
      } catch (error) {
        setIssueErrors((current) => ({
          ...current,
          [issue.id]: humanizeError(error)
        }))
      } finally {
        setBusyIssue(null)
      }
    },
    [api, project.id, runScan, toast]
  )

  const handleUnignore = useCallback(
    async (path: string): Promise<void> => {
      try {
        await api.dependencies.ignore(project.id, path, false)
        toast.success('已恢复这一项', '下次体检会重新检查它。')
        await runScan()
      } catch (error) {
        toast.error('恢复失败', humanizeError(error).message)
      }
    },
    [api, project.id, runScan, toast]
  )

  const handleRebuildCache = useCallback(
    async (issue: DependencyIssue): Promise<void> => {
      const accepted = await confirm({
        title: '把这些缓存文件移到备份目录？',
        description: (
          <>
            这会把 <code className="mono">{issue.path}</code> 移到项目的
            <code className="mono">.pathkeeper-backup/dependency-cache-…</code>，让原程序重新生成。
          </>
        ),
        details: (
          <div className="dependency-confirm-details">
            <p>PathKeeper 不会直接删除缓存，移动后的文件仍可在备份目录找回。</p>
            <p>确认后请让原程序重新运行一次，生成新的缓存。</p>
          </div>
        ),
        confirmLabel: '移动并重新体检',
        tone: 'danger',
        testId: 'confirm-dependency-cache',
        confirmTestId: 'confirm-dependency-cache-accept'
      })
      if (!accepted) return
      setBusyIssue(issue.id)
      try {
        const result = await api.dependencies.rebuildCache(project.id, [issue.path])
        toast.success(
          '缓存已移到备份目录',
          `${result.movedFiles} 个文件 · ${result.backupDir}`
        )
        await runScan()
      } catch (error) {
        setIssueErrors((current) => ({
          ...current,
          [issue.id]: humanizeError(error)
        }))
      } finally {
        setBusyIssue(null)
      }
    },
    [api, confirm, project.id, runScan, toast]
  )

  const autoFixable = useMemo(
    () => (scan?.issues ?? []).filter((issue) => issue.canAutoFix),
    [scan]
  )

  const handleFixAll = useCallback(async (): Promise<void> => {
    if (autoFixable.length === 0 || fixingAll) return
    const accepted = await confirm({
      title: `一键修复 ${autoFixable.length} 项简单问题？`,
      description: '只处理“软件已经找到明确候选”的项，会逐项扫描并写入，每项写入前都会自动备份。',
      details: (
        <div className="dependency-batch-list">
          {autoFixable.slice(0, 8).map((issue) => (
            <p key={issue.id}>
              <code className="mono">{issue.path}</code>
              <ArrowRight size={11} aria-hidden="true" />
              <code className="mono">{selectedFor(issue)}</code>
            </p>
          ))}
          {autoFixable.length > 8 ? <p>还有 {autoFixable.length - 8} 项没有展开。</p> : null}
        </div>
      ),
      confirmLabel: '逐项修复并备份',
      tone: 'danger',
      testId: 'confirm-dependency-batch',
      confirmTestId: 'confirm-dependency-batch-accept'
    })
    if (!accepted) return
    setFixingAll(true)
    let repaired = 0
    const failures: string[] = []
    try {
      for (const issue of autoFixable) {
        const newPath = selectedFor(issue)
        if (!newPath) continue
        try {
          await api.dependencies.repair({
            projectId: project.id,
            oldPath: issue.path,
            newPath
          })
          repaired += 1
        } catch (error) {
          failures.push(`${issue.path}：${humanizeError(error).message}`)
        }
      }
      await runScan()
      if (failures.length > 0) {
        toast.info(
          `已修复 ${repaired} 项，还有 ${failures.length} 项没完成`,
          failures[0]
        )
      } else {
        toast.success('简单问题已逐项修复', `共处理 ${repaired} 项，已自动备份。`)
      }
    } finally {
      setFixingAll(false)
    }
  }, [api, autoFixable, confirm, fixingAll, project.id, runScan, selectedFor, toast])

  const stepCurrent = !scan ? 2 : scan.issues.length > 0 ? 3 : 4
  const disabled = !settings.dependencyCheckEnabled

  return (
    <div className="page dependency-page" data-testid="dependency-page">
      <header className="page-head">
        <div className="page-head-main">
          <p className="page-kicker mono">
            智能检查 · 新手工作台
            <HelpTip>
              这里不会自动修改你的项目。先体检，再让你选择怎么处理；
              写入前一定会备份，随时可以回滚。
            </HelpTip>
          </p>
          <h1 className="page-title">项目体检</h1>
          <p className="page-lede">
            {settings.beginnerMode
              ? '先让软件自己找问题，再用中文告诉你每个文件是什么、有什么用。原始英文路径会收在“技术细节”里，随时可以核对。'
              : '先让软件自己找问题。缺文件、路径变了、文件损坏，都会用大白话说清楚，再给你几个处理选项。'}
          </p>
        </div>
        <div className="page-head-meta">
          <span className="page-meta-label">当前工程</span>
          <code className="page-meta-path mono" title={project.name}>
            {project.name}
          </code>
          <span className="page-meta-hint">本机文件夹 · 只读检查</span>
        </div>
      </header>

      <StepsBar current={stepCurrent} />

      <div className="deps-toolbar">
        <div className="deps-toolbar-copy">
          <HeartPulse size={16} aria-hidden="true" />
          <span>
            {disabled
              ? '智能检查现在被关闭了。'
              : loading
                ? '正在读取项目文件并检查依赖…'
                : scan
                  ? `上次体检：${new Date(scan.createdAt).toLocaleTimeString('zh-CN')}`
                  : '还没有开始体检。'}
          </span>
        </div>
        <div className="deps-toolbar-actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<HelpCircle size={14} />}
            data-testid="dependency-guide"
            onClick={() => setGuideOpen(true)}
          >
            新手引导
          </Button>
          {loading ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Square size={12} />}
              loading={cancelling}
              data-testid="dependency-cancel-scan"
              onClick={() => void handleCancelScan()}
            >
              停止体检
            </Button>
          ) : null}
          {!disabled ? (
            <Button
              variant="default"
              size="sm"
              icon={<RefreshCw size={14} />}
              loading={loading}
              data-testid="dependency-rescan"
              onClick={refresh}
            >
              重新体检
            </Button>
          ) : null}
          {!settings.beginnerMode ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Settings2 size={14} />}
              onClick={() => onNavigate('migration')}
            >
              手动路径迁移
            </Button>
          ) : null}
        </div>
      </div>

      {disabled ? (
        <section className="deps-disabled-card">
          <span className="deps-disabled-icon" aria-hidden="true">
            <ShieldCheck size={26} />
          </span>
          <div>
            <h2>智能检查已关闭，项目不会被扫描</h2>
            <p>
              这个开关完全由你控制。关闭后不会扫描依赖；如果切到高级模式，
              仍然可以使用原来的手动路径迁移，不会丢失任何功能或历史记录。
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onNavigate('settings')}
            data-testid="dependency-enable-settings"
          >
            去设置打开
          </Button>
        </section>
      ) : loading ? (
        <section className="deps-loading-card" data-testid="dependency-loading">
          <Spinner label="正在检查项目依赖…" />
          <p>
            正在识别配置、源文件、输入、缓存和输出之间的关系。只读，不会修改文件。
            如果文件很多，可以随时点右上角的“停止体检”。
          </p>
        </section>
      ) : scanError ? (
        <section className="human-error-card" role="alert" data-testid="dependency-error">
          <div className="human-error-icon" aria-hidden="true">
            <CircleAlert size={22} />
          </div>
          <div>
            <h2>{scanError.title}</h2>
            <p>{scanError.message}</p>
            <ol>
              {scanError.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {scanError.technical ? (
              <details>
                <summary>技术细节</summary>
                <code className="mono">{scanError.technical}</code>
              </details>
            ) : null}
          </div>
          <Button variant="primary" size="sm" onClick={refresh}>
            重新体检
          </Button>
        </section>
      ) : !scan ? (
        cancelled ? (
          <section className="deps-cancelled-card" data-testid="dependency-cancelled">
            <span className="deps-cancelled-icon" aria-hidden="true">
              <ShieldCheck size={30} />
            </span>
            <div>
              <h2>体检已取消</h2>
              <p>
                这次体检已经按你的要求停下，没有任何项目文件被修改。
                准备好的时候，可以随时重新体检。
              </p>
            </div>
            <Button
              variant="primary"
              size="md"
              icon={<RefreshCw size={15} />}
              data-testid="dependency-start"
              onClick={refresh}
            >
              重新体检
            </Button>
          </section>
        ) : (
          <section className="deps-start-card">
            <span className="deps-start-icon" aria-hidden="true">
              <ScanSearch size={30} />
            </span>
            <div>
              <h2>准备好了？先花几秒钟体检一次</h2>
              <p>
                软件会自动找出项目里“指向不存在文件”的引用，并尝试推荐文件可能的新位置。
                你不需要先懂旧路径/新路径。
              </p>
            </div>
            <Button
              variant="primary"
              size="md"
              icon={<Sparkles size={15} />}
              data-testid="dependency-start"
              onClick={refresh}
            >
              开始体检
            </Button>
          </section>
        )
      ) : (
        <>
          {cancelled ? (
            <Notice
              tone="info"
              title="体检已取消"
              icon={<ShieldCheck size={15} />}
              actions={
                <Button variant="default" size="sm" onClick={refresh}>
                  重新体检
                </Button>
              }
              testId="dependency-cancelled"
            >
              这次体检已经按你的要求停下，没有修改任何文件。下面显示的是上一次完成的结果。
            </Notice>
          ) : null}

          <div className="deps-summary" data-testid="dependency-summary">
            <Stat label="检查文件" value={scan.summary.checkedFiles} />
            <Stat label="文件节点" value={scan.summary.totalNodes} />
            <Stat label="引用关系" value={scan.summary.totalEdges} />
            <Stat
              label="状态正常"
              value={scan.summary.healthyNodes}
              tone={scan.summary.issueCount === 0 ? 'mint' : 'default'}
            />
            <Stat
              label="需要处理"
              value={scan.summary.issueCount}
              tone={scan.summary.issueCount > 0 ? 'red' : 'mint'}
            />
            {scan.summary.autoFixable > 0 ? (
              <Stat label="可一键修复" value={scan.summary.autoFixable} tone="brass" />
            ) : null}
          </div>

          {scan.issues.length > 0 ? (
            <p className="deps-next-step">
              <Sparkles size={13} aria-hidden="true" />
              下一步：从下面第一个红色问题开始。选好候选位置后，点“一键修复这条引用”，
              再在弹窗里确认即可。
            </p>
          ) : null}

          {changeNotice ? (
            <Notice
              tone="warn"
              title="检测到项目文件有变化"
              icon={<RefreshCw size={15} />}
              actions={
                <Button variant="default" size="sm" onClick={refresh}>
                  重新体检
                </Button>
              }
              testId="dependency-change-notice"
            >
              你移动、改名或删除了文件。当前结果可能已经过期，重新体检才能拿到最新位置。
              {changeNotice.changes.length > 0 ? (
                <span className="deps-change-list">
                  {changeNotice.changes.slice(0, 3).map((change) => (
                    <code className="mono" key={`${change.kind}:${change.path}`}>
                      {change.path}
                    </code>
                  ))}
                </span>
              ) : null}
            </Notice>
          ) : null}

          {scan.issues.length === 0 ? (
            <section className="deps-success-card" data-testid="dependency-success">
              <span className="deps-success-icon" aria-hidden="true">
                <CheckCircle2 size={30} />
              </span>
              <div>
                <h2>
                  {scan.summary.ignoredCount > 0
                    ? '体检完成，剩下的项已经跳过'
                    : '体检完成，暂时没有发现问题'}
                </h2>
                <p>
                  {scan.summary.ignoredCount > 0
                    ? '你选择跳过的项目不会反复打扰你；需要时可以在下方恢复检查。'
                    : '当前工程里被识别到的文件引用都能找到对应文件。如果你刚刚才移动文件，可以点“重新体检”再看一次。'}
                </p>
              </div>
              <Button variant="default" size="sm" onClick={refresh}>
                再检查一次
              </Button>
            </section>
          ) : (
            <section className="deps-issues" aria-labelledby="deps-issues-title">
              <header className="deps-section-head">
                <div>
                  <p className="plate-kicker mono">需要处理</p>
                  <h2 id="deps-issues-title">
                    发现 {scan.issues.length} 项需要关注
                  </h2>
                  <p>建议从最上面的红色问题开始。不确定时可以先跳过，不会影响项目文件。</p>
                </div>
                {settings.dependencyAutoRepair && autoFixable.length > 0 ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Wrench size={14} />}
                    loading={fixingAll}
                    data-testid="dependency-fix-all"
                    onClick={() => void handleFixAll()}
                  >
                    一键修复 {autoFixable.length} 项简单问题
                  </Button>
                ) : null}
              </header>

              <div className="deps-issue-list">
                {scan.issues.map((issue) => (
                  <DependencyIssueCard
                    key={issue.id}
                    issue={issue}
                    projectId={project.id}
                    beginnerMode={settings.beginnerMode}
                    selectedPath={selectedFor(issue)}
                    busy={busyIssue === issue.id || fixingAll}
                    autoRepairEnabled={settings.dependencyAutoRepair}
                    error={issueErrors[issue.id] ?? null}
                    onSelect={(candidatePath) =>
                      setSelectedPaths((current) => ({ ...current, [issue.id]: candidatePath }))
                    }
                    onAutoFix={() => handleAutoFix(issue)}
                    onReselect={() => void handleReselect(issue)}
                    onRebuildCache={() => void handleRebuildCache(issue)}
                    onSkip={() => void handleSkip(issue)}
                  />
                ))}
              </div>
            </section>
          )}

          {scan.summary.ignoredCount > 0 ? (
            <details className="deps-ignored">
              <summary>
                有 {scan.summary.ignoredCount} 项被标记为“已跳过”，不会重复打扰你
              </summary>
              <ul>
                {scan.nodes
                  .filter((node) => node.health === 'ignored')
                  .map((node) => (
                    <li key={node.id}>
                      <code className="mono">{node.path}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleUnignore(node.path)}
                      >
                        恢复检查
                      </Button>
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}

          <DependencyGraph scan={scan} />

          <details className="deps-technical">
            <summary>技术细节（给熟练用户）</summary>
            <div className="deps-technical-body">
              <p>
                依赖角色由路径和扩展名自动推断；缺失/损坏检查只覆盖常见格式。
                版本检查仅在项目包含 <code className="mono">.pathkeeper/dependency-policy.json</code> 时生效。
              </p>
              {scan.warnings.length > 0 ? (
                <ul>
                  {scan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : (
                <p>本次检查没有技术警告。</p>
              )}
              <p className="deps-technical-time">
                耗时 {scan.durationMs} 毫秒 · 数据只在本机处理
              </p>
            </div>
          </details>
        </>
      )}

      <footer className="deps-footer">
        <span>
          <ShieldCheck size={13} aria-hidden="true" /> 体检只读 · 写入前备份 · 所有智能功能可在设置关闭
        </span>
        <Button variant="ghost" size="sm" onClick={() => onNavigate('settings')}>
          <Settings2 size={13} /> 检查设置
        </Button>
      </footer>

      <Modal
        open={guideOpen}
        title="新手三步走"
        description="不需要先懂路径。先看一遍，再按页面上的步骤点就好。"
        onClose={() => setGuideOpen(false)}
        width="md"
        testId="dependency-guide-dialog"
        footer={
          <Button variant="primary" onClick={() => setGuideOpen(false)}>
            知道了
          </Button>
        }
      >
        <div className="deps-guide-dialog">
          <article>
            <span className="deps-guide-icon"><ScanSearch size={18} /></span>
            <div>
              <h3>第 1 步：让软件体检</h3>
              <p>打开工程后会自动检查。也可以随时点“重新体检”。它只会读，不会改文件。</p>
            </div>
          </article>
          <article>
            <span className="deps-guide-icon"><MousePointerClick size={18} /></span>
            <div>
              <h3>第 2 步：看问题卡选位置</h3>
              <p>红色卡表示会影响使用。软件会推荐可能的新位置；不确定就先点“先跳过”。</p>
            </div>
          </article>
          <article>
            <span className="deps-guide-icon"><ShieldCheck size={18} /></span>
            <div>
              <h3>第 3 步：确认修复</h3>
              <p>点“一键修复”后还会弹一次确认。写入前自动备份，改错可在“修改记录”里回滚。</p>
            </div>
          </article>
        </div>
      </Modal>
    </div>
  )
}
