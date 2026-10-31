import type { ReactNode } from 'react'
import type { ScanProgress } from '@shared/types'
import { scanPhaseLabel } from '@renderer/lib/labels'
import { Button, ProgressBar } from '@renderer/components/ui'

export interface ScanProgressPanelProps {
  progress: ScanProgress
  /** Stops the running scan; omitted when cancellation is unavailable. */
  onCancel?: () => void
  /** True while the stop request is in flight. */
  cancelling?: boolean
}

export function ScanProgressPanel({
  progress,
  onCancel,
  cancelling = false
}: ScanProgressPanelProps): ReactNode {
  const total = progress.filesTotal > 0 ? progress.filesTotal : null
  return (
    <section className="scan-progress" role="status" aria-live="polite" aria-label="扫描进度">
      <div className="scan-progress-head">
        <span className="scan-phase">
          <span className="scan-pulse" aria-hidden="true" />
          {scanPhaseLabel(progress.phase)}
        </span>
        <span className="scan-count mono">
          {progress.filesScanned}
          {total !== null ? ` / ${total}` : ''} 个文件
        </span>
        <span className="scan-percent mono">{Math.round(progress.percent)}%</span>
        {onCancel ? (
          <Button
            variant="ghost"
            size="sm"
            className="scan-cancel"
            loading={cancelling}
            aria-label="停止扫描"
            onClick={onCancel}
          >
            {cancelling ? '正在停止…' : '停止扫描'}
          </Button>
        ) : null}
      </div>
      <ProgressBar percent={progress.percent} label={`扫描进度 ${Math.round(progress.percent)}%`} />
      <p className="scan-current mono" title={progress.currentFile ?? undefined}>
        {progress.currentFile ?? '正在准备文件清单…'}
      </p>
      <p className="scan-hint">
        扫描是只读的，可以随时停止；已扫描到的结果不会写入任何文件。
      </p>
    </section>
  )
}
