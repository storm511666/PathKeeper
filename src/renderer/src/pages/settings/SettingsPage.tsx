import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, Project } from '@shared/types'
import { FolderPlus, ShieldCheck } from 'lucide-react'
import { cx } from '@renderer/lib/cx'
import { useApi } from '@renderer/api/context'
import { useToast } from '@renderer/components/Toast'
import { Button, EmptyState, Toggle } from '@renderer/components/ui'
import type { PageId } from '@renderer/app-types'
import { ScanSection } from './ScanSection'
import { IgnoreSection } from './IgnoreSection'
import { RulesSection } from './RulesSection'
import { BackupsSection } from './BackupsSection'
import { AboutSection } from './AboutSection'
import { DependencySettingsSection } from './DependencySettingsSection'

type SettingsTab = 'deps' | 'scan' | 'ignores' | 'rules' | 'backups' | 'about'

const BASE_TABS: ReadonlyArray<{ id: SettingsTab; label: string; testId: string }> = [
  { id: 'deps', label: '智能检查', testId: 'tab-dependencies' },
  { id: 'scan', label: '路径匹配', testId: 'tab-scan' },
  { id: 'ignores', label: '忽略规则', testId: 'tab-ignores' },
  { id: 'rules', label: '匹配规则', testId: 'tab-rules' },
  { id: 'backups', label: '备份管理', testId: 'tab-backups' },
  { id: 'about', label: '关于与隐私', testId: 'tab-about' }
]

const PROJECT_TABS: ReadonlySet<SettingsTab> = new Set(['ignores', 'rules', 'backups'])

function ProjectRequired({
  onAddProject,
  onNavigate
}: {
  onAddProject: () => Promise<void>
  onNavigate: (page: PageId) => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  return (
    <EmptyState
      motif="project"
      title="这个分页需要项目"
      description="忽略规则、匹配规则和备份都按项目单独保存。先添加一个项目根目录，再回来调整。"
      actions={
        <>
          <Button
            variant="primary"
            icon={<FolderPlus size={15} />}
            loading={adding}
            data-testid="add-project-settings"
            onClick={() => {
              setAdding(true)
              void onAddProject().finally(() => setAdding(false))
            }}
          >
            添加项目根目录
          </Button>
          <Button variant="ghost" onClick={() => onNavigate('migration')}>
            前往路径迁移
          </Button>
        </>
      }
    />
  )
}

export interface SettingsPageProps {
  project: Project | null
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  onAddProject: () => Promise<void>
  onNavigate: (page: PageId) => void
}

export function SettingsPage({
  project,
  settings,
  onSettingsChange,
  onAddProject,
  onNavigate
}: SettingsPageProps): ReactNode {
  const api = useApi()
  const toast = useToast()
  const [tab, setTab] = useState<SettingsTab>(settings.beginnerMode ? 'deps' : 'scan')
  const [savingMode, setSavingMode] = useState(false)
  const tabs = settings.beginnerMode
    ? BASE_TABS.filter((item) => item.id === 'deps' || item.id === 'about')
    : BASE_TABS

  useEffect(() => {
    if (!tabs.some((item) => item.id === tab)) setTab(settings.beginnerMode ? 'deps' : 'scan')
  }, [settings.beginnerMode, tab, tabs])

  const handleAdvancedToggle = async (advanced: boolean): Promise<void> => {
    setSavingMode(true)
    try {
      const updated = await api.settings.update({ beginnerMode: !advanced })
      onSettingsChange(updated)
      setTab(advanced ? 'scan' : 'deps')
      toast.success(advanced ? '高级模式已开启' : '已切回新手模式', advanced ? '路径迁移和完整设置已显示。' : '界面只保留最常用的功能。')
    } catch {
      toast.error('模式切换失败', '设置没有保存，请重试。')
    } finally {
      setSavingMode(false)
    }
  }

  const renderPanel = (): ReactNode => {
    if (tab === 'deps') {
      return <DependencySettingsSection settings={settings} onSettingsChange={onSettingsChange} />
    }
    if (tab === 'scan') {
      return <ScanSection settings={settings} onSettingsChange={onSettingsChange} />
    }
    if (tab === 'about') {
      return <AboutSection />
    }
    if (!project) {
      return <ProjectRequired onAddProject={onAddProject} onNavigate={onNavigate} />
    }
    if (tab === 'ignores') return <IgnoreSection project={project} />
    if (tab === 'rules') return <RulesSection project={project} />
    return <BackupsSection project={project} />
  }

  return (
    <div className="page" data-testid="settings-page">
      <header className="page-head">
        <div className="page-head-main">
          <p className="page-kicker mono">设置与本地数据</p>
          <h1 className="page-title">设置中心</h1>
          <p className="page-lede">
            {settings.beginnerMode
              ? '这里只放最常用的开关。高级规则、忽略目录和备份管理藏在“高级模式”里。'
              : '调整扫描范围、依赖检查、忽略规则、正则匹配规则与本地备份。所有设置按项目保存。'}
          </p>
        </div>
        <div className="page-head-meta">
          <span className="page-meta-label">当前项目</span>
          <code className="page-meta-path mono">{project ? project.name : '未选择项目'}</code>
          <span className="page-meta-hint">设置自动保存在本地</span>
        </div>
      </header>

      <section className="settings-mode-bar">
        <span className="settings-mode-icon" aria-hidden="true">
          <ShieldCheck size={20} />
        </span>
        <div className="settings-mode-copy">
          <p>{settings.beginnerMode ? '新手模式已开启' : '高级模式已开启'}</p>
          <span>
            {settings.beginnerMode
              ? '复杂的路径选项、规则编辑器和备份管理默认隐藏，避免误操作。'
              : '手动路径迁移、匹配规则、忽略规则和备份管理全部可见。'}
          </span>
        </div>
        <div className="settings-mode-toggle">
          <span>高级模式</span>
          <Toggle
            checked={!settings.beginnerMode}
            disabled={savingMode}
            label="高级模式"
            testId="toggle-advanced-mode"
            onChange={(value) => void handleAdvancedToggle(value)}
          />
        </div>
      </section>

      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="settings-tabpanel"
            data-testid={item.testId}
            className={cx('settings-tab', tab === item.id && 'is-active')}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {PROJECT_TABS.has(item.id) && !project ? <span className="settings-tab-dot" aria-label="需要项目" /> : null}
          </button>
        ))}
      </div>

      <div
        id="settings-tabpanel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        className="settings-tabpanel"
      >
        {renderPanel()}
      </div>
    </div>
  )
}
