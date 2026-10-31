import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, MatchModes } from '@shared/types'
import { isValidMaxFileSizeKb, MAX_FILE_SIZE_KB_LIMIT } from '@shared/defaults'
import { Save, SlidersHorizontal } from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { describeError } from '@renderer/lib/errors'
import { formatFileSizeKb } from '@renderer/lib/format'
import { Button, Field, Notice, Toggle } from '@renderer/components/ui'

const MODE_ROWS: ReadonlyArray<{
  key: keyof MatchModes
  name: string
  description: string
}> = [
  { key: 'strict', name: '严格匹配', description: '解析后的完整项目相对路径与旧路径一致时才替换。' },
  { key: 'basename', name: '文件名匹配', description: '文件名一致但目录不同的引用也视作匹配，适合文件跨目录移动。' },
  {
    key: 'directory',
    name: '目录重映射',
    description: '目录迁移时，旧目录下所有引用整体映射到新目录；文件迁移时此模式不生效。'
  }
]

/** Above this size a text file is streamed and reported only (no auto fix). */
const REPORT_ONLY_FILE_SIZE_KB = 65_536

const MAX_FILE_SIZE_ERROR = `请输入 1 到 ${MAX_FILE_SIZE_KB_LIMIT.toLocaleString(
  'en-US'
)} 之间的整数（KB），即最大 ${formatFileSizeKb(MAX_FILE_SIZE_KB_LIMIT)}。`

