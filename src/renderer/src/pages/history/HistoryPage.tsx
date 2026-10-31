import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { MigrationRecord, Project, RollbackResult } from '@shared/types'
import {
  ArrowRight,
  ChevronRight,
  FolderOpen,
  RefreshCw,
  Trash2,
  Undo2
} from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { useConfirm } from '@renderer/components/Confirm'
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  InlineError,
  Notice,
  Spinner,
  type ChipTone
} from '@renderer/components/ui'
import { describeError, type ErrorDescription } from '@renderer/lib/errors'
import { formatCount, formatDateTime } from '@renderer/lib/format'
import { matchModeLabel, pathKindLabel, statusLabel } from '@renderer/lib/labels'
import type { PageId } from '@renderer/app-types'

const STATUS_TONES: Record<MigrationRecord['status'], ChipTone> = {
  applied: 'mint',
  rolled_back: 'muted',
  failed: 'red',
  pending: 'brass'
}

function backupState(record: MigrationRecord): {
  label: string
  tone: ChipTone
  available: boolean
} {
  if (record.backupId === null) {
    return { label: '无备份', tone: 'muted', available: false }
  }
  if (record.backupMissing) {
    return { label: '备份缺失', tone: 'red', available: false }
  }
  if (record.backupRemoved) {
    return { label: '备份已删除', tone: 'muted', available: false }
  }
  return { label: '备份可用', tone: 'mint', available: true }
}

function rollbackBlocker(record: MigrationRecord): string | null {
  if (record.status !== 'applied') {
    return record.status === 'rolled_back' ? '该迁移已经回滚过。' : '只有已应用的迁移可以回滚。'
  }
  if (record.backupId === null) return '这条迁移没有可用备份，无法回滚。'
  if (record.backupMissing) return '备份文件在磁盘上已缺失，无法回滚。'
  if (record.backupRemoved) return '备份已被删除，无法回滚。'
  return null
}

export interface HistoryPageProps {
  project: Project
  beginnerMode: boolean
  onRescan: (record: MigrationRecord) => void
  onNavigate: (page: PageId) => void
}

