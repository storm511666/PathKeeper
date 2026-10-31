import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MatchModes, PathInfo, PathKindInput, Project } from '@shared/types'
import {
  ArrowUpDown,
  CircleAlert,
  FolderOpen,
  ScanSearch,
  TriangleAlert,
  X
} from 'lucide-react'
import { useApi } from '@renderer/api/context'
import { describeError } from '@renderer/lib/errors'
import { pathKindLabel } from '@renderer/lib/labels'
import {
  Button,
  Chip,
  InlineError,
  Notice,
  Segmented,
  Spinner,
  Toggle
} from '@renderer/components/ui'
import { useToast } from '@renderer/components/Toast'

const KIND_OPTIONS = [
  { value: 'auto' as const, label: '自动判断', testId: 'kind-auto' },
  { value: 'file' as const, label: '文件', testId: 'kind-file' },
  { value: 'directory' as const, label: '目录', testId: 'kind-directory' }
]

const MODE_ROWS: ReadonlyArray<{
  key: keyof MatchModes
  name: string
  description: string
}> = [
  { key: 'strict', name: '严格匹配', description: '解析后的完整相对路径与旧路径一致。' },
  { key: 'basename', name: '文件名匹配', description: '仅文件名一致时也视为引用，适合跨目录重命名。' },
  { key: 'directory', name: '目录重映射', description: '旧目录之下的所有引用整体映射到新目录。' }
]

interface BrowseMenuState {
  side: 'old' | 'new'
}

export interface MigrationComposerProps {
  project: Project
  oldPath: string
  newPath: string
  kind: PathKindInput
  modes: MatchModes
  modesSaving: boolean
  preview: PathInfo | null
  previewLoading: boolean
  previewError: string | null
  scanning: boolean
  canScan: boolean
  scanError: string | null
  applied: boolean
  onOldPathChange: (value: string) => void
  onNewPathChange: (value: string) => void
  onKindChange: (kind: PathKindInput) => void
  onSwap: () => void
  onModesChange: (modes: MatchModes) => void
  onScan: () => void
}

