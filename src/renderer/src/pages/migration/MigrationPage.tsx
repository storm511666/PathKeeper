import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AppSettings,
  ApplyResult,
  AutoCheckCandidate,
  AutoCheckGroup,
  AutoCheckResult,
  MatchModes,
  PathInfo,
  PathKindInput,
  Project,
  ScanProgress,
  ScanResult
} from '@shared/types'
import { TriangleAlert } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { Button, Notice, RouteMotif } from '@renderer/components/ui'
import { describeError } from '@renderer/lib/errors'
import { buildScanCsv } from '@renderer/lib/csv'
import { sanitizeFileName, timestampSlug } from '@renderer/lib/format'
import type { MigrationSeed } from '@renderer/app-types'
import { AutoCheckBanner } from './AutoCheckBanner'
import { AutoCheckDialog } from './AutoCheckDialog'
import { MigrationComposer } from './MigrationComposer'
import { ScanProgressPanel } from './ScanProgressPanel'
import { ResultsLedger } from './ResultsLedger'
import { AppliedPanel } from './AppliedPanel'
import { ApplyDialog } from './ApplyDialog'

const INITIAL_PROGRESS: ScanProgress = {
  phase: 'preparing',
  filesScanned: 0,
  filesTotal: 0,
  currentFile: null,
  percent: 0
}

function LedgerPlaceholder(): ReactNode {
  return (
    <section className="ledger-placeholder" aria-label="扫描结果占位">
      <RouteMotif variant="scan" />
      <div className="ledger-placeholder-copy">
        <h2>扫描结果会列在这里</h2>
        <p>
          填好迁移路线并开始扫描。结果以台账形式列出每一处引用，可勾选、导出 CSV 复核，
          再对选中行执行写入。
        </p>
        <p className="ledger-placeholder-note">扫描只读取文本，不会写入任何文件。</p>
      </div>
    </section>
  )
}

export interface MigrationPageProps {
  project: Project
  settings: AppSettings
  seed: MigrationSeed | null
  onSeedConsumed: () => void
  onSettingsChange: (settings: AppSettings) => void
  onOpenHistory: () => void
}

