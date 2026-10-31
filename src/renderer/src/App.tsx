import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AppSettings,
  DependencyChangesResult,
  MigrationRecord,
  Project,
  SoftwareInspectResult
} from '@shared/types'
import type { PathKeeperApi } from '@shared/api'
import { ApiProvider, useApi } from './api/context'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider, useToast } from './components/Toast'
import { ConfirmProvider } from './components/Confirm'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { OnboardingDialog } from './components/OnboardingDialog'
import { Button, EmptyState, Spinner } from './components/ui'
import { DependencyPage } from './pages/dependencies/DependencyPage'
import { MigrationPage } from './pages/migration/MigrationPage'
import { HistoryPage } from './pages/history/HistoryPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { SoftwarePage } from './pages/software/SoftwarePage'
import { humanizeError, type HumanError } from './lib/errors'
import { PAGE_TITLES, type MigrationSeed, type PageId } from './app-types'

function BootSplash(): ReactNode {
  return (
    <div className="boot-splash" role="status" aria-live="polite">
      <Spinner label="正在读取本地数据…" />
      <p className="boot-splash-note">PathKeeper 只读取本机的项目目录和本地数据库。</p>
    </div>
  )
}

function BootFailure({
  error,
  onRetry
}: {
  error: HumanError
  onRetry: () => void
}): ReactNode {
  return (
    <div className="boot-failure-screen" role="alert">
      <div className="boot-failure-card">
        <h1>{error.title}</h1>
        <p>{error.message}</p>
        {error.steps.length > 0 ? (
          <ol className="boot-failure-steps">
            {error.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : null}
        {error.technical ? (
          <details className="boot-failure-technical">
            <summary>技术细节</summary>
            <pre className="boot-failure-message">{error.technical}</pre>
          </details>
        ) : null}
        <div className="boot-failure-actions">
          <Button variant="primary" onClick={onRetry}>
            再试一次
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            重新加载窗口
          </Button>
        </div>
      </div>
    </div>
  )
}

function NoProjectState({
  beginnerMode,
  loadingSample,
  onAddProject,
  onLoadSample,
  onStartSoftware,
  onOpenSettings
}: {
  beginnerMode: boolean
  loadingSample: boolean
  onAddProject: () => Promise<void>
  onLoadSample: () => void
  onStartSoftware: () => Promise<void>
  onOpenSettings: () => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const [startingSoftware, setStartingSoftware] = useState(false)
  const startSoftware = (): void => {
    if (startingSoftware) return
    setStartingSoftware(true)
    void onStartSoftware().finally(() => setStartingSoftware(false))
  }
  if (beginnerMode) {
    return (
      <div className="page page-narrow">
        <EmptyState
          motif="project"
          title="先跑通一次，再修自己的项目"
          description={
            <>
              PathKeeper 会先帮你找出项目里“文件搬走了、引用还指着旧地址”的地方。
              不用懂旧路径/新路径，也不用先改任何配置。
              可以先用内置示例走一遍，马上看到完整流程。
            </>
          }
          actions={
            <>
              <Button
                variant="primary"
                data-testid="load-sample-empty"
                loading={loadingSample}
                onClick={onLoadSample}
              >
                一键加载示例工程
              </Button>
              <Button
                variant="default"
                data-testid="add-project-empty"
                loading={adding}
                onClick={() => {
                  setAdding(true)
                  void onAddProject().finally(() => setAdding(false))
                }}
              >
                选择我的项目
              </Button>
              <Button
                variant="default"
                data-testid="add-software-empty"
                loading={startingSoftware}
                onClick={startSoftware}
              >
                扫描一个软件
              </Button>
              <Button variant="ghost" onClick={onOpenSettings}>
                先看看设置
              </Button>
            </>
          }
        />
        <div className="welcome-steps" aria-label="PathKeeper 新手流程">
          <article className="welcome-step">
            <span className="welcome-step-index mono">01</span>
            <strong>自动检查</strong>
            <p>软件自己找出缺文件、路径变化和格式异常，不用先学路径术语。</p>
          </article>
          <article className="welcome-step">
            <span className="welcome-step-index mono">02</span>
            <strong>确认修复</strong>
            <p>从推荐位置里选一个，或自己选文件；写入前再次确认。</p>
          </article>
          <article className="welcome-step">
            <span className="welcome-step-index mono">03</span>
            <strong>随时回滚</strong>
            <p>每次修复自动备份，不满意可以在“修改记录”里一键恢复。</p>
          </article>
        </div>
        <p className="welcome-hint">
          示例工程会复制到本地数据目录；不会上传、不会修改你的文件。
        </p>
      </div>
    )
  }
  return (
    <div className="page page-narrow">
      <EmptyState
        motif="project"
        title="先选择一个项目根目录"
        description={
          <>
            PathKeeper 以一个项目根目录为扫描边界，遍历其中的文本文件、配置、文档与工作流。
            扫描是只读的，只有你勾选并确认的行才会写入。
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              data-testid="add-project-empty"
              loading={adding}
              icon={<span aria-hidden="true">＋</span>}
              onClick={() => {
                setAdding(true)
                void onAddProject().finally(() => setAdding(false))
              }}
            >
              添加项目根目录
            </Button>
            <Button
              variant="default"
              data-testid="add-software-empty"
              loading={startingSoftware}
              onClick={startSoftware}
            >
              扫描一个软件
            </Button>
            <Button variant="ghost" onClick={onOpenSettings}>
              查看设置中心
            </Button>
          </>
        }
      />
    </div>
  )
}

function Shell(): ReactNode {
  const api = useApi()
  const toast = useToast()
  const showHumanError = useCallback(
    (error: unknown, fallbackTitle?: string): void => {
      const human = humanizeError(error)
      toast.error(
        fallbackTitle ? `${fallbackTitle}：${human.title}` : human.title,
        human.steps.length > 0 ? `${human.message} 建议：${human.steps[0]}` : human.message
      )
    },
    [toast]
  )
  const [projects, setProjects] = useState<Project[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [page, setPage] = useState<PageId>('dependencies')
  const [seed, setSeed] = useState<MigrationSeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [bootError, setBootError] = useState<HumanError | null>(null)
  const [bootNonce, setBootNonce] = useState(0)
  const [guideOpen, setGuideOpen] = useState(false)
  const [loadingSample, setLoadingSample] = useState(false)
  const [dependencyChanges, setDependencyChanges] = useState<DependencyChangesResult | null>(null)
  const [dependencyChangeSignal, setDependencyChangeSignal] = useState(0)
  /** Inspection result handed from the welcome/sidebar “扫描一个软件” action. */
  const [softwareDraft, setSoftwareDraft] = useState<SoftwareInspectResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setBootError(null)
    Promise.all([api.projects.list(), api.settings.get()])
      .then(([projectList, appSettings]) => {
        if (cancelled) return
        setProjects(projectList)
        setSettings(appSettings)
        const preferred =
          appSettings.lastProjectId === null
            ? undefined
            : projectList.find((project) => project.id === appSettings.lastProjectId)
        const nextActive = preferred ?? projectList[0] ?? null
        setActiveId(nextActive ? nextActive.id : null)
        /* Software projects open on their read-only health report; normal
           projects keep the beginner “智能检查” landing page. */
        if (nextActive?.kind === 'software') setPage('software')
      })
      .catch((error: unknown) => {
        if (!cancelled) setBootError(humanizeError(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, bootNonce])

  useEffect(() => {
    document.title = `PathKeeper — ${PAGE_TITLES[page]}`
  }, [page])

  useEffect(() => {
    if (loading || !settings) return
    try {
      if (window.localStorage.getItem('pathkeeper.guideSeen') !== '1') setGuideOpen(true)
    } catch {
      setGuideOpen(true)
    }
  }, [loading, settings])

  const closeGuide = useCallback((): void => {
    setGuideOpen(false)
    try {
      window.localStorage.setItem('pathkeeper.guideSeen', '1')
    } catch {
      // localStorage is optional; the dialog still closes for this session.
    }
  }, [])

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeId) ?? null,
    [projects, activeId]
  )

  useEffect(() => {
    if (!settings?.beginnerMode) return
    if (page !== 'migration') return
    setPage(activeProject?.kind === 'software' ? 'software' : 'dependencies')
  }, [settings?.beginnerMode, page, activeProject?.kind])

  /* Watch the active project's dependency nodes globally, so a user who is on
     another page still gets a gentle "files changed" notice. */
  useEffect(() => {
    if (
      !activeProject ||
      activeProject.kind === 'software' ||
      !settings?.dependencyCheckEnabled ||
      !settings.dependencyAutoWatch
    ) {
      return
    }
    let disposed = false
    const unsubscribe = api.events.onDependenciesChanged((changes) => {
      if (disposed) return
      setDependencyChanges(changes)
      setDependencyChangeSignal((value) => value + 1)
      toast.info('检测到项目文件有变化', '回到“智能检查”点一下重新体检即可更新结果。')
    })
    void api.dependencies.startWatch(activeProject.id).catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
      void api.dependencies.stopWatch(activeProject.id).catch(() => undefined)
    }
  }, [
    api,
    activeProject,
    settings?.dependencyCheckEnabled,
    settings?.dependencyAutoWatch,
    toast
  ])

  const persistLastProject = useCallback(
    (projectId: number | null): void => {
      void api.settings
        .update({ lastProjectId: projectId })
        .then((next) => setSettings(next))
        .catch((error: unknown) => {
          console.error('[PathKeeper] 无法保存当前项目', error)
        })
    },
    [api]
  )

  const handleSelectProject = useCallback(
    (projectId: number): void => {
      const selected = projects.find((project) => project.id === projectId)
      setActiveId(projectId)
      persistLastProject(projectId)
      setSoftwareDraft(null)
      if (selected?.kind === 'software') {
        setPage('software')
      } else if (page === 'software') {
        setPage('dependencies')
      }
    },
    [page, persistLastProject, projects]
  )

  const handleAddProject = useCallback(async (): Promise<void> => {
    try {
      const created = await api.projects.add()
      if (!created) return
      const list = await api.projects.list()
      setProjects(list)
      setActiveId(created.id)
      persistLastProject(created.id)
      setSoftwareDraft(null)
      if (page === 'software') setPage('dependencies')
      toast.success(`已添加项目「${created.name}」`, created.rootPath)
    } catch (error) {
      showHumanError(error, '添加项目失败')
    }
  }, [api, page, persistLastProject, showHumanError, toast])

  const handleLoadSample = useCallback((): void => {
    if (loadingSample) return
    setLoadingSample(true)
    void api.projects
      .loadSample()
      .then(async (created) => {
        const list = await api.projects.list()
        setProjects(list)
        setActiveId(created.id)
        persistLastProject(created.id)
        setSoftwareDraft(null)
        setPage('dependencies')
        closeGuide()
        toast.success('示例工程已加载', '正在自动体检，马上就能看到完整流程。')
      })
      .catch((error: unknown) => {
        showHumanError(error, '示例工程加载失败')
      })
      .finally(() => setLoadingSample(false))
  }, [api, closeGuide, loadingSample, persistLastProject, showHumanError, toast])

  /** App-level “扫描一个软件”: open the native picker, then let SoftwarePage
      show the confirm card. The page performs add + scan after the user
      confirms, and calls `handleSoftwareCreated` when a new project appears. */
  const handleStartSoftware = useCallback(async (): Promise<void> => {
    setPage('software')
    setSoftwareDraft(null)
    try {
      const inspected = await api.software.pick('file')
      if (!inspected) return
      setSoftwareDraft(inspected)
    } catch (error) {
      showHumanError(error, '没有选中软件')
    }
  }, [api, showHumanError])

  const handleSoftwareCreated = useCallback(
    async (created: Project): Promise<void> => {
      let list: Project[] = []
      try {
        list = await api.projects.list()
      } catch {
        list = [created]
      }
      const nextList = list.length > 0 ? list : [created]
      setProjects(nextList)
      setActiveId(created.id)
      persistLastProject(created.id)
      setSoftwareDraft(null)
      setPage('software')
      toast.success(`软件「${created.name}」已准备好`, '正在做只读体检，不会启动或修改这个软件。')
    },
    [api, persistLastProject, toast]
  )

  const handleDraftConsumed = useCallback((): void => {
    setSoftwareDraft(null)
  }, [])

  const handleToggleBeginnerMode = useCallback(
    (beginnerMode: boolean): void => {
      void api.settings
        .update({ beginnerMode })
        .then((next) => {
          setSettings(next)
          if (beginnerMode && page === 'migration') {
            setPage(activeProject?.kind === 'software' ? 'software' : 'dependencies')
          }
          toast.success(
            beginnerMode ? '已切回新手模式' : '高级模式已开启',
            beginnerMode ? '界面只保留最常用的功能。' : '手动路径迁移和完整设置已显示。'
          )
        })
        .catch((error: unknown) => {
          showHumanError(error, '模式切换失败')
        })
    },
    [activeProject?.kind, api, page, showHumanError, toast]
  )

  const handleRenameProject = useCallback(
    async (project: Project, name: string): Promise<boolean> => {
      const trimmed = name.trim()
      if (!trimmed) {
        toast.error('项目名称不能为空。')
        return false
      }
      try {
        const updated = await api.projects.rename(project.id, trimmed)
        setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        toast.success('项目已重命名', updated.name)
        return true
      } catch (error) {
        showHumanError(error, '重命名项目失败')
        return false
      }
    },
    [api, showHumanError, toast]
  )

  const handleRemoveProject = useCallback(
    async (project: Project): Promise<void> => {
      try {
        await api.projects.remove(project.id)
        const list = await api.projects.list()
        setProjects(list)
        setSoftwareDraft(null)
        if (activeId === project.id) {
          const nextActive = list[0] ?? null
          setActiveId(nextActive ? nextActive.id : null)
          persistLastProject(nextActive ? nextActive.id : null)
          if (nextActive?.kind === 'software') setPage('software')
          else if (page === 'software') setPage('dependencies')
        }
        toast.success(`已从列表移除「${project.name}」`, '磁盘文件与备份未被删除。')
      } catch (error) {
        showHumanError(error, '移除项目失败')
      }
    },
    [api, activeId, page, persistLastProject, showHumanError, toast]
  )

  const handleRevealProject = useCallback(
    (project: Project): void => {
      void api.projects.reveal(project.id).catch((error: unknown) => {
        showHumanError(error, '无法打开项目目录')
      })
    },
    [api, showHumanError]
  )

  const handleSettingsChange = useCallback((next: AppSettings): void => {
    setSettings(next)
  }, [])

  const handleNavigate = useCallback((next: PageId): void => {
    setPage(next)
  }, [])

  const handleRescan = useCallback((record: MigrationRecord): void => {
    setSeed({
      oldPath: record.oldPath,
      newPath: record.newPath,
      kind: record.kind,
      nonce: Date.now()
    })
    setPage('migration')
  }, [])

  const handleSeedConsumed = useCallback((): void => {
    setSeed(null)
  }, [])

  let mainContent: ReactNode
  if (loading) {
    mainContent = <BootSplash />
  } else if (bootError) {
    mainContent = <BootFailure error={bootError} onRetry={() => setBootNonce((value) => value + 1)} />
  } else if (!settings) {
    mainContent = (
      <BootFailure
        error={{
          title: '本地设置没有读取成功',
          message: 'PathKeeper 暂时读不到本地设置；项目文件没有被修改。',
          steps: ['先点“再试一次”', '仍然失败时重新加载窗口', '问题持续时反馈技术细节'],
          technical: null,
          code: null
        }}
        onRetry={() => setBootNonce((value) => value + 1)}
      />
    )
  } else if (page === 'settings') {
    mainContent = (
      <SettingsPage
        project={activeProject}
        settings={settings}
        onSettingsChange={handleSettingsChange}
        onAddProject={handleAddProject}
        onNavigate={handleNavigate}
      />
    )
  } else if (page === 'software') {
    mainContent = (
      <SoftwarePage
        project={activeProject}
        settings={settings}
        draft={softwareDraft}
        onDraftConsumed={handleDraftConsumed}
        onSoftwareCreated={handleSoftwareCreated}
        onNavigate={handleNavigate}
      />
    )
  } else if (!activeProject) {
    mainContent = (
      <NoProjectState
        beginnerMode={settings.beginnerMode}
        loadingSample={loadingSample}
        onAddProject={handleAddProject}
        onLoadSample={handleLoadSample}
        onStartSoftware={handleStartSoftware}
        onOpenSettings={() => setPage('settings')}
      />
    )
  } else if (page === 'dependencies') {
    mainContent = (
      <DependencyPage
        key={`${activeProject.id}-dependencies`}
        project={activeProject}
        settings={settings}
        changeSignal={dependencyChangeSignal}
        latestChanges={dependencyChanges}
        onNavigate={handleNavigate}
      />
    )
  } else if (page === 'history') {
    mainContent = (
      <HistoryPage
        key={`${activeProject.id}-history`}
        project={activeProject}
        beginnerMode={settings.beginnerMode}
        onRescan={handleRescan}
        onNavigate={handleNavigate}
      />
    )
  } else {
    mainContent = (
      <MigrationPage
        key={`${activeProject.id}-migration`}
        project={activeProject}
        settings={settings}
        seed={seed}
        onSeedConsumed={handleSeedConsumed}
        onSettingsChange={handleSettingsChange}
        onOpenHistory={() => setPage('history')}
      />
    )
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <TitleBar project={activeProject} />
      <div className="app-body">
        <Sidebar
          projects={projects}
          activeProject={activeProject}
          page={page}
          beginnerMode={settings?.beginnerMode ?? true}
          onNavigate={handleNavigate}
          onToggleBeginnerMode={handleToggleBeginnerMode}
          onSelectProject={handleSelectProject}
          onAddProject={handleAddProject}
          onStartSoftware={handleStartSoftware}
          onRenameProject={handleRenameProject}
          onRemoveProject={handleRemoveProject}
          onRevealProject={handleRevealProject}
        />
        <main className="app-main" id="main-content" tabIndex={-1}>
          {mainContent}
        </main>
      </div>
      <OnboardingDialog
        open={guideOpen}
        loadingSample={loadingSample}
        hasProject={projects.length > 0}
        onLoadSample={handleLoadSample}
        onClose={closeGuide}
      />
    </div>
  )
}

export function App({ api }: { api: PathKeeperApi }): ReactNode {
  return (
    <ErrorBoundary>
      <ApiProvider api={api}>
        <ToastProvider>
          <ConfirmProvider>
            <Shell />
          </ConfirmProvider>
        </ToastProvider>
      </ApiProvider>
    </ErrorBoundary>
  )
}
