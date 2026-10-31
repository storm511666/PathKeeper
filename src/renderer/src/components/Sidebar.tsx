import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import {
  AppWindow,
  Check,
  ChevronDown,
  FolderOpen,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { cx } from '@renderer/lib/cx'
import { useApi } from '@renderer/api/context'
import { Button, Field, Toggle } from './ui'
import { Modal } from './Modal'
import { useConfirm } from './Confirm'
import { useToast } from './Toast'
import type { PageId } from '@renderer/app-types'

const BEGINNER_NAV: ReadonlyArray<{ id: PageId; label: string; testId: string }> = [
  { id: 'dependencies', label: '智能检查', testId: 'nav-dependencies' },
  { id: 'history', label: '修改记录', testId: 'nav-history' },
  { id: 'settings', label: '设置', testId: 'nav-settings' }
]

const ADVANCED_NAV: ReadonlyArray<{ id: PageId; label: string; testId: string }> = [
  { id: 'dependencies', label: '智能检查', testId: 'nav-dependencies' },
  { id: 'migration', label: '路径迁移', testId: 'nav-migrate' },
  { id: 'history', label: '迁移历史', testId: 'nav-history' },
  { id: 'settings', label: '设置中心', testId: 'nav-settings' }
]

export interface SidebarProps {
  projects: Project[]
  activeProject: Project | null
  page: PageId
  beginnerMode: boolean
  onNavigate: (page: PageId) => void
  onToggleBeginnerMode: (beginnerMode: boolean) => void
  onSelectProject: (projectId: number) => void
  onAddProject: () => Promise<void>
  /** Opens the shared “扫描一个软件” flow (native picker + confirm card). */
  onStartSoftware: () => Promise<void>
  onRenameProject: (project: Project, name: string) => Promise<boolean>
  onRemoveProject: (project: Project) => Promise<void>
  onRevealProject: (project: Project) => void
}

export function Sidebar({
  projects,
  activeProject,
  page,
  beginnerMode,
  onNavigate,
  onToggleBeginnerMode,
  onSelectProject,
  onAddProject,
  onStartSoftware,
  onRenameProject,
  onRemoveProject,
  onRevealProject
}: SidebarProps): ReactNode {
  const confirm = useConfirm()
  const toast = useToast()
  const api = useApi()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [startingSoftware, setStartingSoftware] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Project | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const projectBlockRef = useRef<HTMLDivElement | null>(null)
  const baseNav = beginnerMode ? BEGINNER_NAV : ADVANCED_NAV
  /* Software projects get their own read-only report entry in both modes.
     Normal projects keep exactly the same navigation as before. */
  const navItems =
    activeProject?.kind === 'software'
      ? [{ id: 'software' as PageId, label: '软件体检', testId: 'nav-software' }, ...baseNav]
      : baseNav

  useEffect(() => {
    if (!menuOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      const block = projectBlockRef.current
      if (block && event.target instanceof Node && block.contains(event.target)) return
      setMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    setMenuOpen(false)
  }, [page])

  /* Show the real app version instead of a hardcoded string. */
  useEffect(() => {
    let cancelled = false
    api.system
      .info()
      .then((info) => {
        if (!cancelled && info.appVersion) {
          setAppVersion(info.appVersion)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  const handleAdd = async (): Promise<void> => {
    if (adding) return
    setAdding(true)
    try {
      await onAddProject()
      setMenuOpen(false)
    } finally {
      setAdding(false)
    }
  }

  const handleStartSoftware = async (): Promise<void> => {
    if (startingSoftware) return
    setStartingSoftware(true)
    setMenuOpen(false)
    try {
      await onStartSoftware()
    } finally {
      setStartingSoftware(false)
    }
  }

  const handleRemove = async (project: Project): Promise<void> => {
    setMenuOpen(false)
    const accepted = await confirm({
      title: '从列表中移除项目？',
      description: (
        <>
          将把「{project.name}」移出 PathKeeper 项目列表，并删除该项目的迁移记录。
          <strong>磁盘上的源文件不会被删除。</strong>
        </>
      ),
      details: (
        <dl className="detail-list">
          <div>
            <dt>项目根目录</dt>
            <dd className="mono">{project.rootPath}</dd>
          </div>
          <div>
            <dt>备份</dt>
            <dd>备份文件仍保留在项目的 .pathkeeper-backup/ 目录中，需要时请手动处理。</dd>
          </div>
        </dl>
      ),
      confirmLabel: '移除项目',
      tone: 'danger',
      testId: 'confirm-dialog',
      confirmTestId: 'confirm-remove-project'
    })
    if (!accepted) return
    await onRemoveProject(project)
  }

  const handleReveal = (project: Project): void => {
    setMenuOpen(false)
    onRevealProject(project)
  }

  const openRename = (project: Project): void => {
    setMenuOpen(false)
    setRenameTarget(project)
    setRenameValue(project.name)
  }

  const submitRename = async (): Promise<void> => {
    if (!renameTarget) return
    const value = renameValue.trim()
    if (!value) {
      toast.error('项目名称不能为空。')
      return
    }
    if (value === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      const ok = await onRenameProject(renameTarget, value)
      if (ok) setRenameTarget(null)
    } finally {
      setRenaming(false)
    }
  }

  return (
    <aside className="rail" aria-label="项目与导航">
      <div className="rail-brand">
        <div className="rail-brand-line">
          <span className="rail-brand-word">PathKeeper</span>
          <span className="rail-brand-tag mono">v{appVersion ?? '2.1.1'}</span>
        </div>
        <p className="rail-brand-sub">路径引用迁移工具</p>
      </div>

      <nav className="rail-nav" aria-label="主导航">
        <span className="rail-spine" aria-hidden="true" />
        {navItems.map((item, position) => (
          <button
            key={item.id}
            type="button"
            data-testid={item.testId}
            className={cx('rail-nav-item', page === item.id && 'is-active')}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <span className="rail-node mono" aria-hidden="true">
              {String(position + 1).padStart(2, '0')}
            </span>
            <span className="rail-nav-label">{item.label}</span>
            {item.id === 'dependencies' ? <span className="rail-new">NEW</span> : null}
          </button>
        ))}
      </nav>

      <div className="rail-fill" />

      <div className="rail-project" ref={projectBlockRef}>
        <p className="rail-label">当前项目</p>
        <button
          type="button"
          className={cx('project-card', menuOpen && 'is-open')}
          data-testid="project-switcher"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          title={activeProject?.rootPath ?? '选择或添加项目'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="project-card-glyph mono" aria-hidden="true">
            {activeProject ? String(activeProject.id).padStart(2, '0') : '--'}
          </span>
          <span className="project-card-copy">
            <span className="project-card-name">{activeProject ? activeProject.name : '未选择项目'}</span>
            <span className="project-card-path mono">
              {activeProject ? activeProject.rootPath : '添加项目根目录后开始'}
            </span>
          </span>
          <ChevronDown size={14} className="project-card-chevron" aria-hidden="true" />
        </button>

        <Button
          variant="default"
          size="sm"
          block
          icon={<Plus size={14} />}
          loading={adding}
          data-testid="add-project"
          onClick={() => void handleAdd()}
        >
          添加项目
        </Button>

        {menuOpen ? (
          <div className="project-menu" role="menu" aria-label="项目列表">
            <p className="project-menu-label">切换项目</p>
            <div className="project-menu-list">
              {projects.length === 0 ? <p className="project-menu-empty">还没有项目</p> : null}
              {projects.map((project) => {
                const isActive = project.id === activeProject?.id
                return (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={cx('project-menu-item', isActive && 'is-active')}
                    onClick={() => {
                      setMenuOpen(false)
                      onSelectProject(project.id)
                    }}
                  >
                    <Check size={13} className="menu-check" aria-hidden="true" />
                    <span className="menu-item-copy">
                      <span className="menu-item-name">{project.name}</span>
                      <span className="menu-item-path mono">{project.rootPath}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="project-menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="project-menu-action"
              data-testid="add-project-menu"
              onClick={() => void handleAdd()}
            >
              <Plus size={14} aria-hidden="true" /> 添加项目…
            </button>
            <button
              type="button"
              role="menuitem"
              className="project-menu-action"
              data-testid="add-software-menu"
              disabled={startingSoftware}
              onClick={() => void handleStartSoftware()}
            >
              <AppWindow size={14} aria-hidden="true" /> 扫描一个软件…
            </button>
            {activeProject ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="project-menu-action"
                  onClick={() => handleReveal(activeProject)}
                >
                  <FolderOpen size={14} aria-hidden="true" /> 在资源管理器中显示
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="project-menu-action"
                  onClick={() => openRename(activeProject)}
                >
                  <Pencil size={14} aria-hidden="true" /> 重命名项目…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="project-menu-action is-danger"
                  onClick={() => void handleRemove(activeProject)}
                >
                  <Trash2 size={14} aria-hidden="true" /> 从列表移除…
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rail-mode">
        <span className="rail-mode-copy">
          <strong>高级模式</strong>
          <small>手动迁移与完整设置</small>
        </span>
        <Toggle
          checked={!beginnerMode}
          onChange={(advanced) => onToggleBeginnerMode(!advanced)}
          label="高级模式"
          testId="toggle-advanced-mode"
        />
      </div>

      <div className="rail-foot">
        <span className="rail-foot-dot" aria-hidden="true" />
        <span>本地运行 · 不联网</span>
      </div>

      <Modal
        open={renameTarget !== null}
        title="重命名项目"
        description="只更改 PathKeeper 中显示的名称，不会重命名磁盘上的目录。"
        onClose={() => {
          if (!renaming) setRenameTarget(null)
        }}
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameTarget(null)} disabled={renaming}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={renaming}
              disabled={renameValue.trim().length === 0}
              onClick={() => void submitRename()}
            >
              保存名称
            </Button>
          </>
        }
      >
        <Field label="项目名称" htmlFor="rename-project-input" hint="建议使用简短的项目名，路径信息不会改变。">
          <input
            id="rename-project-input"
            className="input"
            value={renameValue}
            maxLength={120}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename()
            }}
          />
        </Field>
        {renameTarget ? <p className="rename-target mono">{renameTarget.rootPath}</p> : null}
      </Modal>
    </aside>
  )
}