export function HistoryPage({
  project,
  beginnerMode,
  onRescan,
  onNavigate
}: HistoryPageProps): ReactNode {
  const api = useApi()
  const toast = useToast()
  const confirm = useConfirm()

  const [records, setRecords] = useState<MigrationRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<number, ErrorDescription>>({})
  const [rollbackSuccess, setRollbackSuccess] = useState<RollbackResult | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api.history
      .list(project.id)
      .then((list) => {
        if (cancelled) return
        const sorted = [...list].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        setRecords(sorted)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(describeError(error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, project.id, reloadNonce])

  const reload = useCallback((): void => {
    setReloadNonce((value) => value + 1)
  }, [])

  const revealBackup = useCallback(
    (record: MigrationRecord): void => {
      if (record.backupId === null) return
      void api.backups.reveal(record.backupId).catch((error: unknown) => {
        toast.error('无法打开备份目录', describeError(error).message)
      })
    },
    [api, toast]
  )

  const handleRollback = useCallback(
    async (record: MigrationRecord): Promise<void> => {
      const blocker = rollbackBlocker(record)
      if (blocker) {
        toast.error('无法回滚', blocker)
        return
      }
      const accepted = await confirm({
        title: '回滚这次迁移？',
        description: (
          <>
            将用备份恢复迁移 #{record.id} 涉及的文件，并把记录标记为「已回滚」。
            <strong>磁盘上的文件会被改写回迁移前的状态。</strong>
          </>
        ),
        details: (
          <>
            <dl className="detail-list">
              <div>
                <dt>迁移路线</dt>
                <dd className="mono">
                  {record.oldPath} → {record.newPath}
                </dd>
              </div>
              <div>
                <dt>涉及文件</dt>
                <dd>
                  {formatCount(record.filesChanged)} 个文件 · {formatCount(record.replacements)} 处替换
                </dd>
              </div>
              <div>
                <dt>备份目录</dt>
                <dd className="mono">{record.backupDir ?? '未记录'}</dd>
              </div>
            </dl>
            <p className="confirm-note">
              如果迁移之后文件又被其他程序修改，PathKeeper 会拒绝回滚，并保持磁盘文件不变。
            </p>
          </>
        ),
        confirmLabel: '用备份回滚',
        cancelLabel: '保留现状',
        tone: 'danger',
        testId: 'confirm-dialog',
        confirmTestId: 'confirm-rollback'
      })
      if (!accepted) return
      setBusyId(record.id)
      setActionErrors((current) => {
        const next = { ...current }
        delete next[record.id]
        return next
      })
      try {
        const result = await api.history.rollback(record.id)
        setRollbackSuccess(result)
        toast.success('回滚完成', `已恢复 ${result.filesRestored} 个文件。`)
        reload()
      } catch (error) {
        const described = describeError(error)
        setActionErrors((current) => ({ ...current, [record.id]: described }))
        toast.error('回滚失败，文件未被改写', described.message)
      } finally {
        setBusyId(null)
      }
    },
    [api, confirm, reload, toast]
  )

  const handleDelete = useCallback(
    async (record: MigrationRecord): Promise<void> => {
      const accepted = await confirm({
        title: '删除这条迁移记录？',
        description: '记录会从迁移历史中移除。这个操作不会删除磁盘上的备份文件。',
        details: (
          <dl className="detail-list">
            <div>
              <dt>迁移</dt>
              <dd className="mono">
                {record.oldPath} → {record.newPath}
              </dd>
            </div>
            <div>
              <dt>备份</dt>
              <dd>
                {record.backupId === null
                  ? '这条记录没有备份。'
                  : '备份文件仍保留在 .pathkeeper-backup/ 中，但这条记录之后无法再用于回滚；可在「设置中心 → 备份管理」中删除备份。'}
              </dd>
            </div>
          </dl>
        ),
        confirmLabel: '删除记录',
        tone: 'danger',
        testId: 'confirm-dialog',
        confirmTestId: 'confirm-delete-history'
      })
      if (!accepted) return
      setBusyId(record.id)
      try {
        await api.history.remove(record.id)
        toast.success('迁移记录已删除', '磁盘上的文件与备份均未改动。')
        reload()
      } catch (error) {
        const described = describeError(error)
        setActionErrors((current) => ({ ...current, [record.id]: described }))
        toast.error('删除记录失败', described.message)
      } finally {
        setBusyId(null)
      }
    },
    [api, confirm, reload, toast]
  )

  const toggleExpanded = (id: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const totalRecords = records?.length ?? 0

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head-main">
          <p className="page-kicker mono">项目 {String(project.id).padStart(2, '0')} · 只读记录</p>
          <h1 className="page-title">{beginnerMode ? '修改记录' : '迁移历史'}</h1>
          <p className="page-lede">
            {beginnerMode
              ? '每次修复都会留下一条记录和对应备份。如果不满意，可以一键回到修复前。'
              : '每次写入都会生成一条记录和对应备份。可以回滚到迁移前状态，或删除不再需要的记录。'}
          </p>
        </div>
        <div className="page-head-meta">
          <span className="page-meta-label">项目</span>
          <code className="page-meta-path mono" title={project.rootPath}>
            {project.name}
          </code>
          <Button
            variant="default"
            size="sm"
            icon={<RefreshCw size={14} />}
            loading={loading}
            onClick={reload}
          >
            刷新记录
          </Button>
        </div>
      </header>

      {rollbackSuccess ? (
        <Notice
          tone="success"
          title="回滚完成"
          testId="rollback-success"
          actions={
            <Button variant="ghost" size="sm" onClick={() => setRollbackSuccess(null)}>
              知道了
            </Button>
          }
        >
          迁移 #{rollbackSuccess.migrationId} 已回滚，恢复 {formatCount(rollbackSuccess.filesRestored)} 个文件。
          备份目录：
          <code className="mono inline-code">{rollbackSuccess.backupDir}</code>
        </Notice>
      ) : null}

      {loading && records === null ? (
        <div className="page-state" role="status">
          <Spinner label="正在读取迁移记录…" />
        </div>
      ) : loadError ? (
        <Notice
          tone="danger"
          title="无法读取迁移历史"
          actions={
            <Button variant="default" size="sm" onClick={reload}>
              重试
            </Button>
          }
        >
          {loadError}
        </Notice>
      ) : totalRecords === 0 ? (
        <EmptyState
          motif="ledger"
          title="还没有迁移记录"
          description="应用一次路径迁移后，这里会按时间倒序列出记录、备份状态和可执行的回滚操作。"
          actions={
            <>
              <Button variant="primary" onClick={() => onNavigate('migration')}>
                前往路径迁移
              </Button>
              <Button variant="ghost" onClick={() => onNavigate('settings')}>
                管理备份
              </Button>
            </>
          }
        />
      ) : (
        <section className="history" aria-label="迁移记录列表">
          <div className="history-head">
            <span className="plate-kicker mono">迁移记录</span>
            <span className="history-count mono">{formatCount(totalRecords)} 条</span>
          </div>
          <ol className="history-list">
            {(records ?? []).map((record) => {
              const backup = backupState(record)
              const blocker = rollbackBlocker(record)
              const busy = busyId === record.id
              const actionError = actionErrors[record.id]
              const isExpanded = expanded.has(record.id)
              return (
                <li key={record.id} className="history-row" data-testid="history-row" data-status={record.status}>
                  <div className="history-main">
                    <div className="history-stamp">
                      <span className="history-id mono">#{String(record.id).padStart(3, '0')}</span>
                      <Chip tone={STATUS_TONES[record.status]}>{statusLabel(record.status)}</Chip>
                      <Chip tone="muted" mono>
                        {pathKindLabel(record.kind)}
                      </Chip>
                    </div>
                    <div className="history-route">
                      <code className="history-old mono" title={record.oldPath}>
                        {record.oldPath}
                      </code>
                      <ArrowRight size={14} className="history-arrow" aria-hidden="true" />
                      <code className="history-new mono" title={record.newPath}>
                        {record.newPath}
                      </code>
                    </div>
                    <div className="history-meta">
                      <span>{formatDateTime(record.createdAt)}</span>
                      <span className="history-meta-sep" aria-hidden="true" />
                      <span>{formatCount(record.filesChanged)} 个文件</span>
                      <span>{formatCount(record.replacements)} 处替换</span>
                      <span className="history-meta-sep" aria-hidden="true" />
                      <Chip tone={backup.tone}>{backup.label}</Chip>
                      <span className="history-modes mono">
                        {(['strict', 'basename', 'directory'] as const)
                          .filter((mode) => record.modes[mode])
                          .map((mode) => matchModeLabel(mode))
                          .join(' · ') || '无匹配范围'}
                      </span>
                      {record.rolledBackAt ? (
                        <span className="history-rolledback">回滚于 {formatDateTime(record.rolledBackAt)}</span>
                      ) : null}
                    </div>
                    {record.error ? <p className="history-error-text">{record.error}</p> : null}
                    {actionError ? (
                      <InlineError
                        message={actionError.message}
                        code={actionError.code}
                        detail={actionError.raw}
                      />
                    ) : null}
                  </div>

                  <div className="history-actions">
                    {backup.available ? (
                      <IconButton
                        label="打开备份文件夹"
                        onClick={() => revealBackup(record)}
                      >
                        <FolderOpen size={14} />
                      </IconButton>
                    ) : null}
                    <Button
                      variant="default"
                      size="sm"
                      icon={<RefreshCw size={13} />}
                      onClick={() => onRescan(record)}
                      style={beginnerMode ? { display: 'none' } : undefined}
                    >
                      重新扫描
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      icon={<Undo2 size={13} />}
                      data-testid="rollback-button"
                      loading={busy && record.status === 'applied'}
                      disabled={blocker !== null || busy}
                      title={blocker ?? '用备份恢复迁移前的文件'}
                      onClick={() => void handleRollback(record)}
                    >
                      回滚
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={13} />}
                      disabled={busy}
                      onClick={() => void handleDelete(record)}
                    >
                      删除
                    </Button>
                    {record.files.length > 0 ? (
                      <button
                        type="button"
                        className="history-expand"
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpanded(record.id)}
                      >
                        <ChevronRight
                          size={13}
                          className={isExpanded ? 'history-expand-icon is-open' : 'history-expand-icon'}
                          aria-hidden="true"
                        />
                        {formatCount(record.files.length)} 个文件
                      </button>
                    ) : null}
                  </div>

                  {isExpanded && record.files.length > 0 ? (
                    <div className="history-files">
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th scope="col">文件</th>
                            <th scope="col">替换</th>
                            <th scope="col">备份文件</th>
                          </tr>
                        </thead>
                        <tbody>
                          {record.files.map((file) => (
                            <tr key={file.id}>
                              <td>
                                <code className="mono">{file.filePath}</code>
                              </td>
                              <td className="mini-table-num">{file.replacements} 处</td>
                              <td>
                                <code className="mono mini-table-path" title={file.backupPath}>
                                  {file.backupPath}
                                </code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
          <p className="history-foot">
            回滚依赖磁盘上的备份文件。删除备份后，对应记录将无法回滚。
          </p>
        </section>
      )}
    </div>
  )
}
