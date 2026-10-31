import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { BackupRecord, Project } from '@shared/types'
import { FolderOpen, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { useConfirm } from '@renderer/components/Confirm'
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  InlineError,
  Spinner,
  Stat,
  type ChipTone
} from '@renderer/components/ui'
import { describeError } from '@renderer/lib/errors'
import { formatBytes, formatCount, formatDateTime } from '@renderer/lib/format'

function backupStatus(backup: BackupRecord): { label: string; tone: ChipTone } {
  if (backup.missing) return { label: '目录缺失', tone: 'red' }
  if (backup.orphaned) return { label: '孤立备份', tone: 'brass' }
  return { label: '可用', tone: 'mint' }
}

export function BackupsSection({ project }: { project: Project }): ReactNode {
  const api = useApi()
  const toast = useToast()
  const confirm = useConfirm()

  const [backups, setBackups] = useState<BackupRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api.backups
      .list(project.id)
      .then((list) => {
        if (!cancelled) setBackups(list)
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

  const reload = useCallback((): void => setReloadNonce((value) => value + 1), [])

  const revealBackup = (backup: BackupRecord): void => {
    void api.backups.reveal(backup.id).catch((error: unknown) => {
      toast.error('无法打开备份目录', describeError(error).message)
    })
  }

  const handleDelete = async (backup: BackupRecord): Promise<void> => {
    const accepted = await confirm({
      title: '删除这个备份？',
      description:
        '备份从磁盘删除后，对应的迁移记录将无法回滚。这个操作不可撤销。',
      details: (
        <dl className="detail-list">
          <div>
            <dt>备份目录</dt>
            <dd className="mono">{backup.absPath}</dd>
          </div>
          <div>
            <dt>内容</dt>
            <dd>
              {formatCount(backup.filesCount)} 个文件 · {formatBytes(backup.sizeBytes)}
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatDateTime(backup.createdAt)}</dd>
          </div>
        </dl>
      ),
      confirmLabel: '删除备份',
      tone: 'danger',
      testId: 'confirm-dialog',
      confirmTestId: 'confirm-delete-backup'
    })
    if (!accepted) return
    setBusyId(backup.id)
    try {
      await api.backups.remove(backup.id)
      setBackups((current) => (current ? current.filter((item) => item.id !== backup.id) : current))
      toast.success('备份已删除', backup.dirName)
    } catch (error) {
      toast.error('删除备份失败', describeError(error).message)
    } finally {
      setBusyId(null)
    }
  }

  const list = backups ?? []
  const totalSize = list.reduce((sum, backup) => sum + (backup.missing ? 0 : backup.sizeBytes), 0)
  const missingCount = list.filter((backup) => backup.missing).length

  return (
    <section className="settings-panel" aria-labelledby="settings-backups-title">
      <header className="settings-panel-head">
        <div>
          <p className="plate-kicker mono">设置 / 备份管理</p>
          <h2 className="settings-panel-title" id="settings-backups-title">
            本地备份
          </h2>
          <p className="settings-panel-desc">
            每次写入前，PathKeeper 会把受影响的原文件复制到项目根目录的 .pathkeeper-backup/
            下，并写入清单。
          </p>
        </div>
        <Button variant="default" size="sm" icon={<RefreshCw size={13} />} loading={loading} onClick={reload}>
          刷新
        </Button>
      </header>

      <div className="settings-body">
        <div className="backup-summary">
          <Stat value={formatCount(list.length)} label="份备份" />
          <Stat value={formatBytes(totalSize)} label="占用磁盘" />
          <Stat value={formatCount(missingCount)} label="目录缺失" tone={missingCount > 0 ? 'red' : 'muted'} />
          <span className="backup-summary-note">
            <HardDrive size={14} aria-hidden="true" />
            备份不会自动清理。需要空间时请手动删除；删除后相关迁移无法回滚。
          </span>
        </div>

        {loading && backups === null ? (
          <div className="page-state" role="status">
            <Spinner label="正在读取备份列表…" />
          </div>
        ) : loadError ? (
          <div>
            <InlineError message={loadError} />
            <div className="settings-inline-retry">
              <Button variant="default" size="sm" onClick={reload}>
                重试
              </Button>
            </div>
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            motif="backup"
            title="还没有备份"
            description="应用一次路径迁移后，原始文件会自动备份到这里。扫描和回滚都不会自动创建备份。"
          />
        ) : (
          <div className="table-wrap">
            <table className="backups-table">
              <caption className="sr-only">项目备份列表</caption>
              <colgroup>
                <col className="col-backup-name" />
                <col className="col-backup-date" />
                <col className="col-backup-count" />
                <col className="col-backup-size" />
                <col className="col-backup-status" />
                <col className="col-backup-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">备份目录</th>
                  <th scope="col">创建时间</th>
                  <th scope="col">文件数</th>
                  <th scope="col">大小</th>
                  <th scope="col">状态</th>
                  <th scope="col">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((backup) => {
                  const status = backupStatus(backup)
                  return (
                    <tr key={backup.id} className={backup.missing ? 'is-missing' : undefined}>
                      <td>
                        <div className="backup-name">
                          <code className="mono">{backup.dirName}</code>
                          <span className="backup-path mono" title={backup.absPath}>
                            {backup.absPath}
                          </span>
                          {backup.orphaned ? (
                            <span className="backup-orphan-note">原迁移记录已删除</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="nowrap">{formatDateTime(backup.createdAt)}</td>
                      <td className="num">{formatCount(backup.filesCount)}</td>
                      <td className="num">{backup.missing ? '—' : formatBytes(backup.sizeBytes)}</td>
                      <td>
                        <Chip tone={status.tone}>{status.label}</Chip>
                      </td>
                      <td>
                        <div className="row-actions">
                          <IconButton
                            label={backup.missing ? '备份目录缺失，无法打开' : '打开备份文件夹'}
                            disabled={backup.missing}
                            onClick={() => revealBackup(backup)}
                          >
                            <FolderOpen size={14} />
                          </IconButton>
                          <IconButton
                            label={`删除备份 ${backup.dirName}`}
                            tone="danger"
                            disabled={busyId === backup.id}
                            onClick={() => void handleDelete(backup)}
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