export function MigrationPage({
  project,
  settings,
  seed,
  onSeedConsumed,
  onSettingsChange,
  onOpenHistory
}: MigrationPageProps): ReactNode {
  const api = useApi()
  const toast = useToast()

  const [oldPath, setOldPath] = useState(seed?.oldPath ?? '')
  const [newPath, setNewPath] = useState(seed?.newPath ?? '')
  const [kind, setKind] = useState<PathKindInput>(seed?.kind ?? 'auto')

  const [preview, setPreview] = useState<PathInfo | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const [modes, setModes] = useState<MatchModes>(settings.matchModes)
  const [modesSaving, setModesSaving] = useState(false)

  const [scanning, setScanning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [scanCancelled, setScanCancelled] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')

  const [applyOpen, setApplyOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)

  const [exporting, setExporting] = useState(false)

  const [autoOpen, setAutoOpen] = useState(false)
  const [autoLoading, setAutoLoading] = useState(false)
  const [autoResult, setAutoResult] = useState<AutoCheckResult | null>(null)
  const [autoError, setAutoError] = useState<string | null>(null)

  /* One-shot prefill from history "重新扫描". */
  useEffect(() => {
    if (!seed) return
    setOldPath(seed.oldPath)
    setNewPath(seed.newPath)
    setKind(seed.kind)
    setScan(null)
    setSelected(new Set())
    setApplyResult(null)
    setApplyOpen(false)
    setFilter('')
    setScanError(null)
    setScanCancelled(false)
    onSeedConsumed()
  }, [seed, onSeedConsumed])

  /* Debounced normalized-path preview. */
  useEffect(() => {
    const oldValue = oldPath.trim()
    const newValue = newPath.trim()
    if (!oldValue || !newValue) {
      setPreview(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    const timer = setTimeout(() => {
      api.paths
        .preview({ projectId: project.id, oldPath: oldValue, newPath: newValue, kind })
        .then((info) => {
          if (cancelled) return
          setPreview(info)
          setPreviewError(null)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setPreview(null)
          setPreviewError(describeError(error).message)
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false)
        })
    }, 320)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, project.id, oldPath, newPath, kind])

  /* Main -> renderer scan progress events. */
  useEffect(() => {
    const unsubscribe = api.events.onScanProgress((next) => {
      setProgress(next)
    })
    return unsubscribe
  }, [api])

  /* A finished scan should be visible: scroll the ledger into view and move
     keyboard focus to the results heading. Respect reduced-motion. */
  const resultsAnchorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!scan) return
    const frame = requestAnimationFrame(() => {
      const anchor = resultsAnchorRef.current
      if (!anchor) return
      const heading = document.getElementById('scan-results-heading')
      ;(heading ?? anchor).focus({ preventScroll: true })
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      anchor.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [scan])

  const filteredItems = useMemo(() => {
    if (!scan) return []
    const query = filter.trim().toLowerCase()
    if (!query) return scan.items
    return scan.items.filter((item) =>
      [item.filePath, item.ruleName, item.oldText, item.newText, item.context].some((value) =>
        value.toLowerCase().includes(query)
      )
    )
  }, [scan, filter])

  const selectedItems = useMemo(
    () => (scan ? scan.items.filter((item) => selected.has(item.id)) : []),
    [scan, selected]
  )

  const routeChanged = useMemo(() => {
    if (!scan) return false
    return (
      oldPath.trim() !== scan.oldPathInput ||
      newPath.trim() !== scan.newPathInput ||
      modes.strict !== scan.modes.strict ||
      modes.basename !== scan.modes.basename ||
      modes.directory !== scan.modes.directory
    )
  }, [scan, oldPath, newPath, modes])

  const applied = applyResult !== null
  const applyDisabledReason = applied
    ? '本次扫描已写入完成，结果不可重复应用。请重新扫描后再继续。'
    : routeChanged
      ? '迁移路线或匹配范围已修改，当前结果来自上一次扫描。请重新扫描后再应用。'
      : null

  const handleModesChange = useCallback(
    (next: MatchModes): void => {
      const enabledCount = Number(next.strict) + Number(next.basename) + Number(next.directory)
      if (enabledCount === 0) {
        toast.error('至少保留一种匹配范围。')
        return
      }
      const previous = modes
      setModes(next)
      setModesSaving(true)
      api.settings
        .update({ matchModes: next })
        .then((updated) => {
          setModes(updated.matchModes)
          onSettingsChange(updated)
        })
        .catch((error: unknown) => {
          setModes(previous)
          toast.error('无法保存匹配范围', describeError(error).message)
        })
        .finally(() => setModesSaving(false))
    },
    [api, modes, onSettingsChange, toast]
  )

  const resetScanState = (): void => {
    setScan(null)
    setSelected(new Set())
    setApplyResult(null)
    setApplyOpen(false)
    setFilter('')
    setScanError(null)
    setScanCancelled(false)
    setApplyError(null)
  }

  const handleOldPathChange = useCallback(
    (value: string): void => {
      setOldPath(value)
      if (scan) resetScanState()
    },
    [scan]
  )

  const handleNewPathChange = useCallback(
    (value: string): void => {
      setNewPath(value)
      if (scan) resetScanState()
    },
    [scan]
  )

  const handleKindChange = useCallback(
    (value: PathKindInput): void => {
      setKind(value)
      if (scan) resetScanState()
    },
    [scan]
  )

  const handleSwap = useCallback((): void => {
    setOldPath(newPath)
    setNewPath(oldPath)
    if (scan) resetScanState()
  }, [newPath, oldPath, scan])

  const performScan = useCallback(
    async (oldValue: string, newValue: string, kindValue: PathKindInput): Promise<void> => {
      const trimmedOld = oldValue.trim()
      const trimmedNew = newValue.trim()
      if (!trimmedOld || !trimmedNew || scanning) return
      setScanning(true)
      setCancelling(false)
      setScanCancelled(false)
      setProgress(INITIAL_PROGRESS)
      setScanError(null)
      setScan(null)
      setSelected(new Set())
      setApplyResult(null)
      setApplyOpen(false)
      setApplyError(null)
      setFilter('')
      try {
        const result = await api.scan({
          projectId: project.id,
          oldPath: trimmedOld,
          newPath: trimmedNew,
          kind: kindValue,
          modes
        })
        setScan(result)
        setSelected(new Set(result.items.map((item) => item.id)))
        if (result.budgetStopped) {
          toast.info('扫描因预算提前停止', '结果可能不完整；没有写入任何文件。')
        } else if (result.items.length === 0) {
          toast.info('扫描完成，没有发现匹配', '可以调整路径或匹配范围后重新扫描。')
        } else {
          toast.success(
            '扫描完成，未写入文件',
            `${result.items.length} 处匹配 · ${result.scannedFiles} 个文件已读取`
          )
        }
      } catch (error) {
        const described = describeError(error)
        if (described.code === 'SCAN_CANCELLED') {
          // Cancellation is a deliberate user action, not a failure.
          setScanCancelled(true)
          setScanError(null)
          toast.info('扫描已停止', '没有写入任何文件。')
        } else {
          setScanError(described.message)
          toast.error('扫描失败', described.message)
        }
      } finally {
        setScanning(false)
        setCancelling(false)
        setProgress(null)
      }
    },
    [api, scanning, project.id, modes, toast]
  )

  const handleScan = useCallback(async (): Promise<void> => {
    await performScan(oldPath, newPath, kind)
  }, [performScan, oldPath, newPath, kind])

  /** Ask the backend to abort the running scan; the promise rejects calmly. */
  const handleCancelScan = useCallback((): void => {
    if (cancelling) return
    setCancelling(true)
    api
      .scanCancel()
      .catch(() => {
        // The scan may have finished between the click and the request; the
        // normal completion path already shows the result.
      })
      .finally(() => setCancelling(false))
  }, [api, cancelling])

  const runAutoCheck = useCallback(async (): Promise<void> => {
    if (autoLoading) return
    setAutoOpen(true)
    setAutoLoading(true)
    setAutoError(null)
    setAutoResult(null)
    try {
      const result = await api.autoCheck(project.id)
      setAutoResult(result)
    } catch (error) {
      setAutoError(describeError(error).message)
    } finally {
      setAutoLoading(false)
    }
  }, [api, autoLoading, project.id])

  const handleUseAutoCheck = useCallback(
    (group: AutoCheckGroup, candidate: AutoCheckCandidate): void => {
      setAutoOpen(false)
      setOldPath(group.missingPath)
      setNewPath(candidate.filePath)
      setKind('file')
      setScan(null)
      setSelected(new Set())
      setApplyResult(null)
      setApplyOpen(false)
      setFilter('')
      setScanError(null)
      toast.info(
        '已填入自动检查建议的路径',
        '正在扫描引用；结果仍是只读预览，请核对后再写入。'
      )
      void performScan(group.missingPath, candidate.filePath, 'file')
    },
    [performScan, toast]
  )

  const toggleItem = useCallback((id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const addVisible = useCallback((): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const item of filteredItems) next.add(item.id)
      return next
    })
  }, [filteredItems])

  const removeVisible = useCallback((): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const item of filteredItems) next.delete(item.id)
      return next
    })
  }, [filteredItems])

  const invertVisible = useCallback((): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const item of filteredItems) {
        if (next.has(item.id)) next.delete(item.id)
        else next.add(item.id)
      }
      return next
    })
  }, [filteredItems])

  const handleExport = useCallback(async (): Promise<void> => {
    if (!scan || exporting) return
    const rows = selectedItems.length > 0 ? selectedItems : scan.items
    const onlySelected = selectedItems.length > 0
    if (rows.length === 0) {
      toast.info('没有可导出的结果。')
      return
    }
    setExporting(true)
    try {
      const content = buildScanCsv(rows)
      const savedPath = await api.dialogs.saveTextFile({
        defaultName: `${sanitizeFileName(project.name)}-路径迁移-${timestampSlug()}.csv`,
        content
      })
      if (savedPath) {
        toast.success(
          'CSV 已导出',
          `${savedPath}（${rows.length} 行${onlySelected ? '，仅选中' : '，全部结果'}）`
        )
      } else {
        toast.info('已取消导出。')
      }
    } catch (error) {
      toast.error('导出 CSV 失败', describeError(error).message)
    } finally {
      setExporting(false)
    }
  }, [api, exporting, project.name, scan, selectedItems, toast])

  const handleOpenApply = useCallback((): void => {
    if (!scan || selectedItems.length === 0 || applied || routeChanged) return
    setApplyError(null)
    setApplyOpen(true)
  }, [scan, selectedItems.length, applied, routeChanged])

  const handleConfirmApply = useCallback(async (): Promise<void> => {
    if (!scan || applying) return
    setApplying(true)
    setApplyError(null)
    try {
      const result = await api.apply({
        scanToken: scan.scanToken,
        occurrenceIds: selectedItems.map((item) => item.id)
      })
      setApplyResult(result)
      setSelected(new Set())
      setApplyOpen(false)
      toast.success(
        '写入完成',
        `${result.filesChanged} 个文件 · ${result.replacements} 处替换 · 备份 ${result.backupId}`
      )
    } catch (error) {
      const described = describeError(error)
      setApplyError(described.message)
      toast.error('写入失败，未修改文件', described.message)
    } finally {
      setApplying(false)
    }
  }, [api, applying, scan, selectedItems, toast])

  const handleRevealFile = useCallback(
    (filePath: string): void => {
      void api.system.showProjectFile(project.id, filePath).catch((error: unknown) => {
        toast.error('无法定位文件', describeError(error).message)
      })
    },
    [api, project.id, toast]
  )

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head-main">
          <p className="page-kicker mono">
            项目 {String(project.id).padStart(2, '0')} · {scanning ? '扫描中' : applied ? '已写入' : '只读预演'}
          </p>
          <h1 className="page-title">路径迁移</h1>
          <p className="page-lede">
            记录一次文件或目录移动，扫描项目中的旧路径引用，确认后逐条写入并自动备份。
          </p>
        </div>
        <div className="page-head-meta">
          <span className="page-meta-label">项目根目录</span>
          <code className="page-meta-path mono" title={project.rootPath}>
            {project.rootPath}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="page-meta-link"
            onClick={onOpenHistory}
          >
            查看迁移历史
          </Button>
        </div>
      </header>

      <AutoCheckBanner
        loading={autoLoading}
        disabled={scanning}
        onCheck={() => void runAutoCheck()}
      />

      <MigrationComposer
        project={project}
        oldPath={oldPath}
        newPath={newPath}
        kind={kind}
        modes={modes}
        modesSaving={modesSaving}
        preview={preview}
        previewLoading={previewLoading}
        previewError={previewError}
        scanning={scanning}
        canScan={oldPath.trim().length > 0 && newPath.trim().length > 0 && !scanning}
        scanError={scanError}
        applied={applied}
        onOldPathChange={handleOldPathChange}
        onNewPathChange={handleNewPathChange}
        onKindChange={handleKindChange}
        onSwap={handleSwap}
        onModesChange={handleModesChange}
        onScan={() => void handleScan()}
      />

      <div
        className="results-anchor"
        ref={resultsAnchorRef}
        tabIndex={-1}
        role="region"
        aria-label="扫描结果"
      >
        {scanning && progress ? (
          <ScanProgressPanel
            progress={progress}
            cancelling={cancelling}
            onCancel={handleCancelScan}
          />
        ) : null}

        {scanCancelled && !scanning ? (
          <Notice
            tone="info"
            title="扫描已停止"
            actions={
              <Button variant="default" size="sm" onClick={() => void handleScan()}>
                重新扫描
              </Button>
            }
          >
            你停止了本次扫描，没有写入任何文件。已读取的部分结果不会保留，可以随时重新开始。
          </Notice>
        ) : null}

        {scan?.budgetStopped && !scanning ? (
          <Notice
            tone="warn"
            icon={<TriangleAlert size={15} />}
            title="扫描因预算提前停止"
            actions={
              <Button variant="default" size="sm" onClick={() => void handleScan()}>
                重新扫描
              </Button>
            }
          >
            为避免长时间占用资源，单次扫描最多读取约 512 MB 或 2 分钟。结果可能不完整；可以缩小扫描范围、减少超大文件后重试。
          </Notice>
        ) : null}

        {applied && applyResult && scan ? (
          <AppliedPanel result={applyResult} scan={scan} onRescan={() => void handleScan()} />
        ) : null}

        {routeChanged && !applied ? (
          <Notice
            tone="warn"
            compact
            icon={<TriangleAlert size={15} />}
            title="路线已修改，当前结果已过期"
            actions={
              <Button variant="default" size="sm" onClick={() => void handleScan()}>
                用新路线重新扫描
              </Button>
            }
          >
            扫描结果来自上一次的旧路径 / 新路径。为避免改错位置，应用按钮已禁用。
          </Notice>
        ) : null}

        {scan ? (
          <ResultsLedger
            scan={scan}
            items={filteredItems}
            selected={selected}
            filter={filter}
            applied={applyResult}
            exporting={exporting}
            applyDisabled={applied || routeChanged || selectedItems.length === 0}
            applyDisabledReason={applyDisabledReason}
            onFilterChange={setFilter}
            onToggle={toggleItem}
            onSelectAll={addVisible}
            onSelectNone={removeVisible}
            onInvert={invertVisible}
            onExport={() => void handleExport()}
            onApply={handleOpenApply}
            onRevealFile={handleRevealFile}
          />
        ) : !scanning ? (
          <LedgerPlaceholder />
        ) : null}
      </div>

      <AutoCheckDialog
        open={autoOpen}
        loading={autoLoading}
        result={autoResult}
        error={autoError}
        onClose={() => setAutoOpen(false)}
        onRetry={() => void runAutoCheck()}
        onUse={handleUseAutoCheck}
        beginnerMode={settings.beginnerMode}
      />

      <ApplyDialog
        open={applyOpen}
        projectName={project.name}
        projectRoot={project.rootPath}
        scan={scan}
        selectedItems={selectedItems}
        applying={applying}
        error={applyError}
        onCancel={() => {
          setApplyOpen(false)
          setApplyError(null)
        }}
        onConfirm={() => void handleConfirmApply()}
      />
    </div>
  )
}
