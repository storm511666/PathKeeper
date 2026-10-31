import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MatchRule, Project } from '@shared/types'
import { Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { useConfirm } from '@renderer/components/Confirm'
import {
  Button,
  Chip,
  InlineError,
  Spinner,
  Toggle
} from '@renderer/components/ui'
import { describeError } from '@renderer/lib/errors'
import { formatCount } from '@renderer/lib/format'
import { categoryLabel } from '@renderer/lib/labels'
import { cx } from '@renderer/lib/cx'
import { RuleEditor } from './RuleEditor'

export function RulesSection({ project }: { project: Project }): ReactNode {
  const api = useApi()
  const toast = useToast()
  const confirm = useConfirm()

  const [rules, setRules] = useState<MatchRule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [search, setSearch] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<MatchRule | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api.rules
      .list(project.id)
      .then((list) => {
        if (!cancelled) setRules(list)
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

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    const list = rules ?? []
    if (!query) return list
    return list.filter((rule) =>
      [rule.name, rule.description, rule.pattern, rule.ruleKey].some((value) =>
        value.toLowerCase().includes(query)
      )
    )
  }, [rules, search])

  const builtins = useMemo(() => filtered.filter((rule) => rule.builtin), [filtered])
  const customs = useMemo(() => filtered.filter((rule) => !rule.builtin), [filtered])
  const allRules = rules ?? []
  const enabledCount = allRules.filter((rule) => rule.enabled).length

  const toggleRule = async (rule: MatchRule, enabled: boolean): Promise<void> => {
    setTogglingId(rule.id)
    setRules((current) =>
      current ? current.map((item) => (item.id === rule.id ? { ...item, enabled } : item)) : current
    )
    try {
      const updated = await api.rules.update(rule.id, { enabled })
      setRules((current) =>
        current ? current.map((item) => (item.id === updated.id ? updated : item)) : current
      )
    } catch (error) {
      setRules((current) =>
        current
          ? current.map((item) => (item.id === rule.id ? { ...item, enabled: !enabled } : item))
          : current
      )
      toast.error('无法更新匹配规则', describeError(error).message)
    } finally {
      setTogglingId(null)
    }
  }

  const handleSaved = (saved: MatchRule): void => {
    setRules((current) => {
      if (!current) return [saved]
      const exists = current.some((rule) => rule.id === saved.id)
      return exists ? current.map((rule) => (rule.id === saved.id ? saved : rule)) : [...current, saved]
    })
  }

  const openCreate = (): void => {
    setEditingRule(null)
    setEditorOpen(true)
  }

  const openEdit = (rule: MatchRule): void => {
    setEditingRule(rule)
    setEditorOpen(true)
  }

  const handleDelete = async (rule: MatchRule): Promise<void> => {
    const accepted = await confirm({
      title: '删除自定义匹配规则？',
      description: `将删除规则「${rule.name}」。删除后扫描不再使用这条规则，已写入的文件不受影响。`,
      details: <code className="mono confirm-code">{rule.pattern}</code>,
      confirmLabel: '删除规则',
      tone: 'danger',
      testId: 'confirm-dialog',
      confirmTestId: 'confirm-delete-rule'
    })
    if (!accepted) return
    try {
      await api.rules.remove(rule.id)
      setRules((current) => (current ? current.filter((item) => item.id !== rule.id) : current))
      toast.success('匹配规则已删除', rule.name)
    } catch (error) {
      toast.error('删除匹配规则失败', describeError(error).message)
    }
  }

  const handleReset = async (): Promise<void> => {
    const accepted = await confirm({
      title: '恢复内置匹配规则？',
      description: '内置规则会恢复为默认正则并重新启用；你添加的自定义规则不会被删除。',
      confirmLabel: '恢复内置规则',
      testId: 'confirm-dialog',
      confirmTestId: 'confirm-reset-rules'
    })
    if (!accepted) return
    setResetBusy(true)
    try {
      const next = await api.rules.reset(project.id)
      setRules(next)
      toast.success('内置匹配规则已恢复默认')
    } catch (error) {
      toast.error('恢复内置规则失败', describeError(error).message)
    } finally {
      setResetBusy(false)
    }
  }

  const renderTable = (list: MatchRule[], kind: 'builtin' | 'custom'): ReactNode => (
    <div className="table-wrap rules-table-wrap">
      <table className="rules-table">
        <caption className="sr-only">
          {kind === 'builtin' ? '内置匹配规则' : '自定义匹配规则'}
        </caption>
        <colgroup>
          <col className="col-rule-enabled" />
          <col className="col-rule-name" />
          <col className="col-rule-category" />
          <col className="col-rule-pattern" />
          <col className="col-rule-flags" />
          <col className="col-rule-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">启用</th>
            <th scope="col">规则</th>
            <th scope="col">分类</th>
            <th scope="col">正则表达式</th>
            <th scope="col">Flags</th>
            <th scope="col">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((rule) => (
            <tr key={rule.id} className={cx('rule-row', !rule.enabled && 'is-off')}>
              <td>
                <Toggle
                  checked={rule.enabled}
                  disabled={togglingId === rule.id}
                  label={`${rule.enabled ? '停用' : '启用'}规则：${rule.name}`}
                  onChange={(checked) => void toggleRule(rule, checked)}
                />
              </td>
              <td>
                <span className="rule-name">{rule.name}</span>
                {rule.description ? (
                  <span className="rule-description" title={rule.description}>
                    {rule.description}
                  </span>
                ) : null}
              </td>
              <td>
                <Chip tone="muted" mono>
                  {categoryLabel(rule.category)}
                </Chip>
              </td>
              <td>
                <code className="rule-pattern mono" title={rule.pattern}>
                  {rule.pattern}
                </code>
              </td>
              <td>
                <code className="rule-flags mono">{rule.flags}</code>
              </td>
              <td className="col-rule-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={13} />}
                  onClick={() => openEdit(rule)}
                >
                  编辑
                </Button>
                {kind === 'custom' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={() => void handleDelete(rule)}
                    aria-label={`删除规则 ${rule.name}`}
                  >
                    删除
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <section className="settings-panel" aria-labelledby="settings-rules-title">
      <header className="settings-panel-head">
        <div>
          <p className="plate-kicker mono">设置 / 匹配规则</p>
          <h2 className="settings-panel-title" id="settings-rules-title">
            识别路径的正则规则
          </h2>
          <p className="settings-panel-desc">
            每条规则负责识别某类文件中「手写路径」的位置。只有命名捕获组 path 命中的文本会被替换。
          </p>
        </div>
        <div className="settings-head-actions">
          <Button variant="default" size="sm" icon={<RotateCcw size={13} />} loading={resetBusy} onClick={() => void handleReset()}>
            恢复内置
          </Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={openCreate}>
            新增自定义规则
          </Button>
        </div>
      </header>

      <div className="settings-body">
        <div className="settings-toolbar">
          <span className="settings-count mono">
            共 {formatCount(allRules.length)} 条 · 启用 {formatCount(enabledCount)} 条 · 内置{' '}
            {formatCount(allRules.filter((rule) => rule.builtin).length)} 条
          </span>
          <div className="ledger-search settings-search">
            <Search size={14} className="ledger-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="input input-search"
              placeholder="搜索规则名称、说明或正则…"
              value={search}
              aria-label="搜索匹配规则"
              onChange={(event) => setSearch(event.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="input-clear"
                aria-label="清除搜索"
                onClick={() => setSearch('')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {loading && rules === null ? (
          <div className="page-state" role="status">
            <Spinner label="正在读取匹配规则…" />
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
        ) : (
          <>
            <section aria-label="内置规则组">
              <div className="ignore-group-head">
                <h3 className="settings-block-title">内置规则</h3>
                <span className="ignore-group-count mono">{builtins.length} 条</span>
              </div>
              {builtins.length > 0 ? (
                renderTable(builtins, 'builtin')
              ) : (
                <p className="settings-empty">没有匹配的内置规则。</p>
              )}
            </section>

            <section aria-label="自定义规则组">
              <div className="ignore-group-head">
                <h3 className="settings-block-title">自定义规则</h3>
                <span className="ignore-group-count mono">{customs.length} 条</span>
              </div>
              {customs.length > 0 ? (
                renderTable(customs, 'custom')
              ) : (
                <p className="settings-empty">
                  还没有自定义规则。如果内置规则识别不到某类文件，可以新增一条。
                </p>
              )}
            </section>
          </>
        )}
      </div>

      <RuleEditor
        open={editorOpen}
        projectId={project.id}
        rule={editingRule}
        onClose={() => {
          setEditorOpen(false)
          setEditingRule(null)
        }}
        onSaved={handleSaved}
      />
    </section>
  )
}