export function MigrationComposer({
  project,
  oldPath,
  newPath,
  kind,
  modes,
  modesSaving,
  preview,
  previewLoading,
  previewError,
  scanning,
  canScan,
  scanError,
  applied,
  onOldPathChange,
  onNewPathChange,
  onKindChange,
  onSwap,
  onModesChange,
  onScan
}: MigrationComposerProps): ReactNode {
  const api = useApi()
  const toast = useToast()
  const [browsingSide, setBrowsingSide] = useState<'old' | 'new' | null>(null)
  const [browseMenu, setBrowseMenu] = useState<BrowseMenuState | null>(null)
  const browseWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!browseMenu) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && browseWrapRef.current?.contains(event.target)) return
      setBrowseMenu(null)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBrowseMenu(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [browseMenu])

  const pickPath = async (side: 'old' | 'new', pickKind: 'file' | 'directory'): Promise<void> => {
    setBrowseMenu(null)
    setBrowsingSide(side)
    try {
      const selected = await api.dialogs.pickProjectPath({ projectId: project.id, side, kind: pickKind })
      if (!selected) return
      const value = selected.relPath.trim().length > 0 ? selected.relPath : selected.absPath
      if (side === 'old') onOldPathChange(value)
      else onNewPathChange(value)
      if (kind === 'auto') onKindChange(pickKind)
      if (!selected.exists) {
        toast.info('选择的位置当前不存在', '这不影响作为新路径使用，请确认拼写。')
      }
    } catch (error) {
      toast.error('无法选择路径', describeError(error).message)
    } finally {
      setBrowsingSide(null)
    }
  }

  const handleBrowseClick = (side: 'old' | 'new'): void => {
    if (kind === 'auto') {
      setBrowseMenu((current) => (current?.side === side ? null : { side }))
      return
    }
    void pickPath(side, kind)
  }

  const browseMenuFor = (side: 'old' | 'new'): ReactNode => {
    if (browseMenu?.side !== side) return null
    return (
      <div className="browse-menu" role="menu" aria-label={side === 'old' ? '选择旧路径类型' : '选择新路径类型'}>
        <button type="button" role="menuitem" className="browse-menu-item" onClick={() => void pickPath(side, 'file')}>
          选择文件…
        </button>
        <button
          type="button"
          role="menuitem"
          className="browse-menu-item"
          onClick={() => void pickPath(side, 'directory')}
        >
          选择文件夹…
        </button>
      </div>
    )
  }

  const browseButton = (side: 'old' | 'new'): ReactNode => (
    <span className="path-browse">
      <Button
        size="sm"
        variant="default"
        icon={<FolderOpen size={14} />}
        loading={browsingSide === side}
        aria-haspopup={kind === 'auto' ? 'menu' : undefined}
        aria-expanded={kind === 'auto' ? browseMenu?.side === side : undefined}
        onClick={() => handleBrowseClick(side)}
      >
        浏览
      </Button>
      {browseMenuFor(side)}
    </span>
  )

  return (
    <section className="route-plate" aria-label="迁移路线">
      <header className="plate-head">
        <div>
          <p className="plate-kicker mono">01 / 迁移路线</p>
          <h2 className="plate-title">记录路径变更</h2>
        </div>
        <p className="plate-note">
          旧路径 = 文件以前在哪里；新路径 = 文件现在在哪里。两者都相对于项目根目录。
        </p>
      </header>

      <div className="route-grid">
        <div className="route-fields" ref={browseWrapRef}>
          <div className="path-field">
            <div className="path-field-head">
              <label className="path-field-label" htmlFor="old-path-input">
                旧路径
              </label>
              <Chip tone="neutral" mono>
                扫描目标
              </Chip>
            </div>
            <div className="input-row">
              <input
                id="old-path-input"
                data-testid="old-path-input"
                className="input input-mono"
                value={oldPath}
                placeholder="例如 assets/textures/old_brick_wall.png"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => onOldPathChange(event.target.value)}
              />
              {oldPath ? (
                <button
                  type="button"
                  className="input-clear"
                  aria-label="清空旧路径"
                  title="清空旧路径"
                  onClick={() => onOldPathChange('')}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
              {browseButton('old')}
            </div>
            <p className="path-field-help">
              文件移动前的位置；项目里的旧引用还写着它，但现在可能已经找不到文件。
            </p>
          </div>

          <div className="route-link">
            <span className="route-link-track" aria-hidden="true">
              <span className="route-link-node" />
              <span className="route-link-dash" />
            </span>
            <span className="route-link-tag mono">旧引用 → 新引用</span>
            <button
              type="button"
              className="route-swap"
              onClick={onSwap}
              disabled={oldPath.length === 0 && newPath.length === 0}
              title="交换旧路径与新路径"
            >
              <ArrowUpDown size={13} aria-hidden="true" />
              交换
            </button>
          </div>

          <div className="path-field">
            <div className="path-field-head">
              <label className="path-field-label" htmlFor="new-path-input">
                新路径
              </label>
              <Chip tone="brass" mono>
                替换为
              </Chip>
            </div>
            <div className="input-row">
              <input
                id="new-path-input"
                data-testid="new-path-input"
                className="input input-mono"
                value={newPath}
                placeholder="例如 assets/materials/brick_wall.png"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => onNewPathChange(event.target.value)}
              />
              {newPath ? (
                <button
                  type="button"
                  className="input-clear"
                  aria-label="清空新路径"
                  title="清空新路径"
                  onClick={() => onNewPathChange('')}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
              {browseButton('new')}
            </div>
            <p className="path-field-help">
              文件移动后的位置；可以点“浏览”选择，也可以直接填写项目里的新路径。
            </p>
          </div>

          <div className="kind-row">
            <span className="kind-label">路径类型</span>
            <Segmented
              value={kind}
              options={KIND_OPTIONS}
              onChange={onKindChange}
              label="路径类型"
              disabled={scanning}
            />
            <span className="kind-hint">自动判断依据路径的后缀与分隔符。</span>
          </div>
        </div>

        <aside className="proof-panel" aria-label="归一化预览与匹配范围">
          <div className="proof-section">
            <div className="proof-head">
              <p className="plate-kicker mono">归一化预览</p>
              {previewLoading ? <Spinner /> : null}
              {preview ? <Chip tone="outline" mono>{pathKindLabel(preview.kind)}</Chip> : null}
            </div>
            {previewError ? (
              <InlineError message={previewError} />
            ) : preview ? (
              <div className="proof-route">
                <div className="proof-path">
                  <span className="proof-path-tag">旧</span>
                  <code>{preview.oldRel}</code>
                </div>
                <div className="proof-connector" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="proof-path">
                  <span className="proof-path-tag proof-path-tag-new">新</span>
                  <code>{preview.newRel}</code>
                </div>
                {preview.warnings.length > 0 ? (
                  <ul className="proof-warnings">
                    {preview.warnings.map((warning) => (
                      <li key={warning}>
                        <TriangleAlert size={12} aria-hidden="true" />
                        {warning}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="proof-empty">
                {oldPath.trim() && newPath.trim()
                  ? '正在等待路径输入稳定后计算…'
                  : '填写旧路径与新路径后，这里会显示归一化结果。'}
              </p>
            )}
          </div>

          <div className="proof-rule" role="separator" />

          <div className="proof-section">
            <div className="proof-head">
              <p className="plate-kicker mono">02 / 匹配范围</p>
              <span className="proof-save">{modesSaving ? '保存中…' : '自动保存'}</span>
            </div>
            <div className="mode-list">
              {MODE_ROWS.map((row) => {
                const enabled = modes[row.key]
                const enabledCount = Number(modes.strict) + Number(modes.basename) + Number(modes.directory)
                const lockedOn = enabled && enabledCount === 1
                return (
                  <div className="mode-row" key={row.key}>
                    <div className="mode-copy">
                      <span className="mode-name">{row.name}</span>
                      <span className="mode-desc">{row.description}</span>
                    </div>
                    <Toggle
                      checked={enabled}
                      disabled={modesSaving || lockedOn}
                      label={`${row.name}${lockedOn ? '（至少保留一项）' : ''}`}
                      onChange={(checked) => onModesChange({ ...modes, [row.key]: checked })}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </aside>
      </div>

      <div className="route-actions">
        <Notice tone="info" compact icon={<CircleAlert size={15} />} title="扫描只读">
          扫描只读取并匹配文本文件，不会写入任何内容。应用修改需要二次确认，并自动创建备份。
        </Notice>
        <div className="route-scan">
          <Button
            variant="primary"
            size="md"
            data-testid="scan-button"
            icon={<ScanSearch size={15} />}
            loading={scanning}
            disabled={!canScan}
            onClick={onScan}
          >
            {scanning ? '扫描中…' : applied ? '重新扫描' : '开始扫描'}
          </Button>
        </div>
      </div>
      {scanError ? <InlineError message={scanError} /> : null}
    </section>
  )
}
