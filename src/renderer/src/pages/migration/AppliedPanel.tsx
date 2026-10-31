import type { ReactNode } from 'react'
import type { ApplyResult, ScanResult } from '@shared/types'
import { CircleCheck, FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { describeError } from '@renderer/lib/errors'
import { formatCount } from '@renderer/lib/format'
import { Button, Chip } from '@renderer/components/ui'

export interface AppliedPanelProps {
  result: ApplyResult
  scan: ScanResult
  onRescan: () => void
}

/** Persistent success panel shown after a real apply (never auto-dismissed). */
export function AppliedPanel({ result, scan, onRescan }: AppliedPanelProps): ReactNode {
  const api = useApi()
  const toast = useToast()

  const revealBackup = (): void => {
    void api.backups.reveal(result.backupId).catch((error: unknown) => {
      toast.error('无法打开备份目录', describeError(error).message)
    })
  }

  return (
    <section className="applied-panel" data-testid="apply-success" aria-label="写入结果">
      <div className="applied-head">
        <span className="applied-icon" aria-hidden="true">
          <CircleCheck size={17} />
        </span>
        <div className="applied-title-group">
          <h2 className="applied-title">写入完成</h2>
          <p className="applied-sub">
            迁移 #{result.migrationId} · 备份 #{result.backupId} · {formatCount(result.filesChanged)} 个文件 ·{' '}
            {formatCount(result.replacements)} 处替换
          </p>
        </div>
        <Chip tone="mint">已应用</Chip>
      </div>
      <div className="applied-grid">
        <div className="applied-field">
          <span className="applied-label">备份目录</span>
          <code className="applied-value mono" title={result.backupDir}>
            {result.backupDir}
          </code>
        </div>
        <div className="applied-field">
          <span className="applied-label">扫描来源</span>
          <code className="applied-value mono">
            {scan.oldPathInput} → {scan.newPathInput}
          </code>
        </div>
      </div>
      {result.skipped.length > 0 ? (
        <div className="applied-skipped">
          <p>
            <ShieldAlert size={13} aria-hidden="true" /> {result.skipped.length} 条记录被跳过：
          </p>
          <ul>
            {result.skipped.map((item) => (
              <li key={item.id}>
                <code className="mono">{item.filePath}</code>
                <span>{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="applied-actions">
        <Button variant="default" size="sm" icon={<FolderOpen size={14} />} onClick={revealBackup}>
          打开备份文件夹
        </Button>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={onRescan}>
          重新扫描
        </Button>
        <span className="applied-note">本次扫描结果不可重复写入。需要继续迁移请重新扫描。</span>
      </div>
    </section>
  )
}