export interface ScanSectionProps {
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

export function ScanSection({ settings, onSettingsChange }: ScanSectionProps): ReactNode {
  const api = useApi()
  const toast = useToast()
  const [modes, setModes] = useState<MatchModes>(settings.matchModes)
  const [caseSensitive, setCaseSensitive] = useState(settings.caseSensitive)
  const [maxSizeInput, setMaxSizeInput] = useState(String(settings.maxFileSizeKb))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setModes(settings.matchModes)
    setCaseSensitive(settings.caseSensitive)
    setMaxSizeInput(String(settings.maxFileSizeKb))
  }, [settings])

  const maxSize = Number.parseInt(maxSizeInput, 10)
  const sizeValid =
    /^\d+$/.test(maxSizeInput.trim()) && isValidMaxFileSizeKb(maxSize)
  const reportOnlyConfigured = sizeValid && maxSize > REPORT_ONLY_FILE_SIZE_KB
  const enabledModes = Number(modes.strict) + Number(modes.basename) + Number(modes.directory)
  const dirty =
    modes.strict !== settings.matchModes.strict ||
    modes.basename !== settings.matchModes.basename ||
    modes.directory !== settings.matchModes.directory ||
    caseSensitive !== settings.caseSensitive ||
    maxSize !== settings.maxFileSizeKb

  const handleSave = async (): Promise<void> => {
    if (enabledModes === 0) {
      setError('至少启用一种匹配范围，否则扫描不会得到任何结果。')
      return
    }
    if (!sizeValid) {
      setError(MAX_FILE_SIZE_ERROR)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const updated = await api.settings.update({
        matchModes: modes,
        caseSensitive,
        maxFileSizeKb: maxSize
      })
      onSettingsChange(updated)
      toast.success('扫描设置已保存')
    } catch (saveError) {
      const described = describeError(saveError)
      setError(described.message)
      toast.error('保存失败', described.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-scan-title">
      <header className="settings-panel-head">
        <div>
          <p className="plate-kicker mono">设置 / 路径匹配</p>
          <h2 className="settings-panel-title" id="settings-scan-title">
            扫描范围与匹配策略
          </h2>
          <p className="settings-panel-desc">
            这些选项会用于之后的每次扫描，也会成为路径迁移页匹配范围的默认值。
          </p>
        </div>
        <SlidersHorizontal size={18} className="settings-panel-icon" aria-hidden="true" />
      </header>

      <div className="settings-grid">
        <div className="settings-main">
          <div className="settings-block">
            <p className="settings-block-title">匹配范围</p>
            <div className="mode-list">
              {MODE_ROWS.map((row) => (
                <div className="mode-row" key={row.key}>
                  <div className="mode-copy">
                    <span className="mode-name">{row.name}</span>
                    <span className="mode-desc">{row.description}</span>
                  </div>
                  <Toggle
                    checked={modes[row.key]}
                    label={row.name}
                    disabled={saving}
                    onChange={(checked) => setModes((current) => ({ ...current, [row.key]: checked }))}
                  />
                </div>
              ))}
            </div>
            {enabledModes === 0 ? (
              <p className="field-error" role="alert">
                至少启用一种匹配范围。
              </p>
            ) : null}
          </div>

          <div className="settings-block">
            <p className="settings-block-title">大小写与文件大小</p>
            <div className="mode-row">
              <div className="mode-copy">
                <span className="mode-name">区分大小写</span>
                <span className="mode-desc">
                  关闭时，Windows 风格的不区分大小写匹配更安全；开启后只有完全一致的大小写才会替换。
                </span>
              </div>
              <Toggle
                checked={caseSensitive}
                label="路径匹配区分大小写"
                disabled={saving}
                onChange={setCaseSensitive}
              />
            </div>
            <Field
              label="单个文件大小上限"
              htmlFor="max-file-size"
              className="settings-size-field"
              hint={`当前相当于 ${formatFileSizeKb(
                sizeValid ? maxSize : settings.maxFileSizeKb
              )}，上限是 ${formatFileSizeKb(MAX_FILE_SIZE_KB_LIMIT)}（${MAX_FILE_SIZE_KB_LIMIT.toLocaleString(
                'en-US'
              )} KB）。1 GB 是上限，不是推荐值；超大文件扫描会明显变慢，可随时停止。超过上限的文件会被跳过，不加载进内存。`}
              error={sizeValid ? null : MAX_FILE_SIZE_ERROR}
            >
              <div className="input-suffix">
                <input
                  id="max-file-size"
                  className="input input-mono"
                  value={maxSizeInput}
                  inputMode="numeric"
                  autoComplete="off"
                  onChange={(event) => setMaxSizeInput(event.target.value)}
                />
                <span className="input-suffix-label mono">KB</span>
              </div>
            </Field>
            {reportOnlyConfigured ? (
              <p className="mode-desc">
                超过 64 MB 的文本文件只会流式扫描并生成只读报告，不提供直接修复；需要修改时请手动处理，或换用更小的文件。
              </p>
            ) : null}
          </div>

          {error ? (
            <Notice tone="danger" compact>
              {error}
            </Notice>
          ) : null}

          <div className="settings-actions">
            <Button
              variant="primary"
              icon={<Save size={14} />}
              loading={saving}
              disabled={!dirty}
              onClick={() => void handleSave()}
            >
              {dirty ? '保存扫描设置' : '已保存'}
            </Button>
            <Button
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => {
                setModes(settings.matchModes)
                setCaseSensitive(settings.caseSensitive)
                setMaxSizeInput(String(settings.maxFileSizeKb))
                setError(null)
              }}
            >
              撤销未保存的修改
            </Button>
          </div>
        </div>

        <aside className="settings-aside" aria-label="扫描策略说明">
          <p className="settings-block-title">扫描策略</p>
          <dl className="definition-list">
            <div>
              <dt>只读</dt>
              <dd>扫描只读取文件内容，匹配结果保存在内存中，不会写入任何文件。</dd>
            </div>
            <div>
              <dt>编码</dt>
              <dd>自动识别 UTF-8、UTF-8 BOM、UTF-16 LE/BE，写入时保持原编码。</dd>
            </div>
            <div>
              <dt>防覆盖</dt>
              <dd>
                扫描时记录普通文本文件的 SHA-256 快照；写入前若文件已变化，本次写入整体中止。
              </dd>
            </div>
            <div>
              <dt>超大文件</dt>
              <dd>
                超过 16 MB 的文本文件会流式扫描，只生成只读报告；超过 64 MB 的文件不提供直接修复。扫描预算上限约 512 MB / 2 分钟，用完后会提前停止并提示。
              </dd>
            </div>
            <div>
              <dt>忽略</dt>
              <dd>
                node_modules、.git、构建产物、二进制与图片等默认跳过，可在「忽略规则」中调整。
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  )
}
