import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { IgnoreKind, IgnoreRule, Project } from '@shared/types'
import { Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { useConfirm } from '@renderer/components/Confirm'
import {
  Button,
  Field,
  IconButton,
  InlineError,
  Spinner,
  Toggle
} from '@renderer/components/ui'
import { describeError } from '@renderer/lib/errors'
import { formatCount } from '@renderer/lib/format'
import { ignoreKindLabel } from '@renderer/lib/labels'
import { cx } from '@renderer/lib/cx'

const IGNORE_KINDS: ReadonlyArray<{ value: IgnoreKind; label: string; hint: string }> = [
  {
    value: 'dir',
    label: '目录',
    hint: '填写目录名即可，任意层级中同名目录都会被跳过。例如 logs'
  },
  {
    value: 'suffix',
    label: '后缀',
    hint: '需要以点开头。例如 .log 会跳过所有 .log 文件。'
  },
  {
    value: 'glob',
    label: '通配',
    hint: '支持 * 和 ?。例如 *.min.js 会跳过所有压缩后的脚本。'
  }
]

const BUILTIN_GROUPS: ReadonlyArray<{ kind: IgnoreKind; label: string }> = [
  { kind: 'dir', label: '目录名称' },
  { kind: 'suffix', label: '文件后缀' },
  { kind: 'glob', label: '通配模式' }
]

export function IgnoreSection({ project }: { project: Project }): ReactNode {
  const api = useApi()
  const toast = useToast()
  const confirm = useConfirm()

  const [rules, setRules] = useState<IgnoreRule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [search, setSearch] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [resetBusy, setResetBusy] = useState(false)

  const [kind, setKind] = useState<IgnoreKind>('dir')
  const [pattern, setPattern] = useState('')
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api.ignores
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
    return list.filter(
      (rule) => rule.pattern.toLowerCase().includes(query) || rule.label.toLowerCase().includes(query)
    )
  }, [rules, search])

  const builtinRules = useMemo(() => filtered.filter((rule) => rule.builtin), [filtered])
  const customRules = useMemo(() => filtered.filter((rule) => !rule.builtin), [filtered])
  const allBuiltins = (rules ?? []).filter((rule) => rule.builtin)
  const enabledBuiltins = allBuiltins.filter((rule) => rule.enabled).length

  const toggleRule = async (rule: IgnoreRule, enabled: boolean): Promise<void> => {
    setTogglingId(rule.id)
    setRules((current) =>
      current ? current.map((item) => (item.id === rule.id ? { ...item, enabled } : item)) : current
    )
    try {
      const updated = await api.ignores.update(rule.id, { enabled })
      setRules((current) =>
        current ? current.map((item) => (item.id === updated.id ? updated : item)) : current
      )
    } catch (error) {
      setRules((current) =>
        current
          ? current.map((item) => (item.id === rule.id ? { ...item, enabled: !enabled } : item))
          : current
      )
      toast.error('无法更新忽略规则', describeError(error).message)
    } finally {
      setTogglingId(null)
    }
  }

  const handleAdd = async (): Promise<void> => {
    const value = pattern.trim()
    if (!value) {
      setAddError('请输入规则内容。')
      return
    }
    if (kind === 'suffix' && !value.startsWith('.')) {
      setAddError('后缀规则需要以点开头，例如 .log。')
      return
    }
    if (kind === 'glob' && !/[?*]/.test(value)) {
      setAddError('通配规则至少需要一个 * 或 ?。')
      return
    }
    if (kind === 'dir' && /[\\/]/.test(value)) {
      setAddError('目录规则只需填写单个目录名，不用路径分隔符。')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const created = await api.ignores.add(project.id, {
        pattern: value,
        kind,
        label: label.trim().length > 0 ? label.trim() : value,
        enabled: true
      })
      setRules((current) => (current ? [...current, created] : [created]))
      setPattern('')
      setLabel('')
      toast.success('已添加自定义忽略规则', created.pattern)
    } catch (error) {
      const described = describeError(error)
      setAddError(described.message)
      toast.error('无法添加忽略规则', described.message)
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (rule: IgnoreRule): Promise<void> => {
    const accepted = await confirm({
      title: '删除自定义忽略规则？',
      description: `将删除规则「${rule.label}（${rule.pattern}）」。之后的扫描会重新包含匹配它的文件。`,
      confirmLabel: '删除规则',
      tone: 'danger',
      testId: 'confirm-dialog',
      confirmTestId: 'confirm-delete-ignore'
    })
    if (!accepted) return
    try {
      await api.ignores.remove(rule.id)
      setRules((current) => (current ? current.filter((item) => item.id !== rule.id) : current))
      toast.success('忽略规则已删除', rule.pattern)
    } catch (error) {
      toast.error('删除忽略规则失败', describeError(error).message)
    }
  }

  const handleReset = async (): Promise<void> => {
    const accepted = await confirm({
      title: '恢复默认忽略规则？',
      description: '内置忽略规则会恢复为默认内容并重新启用；你添加的自定义规则不会被删除。',
      confirmLabel: '恢复内置规则',
      testId: 'confirm-dialog',
      confirmTestId: 'confirm-reset-ignores'
    })
    if (!accepted) return
    setResetBusy(true)
    try {
      const next = await api.ignores.reset(project.id)
      setRules(next)
      toast.success('内置忽略规则已恢复默认')
    } catch (error) {
      toast.error('恢复忽略规则失败', describeError(error).message)
    } finally {
      setResetBusy(false)
    }
  }

  const activeKindHint = IGNORE_KINDS.find((item) => item.value === kind)?.hint ?? ''

  return (
    <section className="settings-panel" aria-labelledby="settings-ignores-title">
      <header className="settings-panel-head">
        <div>
          <p className="plate-kicker mono">设置 / 忽略规则</p>
          <h2 className="settings-panel-title" id="settings-ignores-title">
            跳过不需要扫描的文件
          </h2>
          <p className="settings-panel-desc">
            目录、后缀与通配规则会在遍历阶段生效，被忽略的路径不会读取、也不会出现在结果里。
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          icon={<RotateCcw size={13} />}
          loading={resetBusy}
          onClick={() => void handleReset()}
        >
          恢复内置默认
        </Button>
      </header>

      <div className="settings-body">
        <div className="settings-toolbar">
          <span className="settings-count mono">
            内置 {formatCount(allBuiltins.length)} 条 · 启用 {formatCount(enabledBuiltins)} 条 · 自定义{' '}
            {formatCount((rules ?? []).filter((rule) => !rule.builtin).length)} 条
          </span>
          <div className="ledger-search settings-search">
            <Search size={14} className="ledger-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="input input-search"
              placeholder="搜索忽略规则…"
              value={search}
              aria-label="搜索忽略规则"
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
            <Spinner label="正在读取忽略规则…" />
          </div>
        ) : loadError ? (
          <InlineError message={loadError} />
        ) : (
          <>
            {BUILTIN_GROUPS.map((group) => {
              const groupRules = builtinRules.filter((rule) => rule.kind === group.kind)
              const enabledCount = groupRules.filter((rule) => rule.enabled).length
              return (
                <section className="ignore-group" key={group.kind} aria-label={`内置${group.label}`}>
                  <div className="ignore-group-head">
                    <h3 className="settings-block-title">{group.label}</h3>
                    <span className="ignore-group-count mono">
                      {enabledCount} / {groupRules.length} 启用
                    </span>
                  </div>
                  {groupRules.length === 0 ? (
                    <p className="settings-empty">没有匹配的内置规则。</p>
                  ) : (
                    <div className="ignore-grid">
                      {groupRules.map((rule) => (
                        <div
                          className={cx('ignore-item', !rule.enabled && 'is-off')}
                          key={rule.id}
                        >
                          <div className="ignore-copy">
                            <span className="ignore-label">{rule.label}</span>
                            <code className="ignore-pattern mono" title={rule.pattern}>
                              {rule.pattern}
                            </code>
                          </div>
                          <Toggle
                            checked={rule.enabled}
                            disabled={togglingId === rule.id}
                            label={`${rule.enabled ? '停用' : '启用'}内置忽略：${rule.label}`}
                            onChange={(checked) => void toggleRule(rule, checked)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}

            {customRules.length > 0 ? (
              <section className="ignore-group" aria-label="自定义忽略规则">
                <div className="ignore-group-head">
                  <h3 className="settings-block-title">自定义规则</h3>
                  <span className="ignore-group-count mono">{customRules.length} 条</span>
                </div>
                <div className="ignore-custom-list">
                  {customRules.map((rule) => (
                    <div className={cx('ignore-item', !rule.enabled && 'is-off')} key={rule.id}>
                      <div className="ignore-copy">
                        <span className="ignore-label">{rule.label}</span>
                        <code className="ignore-pattern mono" title={rule.pattern}>
                          {rule.pattern}
                        </code>
                      </div>
                      <span className="ignore-kind-tag mono">{ignoreKindLabel(rule.kind)}</span>
                      <Toggle
                        checked={rule.enabled}
                        label={`${rule.enabled ? '停用' : '启用'}自定义忽略：${rule.label}`}
                        onChange={(checked) => void toggleRule(rule, checked)}
                      />
                      <IconButton
                        label={`删除忽略规则 ${rule.pattern}`}
                        tone="danger"
                        onClick={() => void handleDelete(rule)}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {filtered.length === 0 && search ? <p className="settings-empty">没有匹配的规则。</p> : null}

            <section className="settings-block ignore-add" aria-label="添加自定义忽略规则">
              <p className="settings-block-title">添加自定义忽略规则</p>
              <div className="ignore-add-grid">
                <Field label="类型" htmlFor="ignore-kind">
                  <select
                    id="ignore-kind"
                    className="select"
                    value={kind}
                    onChange={(event) => {
                      setKind(event.target.value as IgnoreKind)
                      setAddError(null)
                    }}
                  >
                    {IGNORE_KINDS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="规则内容" htmlFor="ignore-pattern">
                  <input
                    id="ignore-pattern"
                    className="input input-mono"
                    value={pattern}
                    placeholder={kind === 'suffix' ? '.log' : kind === 'glob' ? '*.min.js' : 'logs'}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setPattern(event.target.value)
                      setAddError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleAdd()
                    }}
                  />
                </Field>
                <Field label="说明" htmlFor="ignore-label" optional>
                  <input
                    id="ignore-label"
                    className="input"
                    value={label}
                    placeholder="例如 日志目录"
                    maxLength={80}
                    autoComplete="off"
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </Field>
                <Button
                  variant="primary"
                  icon={<Plus size={14} />}
                  loading={adding}
                  disabled={pattern.trim().length === 0}
                  onClick={() => void handleAdd()}
                >
                  添加规则
                </Button>
              </div>
              <p className="field-hint">{activeKindHint}</p>
              {addError ? (
                <p className="field-error" role="alert">
                  {addError}
                </p>
              ) : null}
            </section>
          </>
        )}
      </div>
    </section>
  )
}
