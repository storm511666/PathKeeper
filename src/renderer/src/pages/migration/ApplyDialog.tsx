import { useMemo, type ReactNode } from 'react'
import type { ScanOccurrence, ScanResult } from '@shared/types'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button, InlineError, Notice } from '@renderer/components/ui'
import { formatCount } from '@renderer/lib/format'

export function buildFileGroups(items: ScanOccurrence[]): Array<{ filePath: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item.filePath, (counts.get(item.filePath) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([filePath, count]) => ({ filePath, count }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
}

export interface ApplyDialogProps {
  open: boolean
  projectName: string
  projectRoot: string
  scan: ScanResult | null
  selectedItems: ScanOccurrence[]
  applying: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Explicit write confirmation: lists exactly which files and how many
 * replacements will be written, and where the automatic backup will go.
 */
export function ApplyDialog({
  open,
  projectName,
  projectRoot,
  scan,
  selectedItems,
  applying,
  error,
  onCancel,
  onConfirm
}: ApplyDialogProps): ReactNode {
  const files = useMemo(() => buildFileGroups(selectedItems), [selectedItems])
  const total = selectedItems.length

  return (
    <Modal
      open={open}
      title="确认写入这些修改？"
      description={
        <>
          将对「{projectName}」中的 {formatCount(files.length)} 个文件执行 {formatCount(total)} 处路径替换。
          这是整个流程中唯一会写入磁盘的步骤。
        </>
      }
      onClose={() => {
        if (!applying) onCancel()
      }}
      width="md"
      testId="apply-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={applying}>
            取消，不写入
          </Button>
          <Button
            variant="danger"
            data-testid="confirm-apply"
            loading={applying}
            disabled={applying || total === 0}
            onClick={onConfirm}
          >
            {applying ? '正在写入…' : `确认写入 ${formatCount(total)} 处`}
          </Button>
        </>
      }
    >
      <div className="apply-grid">
        <div className="apply-total">
          <span className="apply-total-value mono">{formatCount(total)}</span>
          <span className="apply-total-label">处替换</span>
          <span className="apply-total-rule" aria-hidden="true" />
          <span className="apply-total-value mono">{formatCount(files.length)}</span>
          <span className="apply-total-label">个文件</span>
        </div>

        <div className="apply-block">
          <p className="apply-block-title">将写入的文件</p>
          <ul className="apply-file-list">
            {files.map((file) => (
              <li key={file.filePath}>
                <code className="mono" title={file.filePath}>
                  {file.filePath}
                </code>
                <span className="apply-file-count mono">{file.count} 处</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="apply-block">
          <p className="apply-block-title">自动备份位置</p>
          <code className="apply-backup mono" title={projectRoot}>
            {projectRoot}\.pathkeeper-backup\&lt;时间戳目录&gt;\
          </code>
          <p className="apply-hint">
            写入前会先复制原始文件并写入清单。之后可在「迁移历史」中回滚，或在「设置中心 → 备份管理」中删除备份。
          </p>
        </div>

        {scan && scan.pathInfo.warnings.length > 0 ? (
          <Notice tone="warn" compact title="来自路径预览的提醒">
            <ul className="notice-list">
              {scan.pathInfo.warnings.map((warning) => (
                <li key={warning}>
                  <TriangleAlert size={12} aria-hidden="true" /> {warning}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <Notice tone="danger" compact icon={<ShieldAlert size={15} />} title="确认后将直接写入磁盘">
          写入前会自动创建备份，但写入本身无法撤销。如果扫描后文件被其他程序修改，PathKeeper
          会整体中止本次写入，不会覆盖较新的内容。
        </Notice>

        {error ? <InlineError message={error} /> : null}
      </div>
    </Modal>
  )
}
