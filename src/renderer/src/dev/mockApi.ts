import type { PathKeeperApi } from '@shared/api'
import type {
  AppSettings,
  ApplyResult,
  AutoCheckResult,
  BackupRecord,
  DependencyCacheRebuildResult,
  DependencyChangesResult,
  DependencyIssue,
  DependencyIgnoreResult,
  DependencyRepairResult,
  DependencyScanResult,
  DependencyValidateFixRequest,
  DependencyValidation,
  FilePreview,
  IgnoreInput,
  IgnoreRule,
  MatchRule,
  MigrationRecord,
  PathInfo,
  PathPreviewRequest,
  PickPathRequest,
  Project,
  RollbackResult,
  RuleInput,
  RuleTestResult,
  RuleValidation,
  SaveTextRequest,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SelectedPath,
  SoftwareAddRequest,
  SoftwareInspectResult,
  SoftwarePickMode,
  SoftwareScanRequest,
  SoftwareScanResult,
  SystemInfo
} from '@shared/types'
import {
  createSampleOccurrences,
  createSeedBackups,
  createSeedHistory,
  createSeedIgnores,
  createSeedRules,
  DEMO_NEW_PATH,
  DEMO_OLD_PATH,
  MOCK_PROJECTS,
  MOCK_SETTINGS,
  MOCK_SOFTWARE_ENTRY,
  MOCK_SOFTWARE_ROOT,
  MOCK_SYSTEM_INFO,
  SAMPLE_SCAN_FILE_NAMES
} from './mockData'

class MockError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PathKeeperError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new MockError(code, message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function copySettings(settings: AppSettings): AppSettings {
  return { ...settings, matchModes: { ...settings.matchModes } }
}

function baseName(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}

function looksLikeFile(value: string): boolean {
  return /\.[A-Za-z0-9]{1,12}$/.test(baseName(value))
}

function collapseRel(value: string): string {
  const output: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      output.pop()
      continue
    }
    output.push(part)
  }
  return output.join('/')
}

function stripRoot(root: string, candidate: string): string | null {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedCandidate = candidate.replace(/\\/g, '/')
  const lowerRoot = normalizedRoot.toLowerCase()
  const lowerCandidate = normalizedCandidate.toLowerCase()
  if (lowerCandidate === lowerRoot) return ''
  if (lowerCandidate.startsWith(`${lowerRoot}/`)) {
    return normalizedCandidate.slice(normalizedRoot.length + 1)
  }
  return null
}

function resolveInput(root: string, input: string): { rel: string; abs: string } {
  const raw = input.trim()
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\') || raw.startsWith('/')
  const cleanedRoot = root.replace(/[\\/]+$/, '')
  if (isAbsolute) {
    const inside = stripRoot(root, raw)
    if (inside === null) fail('OUTSIDE_PROJECT', '路径必须位于当前项目根目录内。')
    const rel = inside.replace(/\\/g, '/')
    if (!rel) fail('INVALID_PATH', '路径不能是项目根目录本身。')
    return { rel, abs: `${cleanedRoot}\\${rel.replace(/\//g, '\\')}` }
  }
  const rel = collapseRel(raw.replace(/\\/g, '/'))
  if (!rel) fail('INVALID_PATH', '请输入项目内的路径。')
  return { rel, abs: `${cleanedRoot}\\${rel.replace(/\//g, '\\')}` }
}

function computePreview(request: PathPreviewRequest, project: Project): PathInfo {
  if (!request.oldPath.trim()) fail('INVALID_PATH', '请输入旧路径。')
  if (!request.newPath.trim()) fail('INVALID_PATH', '请输入新路径。')
  const oldResolved = resolveInput(project.rootPath, request.oldPath)
  const newResolved = resolveInput(project.rootPath, request.newPath)
  if (oldResolved.rel.toLowerCase() === newResolved.rel.toLowerCase()) {
    fail('SAME_PATH', '旧路径与新路径指向相同位置，没有可替换的内容。')
  }
  const kind: PathInfo['kind'] =
    request.kind === 'auto' ? (looksLikeFile(oldResolved.rel) ? 'file' : 'directory') : request.kind
  const warnings: string[] = []
  if (kind === 'file' && !looksLikeFile(oldResolved.rel)) {
    warnings.push('旧路径没有可识别的文件后缀，请确认正在进行文件迁移。')
  }
  if (kind === 'directory' && looksLikeFile(oldResolved.rel)) {
    warnings.push('旧路径看起来是一个文件；目录重映射模式可能不会匹配到引用。')
  }
  warnings.push('新路径当前不存在；PathKeeper 只会替换文本中的引用，不会创建或移动文件。')
  return {
    kind,
    oldRel: oldResolved.rel,
    newRel: newResolved.rel,
    oldName: baseName(oldResolved.rel),
    newName: baseName(newResolved.rel),
    oldAbs: oldResolved.abs,
    newAbs: newResolved.abs,
    warnings
  }
}

function validatePattern(pattern: string, flags: string): RuleValidation {
  try {
    new RegExp(pattern, flags.replace(/[gd]/g, ''))
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : '正则表达式无效。',
      captureGroup: null
    }
  }
  const named = /\(\?<([A-Za-z_$][\w$]*)>/.exec(pattern)
  if (named?.[1]) return { valid: true, error: null, captureGroup: named[1] }
  const captureCount = (pattern.replace(/\\./g, '').match(/(?<!\\)\((?!\?)/g) ?? []).length
  if (captureCount === 0) {
    return {
      valid: false,
      error: '规则需要至少一个捕获组；推荐使用命名捕获组 (?<path>…)。',
      captureGroup: null
    }
  }
  return { valid: true, error: null, captureGroup: '第 1 个捕获组' }
}

function testPattern(pattern: string, flags: string, sample: string): RuleTestResult {
  const validation = validatePattern(pattern, flags)
  if (!validation.valid) {
    return { ...validation, matchCount: 0, matches: [] }
  }
  const regex = new RegExp(pattern, `${flags.replace(/[gd]/g, '')}g`)
  const matches: string[] = []
  let match: RegExpExecArray | null = regex.exec(sample)
  while (match && matches.length < 50) {
    const named = validation.captureGroup && match.groups ? match.groups[validation.captureGroup] : undefined
    matches.push(named ?? match[0])
    if (match[0].length === 0) regex.lastIndex += 1
    match = regex.exec(sample)
  }
  return { ...validation, matchCount: matches.length, matches }
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function parentOf(target: string): string {
  const normalized = stripTrailingSeparators(target)
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return index > 0 ? normalized.slice(0, index) : normalized
}

/** Dev-only software metadata used by the “扫描一个软件” flow. */
function mockSoftwareInspect(target: string): SoftwareInspectResult {
  const isExe = /\.exe$/i.test(stripTrailingSeparators(target))
  const entryPath = isExe ? stripTrailingSeparators(target) : null
  const rootPath = isExe ? parentOf(target) : stripTrailingSeparators(target)
  return {
    rootPath,
    entryPath,
    info: {
      productName: rootPath.toLowerCase().includes('pathkeeper')
        ? 'PathKeeper'
        : 'Example App',
      fileDescription: '示例桌面软件（演示数据）',
      productVersion: '2.4.1',
      companyName: 'Example Studio',
      entryPath,
      iconDataUrl: null
    },
    warnings: []
  }
}

/** A 32×32 inline SVG placeholder thumbnail for the dev mock. */
const MOCK_THUMBNAIL =
  'data:image/svg+xml;base64,' +
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+'
  + 'PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjOGM2ZjVhIi8+PHBhdGggZD0iTTAgMjBo'
  + 'MTB2MTJIMHptMTIgMGgxMHYxMkgyNHptMTIgMGgxMHYxMkgxMnoiIGZpbGw9IiNjOWI2YTgiLz48L3N2Zz4='

function mockSoftwareTextReport(project: Project): DependencyScanResult {
  const issues: DependencyIssue[] = [
    {
      id: 'mock-software-issue-1',
      nodeId: 'node_mock_1',
      path: 'configs/settings.json',
      name: 'settings.json',
      role: 'config',
      health: 'missing',
      severity: 'blocking',
      title: '找不到这个配置文件',
      what: '程序启动时会读取 configs/settings.json，但现在这个位置没有文件。',
      why: '缺了配置文件，软件可能启动失败或使用默认设置。',
      fixHint: '从候选位置里选一个，或自己指定新的配置文件。',
      candidates: [
        {
          filePath: 'configs/settings.default.json',
          reason: 'similar-name',
          score: 74
        }
      ],
      references: [
        {
          filePath: 'ExampleApp.exe',
          line: 1,
          column: 1,
          ruleName: '配置路径字段',
          ruleCategory: 'config',
          rawText: 'configs/settings.json',
          context: '"config": "configs/settings.json"'
        }
      ],
      canAutoFix: true,
      canReselect: true,
      canRebuildCache: false,
      canSkip: true
    }
  ]
  return {
    projectId: project.id,
    projectName: project.name,
    projectRoot: project.rootPath,
    nodes: [],
    edges: [],
    issues,
    summary: {
      checkedFiles: 9,
      totalNodes: 12,
      totalEdges: 11,
      healthyNodes: 11,
      issueCount: issues.length,
      autoFixable: 1,
      ignoredCount: 0,
      roleCounts: { config: 4, source: 0, input: 3, cache: 0, output: 2, unknown: 3 }
    },
    warnings: [],
    durationMs: 520,
    budgetStopped: false,
    createdAt: new Date().toISOString()
  }
}

function mockSoftwareScan(
  project: Project,
  includeBinary: boolean,
  textScan: 'config' | 'all' | 'off' = 'config'
): SoftwareScanResult {
  const info = mockSoftwareInspect(project.entryPath ?? project.rootPath)
  const binaryDependencies = includeBinary
    ? [
        {
          name: 'vcruntime140.dll',
          resolvedPath: `${project.rootPath}\\vcruntime140.dll`,
          origin: 'app-local' as const,
          status: 'ok' as const,
          importedBy: ['ExampleApp.exe']
        },
        {
          name: 'kernel32.dll',
          resolvedPath: 'C:\\Windows\\System32\\kernel32.dll',
          origin: 'system' as const,
          status: 'ok' as const,
          importedBy: ['ExampleApp.exe']
        },
        {
          name: 'custom_engine.dll',
          resolvedPath: null,
          origin: 'app-local' as const,
          status: 'missing' as const,
          importedBy: ['ExampleApp.exe']
        },
        {
          name: 'vcruntime140_1.dll',
          resolvedPath: null,
          origin: 'system' as const,
          status: 'missing' as const,
          importedBy: ['ExampleApp.exe']
        }
      ]
    : []
  return {
    projectId: project.id,
    projectName: project.name,
    installRoot: project.rootPath,
    entryPath: project.entryPath,
    info: { ...info.info, entryPath: project.entryPath },
    binaryAnalysis: includeBinary ? 'analyzed' : 'not-analyzed',
    binaryFilesScanned: includeBinary ? ['ExampleApp.exe'] : [],
    binaryDependencies,
    binaryCapHit: false,
    textScanScope: textScan,
    textIssuesSkipped: textScan === 'config' ? 3 : 0,
    textIssuesTruncated: false,
    textReport: textScan === 'off' ? null : mockSoftwareTextReport(project),
    warnings: includeBinary
      ? ['动态加载的 DLL（运行时用 LoadLibrary 读取）无法静态发现，建议运行一次软件验证。']
      : ['当前未分析 exe/dll 导入表。'],
    durationMs: 1180,
    createdAt: new Date().toISOString()
  }
}

/**
 * In-browser stand-in for the preload bridge so the renderer can be reviewed
 * without Electron. It mimics delays and error envelopes but keeps readable,
 * realistic data. Never imported by the production bundle.
 */
export function createMockApi(): PathKeeperApi {
  let projects: Project[] = MOCK_PROJECTS.map((project) => ({ ...project }))
  let settings: AppSettings = copySettings(MOCK_SETTINGS)
  let rules: MatchRule[] = createSeedRules()
  let ignores: IgnoreRule[] = createSeedIgnores()
  let history: MigrationRecord[] = createSeedHistory()
  let backups: BackupRecord[] = createSeedBackups()
  let nextProjectId = Math.max(...projects.map((project) => project.id)) + 1
  let nextRuleId = Math.max(...rules.map((rule) => rule.id)) + 1
  let nextIgnoreId = Math.max(...ignores.map((rule) => rule.id)) + 1
  let lastScan: { result: ScanResult; project: Project } | null = null
  const progressHandlers = new Set<(progress: ScanProgress) => void>()

  const findProject = (projectId: number): Project => {
    const project = projects.find((item) => item.id === projectId)
    if (!project) fail('PROJECT_NOT_FOUND', '项目不存在，可能已被移除。')
    return project
  }

  const createProject = (name: string, rootPath: string, kind: Project['kind'] = 'project', entryPath: string | null = null): Project => {
    const project: Project = {
      id: nextProjectId++,
      name,
      rootPath,
      entryPath,
      kind,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    }
    projects = [...projects, project]
    return project
  }

  const emitProgress = (progress: Partial<ScanProgress>): void => {
    const next: ScanProgress = {
      phase: 'preparing',
      filesScanned: 0,
      filesTotal: 0,
      currentFile: null,
      percent: 0,
      ...progress
    }
    for (const handler of progressHandlers) handler(next)
  }

  const api: PathKeeperApi = {
    projects: {
      list: async () => {
        await sleep(120)
        return projects.map((project) => ({ ...project }))
      },
      add: async () => {
        await sleep(420)
        const created = createProject(`新建项目 ${projects.length + 1}`, `C:\\Users\\lin\\projects\\new-project-${projects.length + 1}`)
        settings = { ...settings, lastProjectId: created.id }
        return { ...created }
      },
      addFromPath: async (rootPath) => {
        await sleep(220)
        const existing = projects.find((project) => project.rootPath.toLowerCase() === rootPath.toLowerCase())
        const project = existing ?? createProject(baseName(rootPath) || 'project', rootPath)
        settings = { ...settings, lastProjectId: project.id }
        return { ...project }
      },
      remove: async (projectId) => {
        await sleep(220)
        if (!projects.some((project) => project.id === projectId)) {
          fail('PROJECT_NOT_FOUND', '项目不存在。')
        }
        projects = projects.filter((project) => project.id !== projectId)
        history = history.filter((record) => record.projectId !== projectId)
        backups = backups.filter((backup) => backup.projectId !== projectId)
        if (settings.lastProjectId === projectId) {
          settings = { ...settings, lastProjectId: projects[0]?.id ?? null }
        }
      },
      rename: async (projectId, name) => {
        await sleep(180)
        const trimmed = name.trim()
        if (!trimmed) fail('INVALID_NAME', '项目名称不能为空。')
        projects = projects.map((project) =>
          project.id === projectId ? { ...project, name: trimmed } : project
        )
        return { ...findProject(projectId) }
      },
      reveal: async () => {
        await sleep(160)
        console.info('[dev mock] 在资源管理器中显示项目目录')
      },
      loadSample: async () => {
        await sleep(600)
        const sample = createProject(
          '示例工程',
          `C:\\PathKeeperDemo\\beginner-sample-${Date.now()}`
        )
        settings = { ...settings, lastProjectId: sample.id }
        return { ...sample }
      }
    },

    settings: {
      get: async () => {
        await sleep(60)
        return copySettings(settings)
      },
      update: async (patch) => {
        await sleep(140)
        settings = {
          ...settings,
          ...patch,
          matchModes: patch.matchModes ? { ...patch.matchModes } : settings.matchModes
        }
        return copySettings(settings)
      }
    },

    paths: {
      preview: async (request) => {
        await sleep(260)
        return computePreview(request, findProject(request.projectId))
      }
    },

    autoCheck: async (projectId: number): Promise<AutoCheckResult> => {
      const project = findProject(projectId)
      await sleep(900)
      return {
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        checkedFiles: 12,
        skippedFiles: 3,
        referenceCount: 18,
        brokenReferenceCount: 4,
        groups: [
          {
            missingPath: DEMO_OLD_PATH,
            missingName: 'old_brick_wall.png',
            references: [
              {
                id: 'mock-ref-1',
                filePath: 'README.md',
                line: 23,
                column: 1,
                ruleName: 'Markdown 图片与链接',
                ruleCategory: 'markdown',
                rawText: DEMO_OLD_PATH,
                context: `![砖墙纹理](${DEMO_OLD_PATH})`
              },
              {
                id: 'mock-ref-2',
                filePath: 'scripts/preprocess.py',
                line: 11,
                column: 17,
                ruleName: '代码文件读写调用',
                ruleCategory: 'code',
                rawText: `../${DEMO_OLD_PATH}`,
                context: `with open("../${DEMO_OLD_PATH}", "rb") as handle:`
              }
            ],
            candidates: [
              {
                filePath: DEMO_NEW_PATH,
                reason: 'similar-name',
                score: 82
              }
            ]
          },
          {
            missingPath: 'assets/models/base_model.safetensors',
            missingName: 'base_model.safetensors',
            references: [
              {
                id: 'mock-ref-3',
                filePath: 'configs/pipeline.json',
                line: 8,
                column: 17,
                ruleName: '配置路径字段',
                ruleCategory: 'config',
                rawText: 'assets/models/base_model.safetensors',
                context: '"model_path": "assets/models/base_model.safetensors"'
              }
            ],
            candidates: [
              {
                filePath: 'assets/models/dreamshaper_8.safetensors',
                reason: 'similar-name',
                score: 61
              }
            ]
          }
        ],
        warnings: [],
        durationMs: 238,
        budgetStopped: false,
        createdAt: new Date().toISOString()
      }
    },

    dependencies: {
      scan: async (projectId: number): Promise<DependencyScanResult> => {
        const project = findProject(projectId)
        await sleep(700)
        return {
          projectId: project.id,
          projectName: project.name,
          projectRoot: project.rootPath,
          nodes: [],
          edges: [],
          issues: [],
          summary: {
            checkedFiles: 0,
            totalNodes: 0,
            totalEdges: 0,
            healthyNodes: 0,
            issueCount: 0,
            autoFixable: 0,
            ignoredCount: 0,
            roleCounts: {
              config: 0,
              source: 0,
              input: 0,
              cache: 0,
              output: 0,
              unknown: 0
            }
          },
          warnings: [],
          durationMs: 640,
          budgetStopped: false,
          createdAt: new Date().toISOString()
        }
      },
      changes: async (): Promise<DependencyChangesResult> => ({
        changed: false,
        changes: [],
        checkedAt: new Date().toISOString()
      }),
      startWatch: async () => undefined,
      stopWatch: async () => undefined,
      validateFix: async (request: DependencyValidateFixRequest): Promise<DependencyValidation> => ({
        valid: true,
        errors: [],
        warnings: [],
        oldPath: request.oldPath,
        newPath: request.newPath
      }),
      repair: async (request: DependencyValidateFixRequest): Promise<DependencyRepairResult> => ({
        fixedIssuePath: request.oldPath,
        newPath: request.newPath,
        changedFiles: 1,
        replacements: 1,
        backupId: 1,
        backupDir: 'C:\\PathKeeperDemo\\backup',
        remainingIssueCount: 0
      }),
      rebuildCache: async (projectId: number, paths: string[]): Promise<DependencyCacheRebuildResult> => {
        findProject(projectId)
        return {
          movedFiles: paths.length,
          backupDir: 'C:\\PathKeeperDemo\\backup\\dependency-cache',
          paths
        }
      },
      ignore: async (projectId: number, path: string, ignored: boolean): Promise<DependencyIgnoreResult> => {
        findProject(projectId)
        return { ignoredPath: path, ignored }
      }
    },

    software: {
      pick: async (mode: SoftwarePickMode): Promise<SoftwareInspectResult | null> => {
        await sleep(420)
        return mockSoftwareInspect(mode === 'file' ? MOCK_SOFTWARE_ENTRY : MOCK_SOFTWARE_ROOT)
      },
      inspect: async (absPath: string): Promise<SoftwareInspectResult> => {
        await sleep(260)
        if (!absPath.trim()) fail('SOFTWARE_TARGET_INVALID', '请选择一个程序或安装目录。')
        return mockSoftwareInspect(absPath)
      },
      add: async (request: SoftwareAddRequest): Promise<Project> => {
        await sleep(320)
        const inspected = mockSoftwareInspect(request.entryPath ?? request.rootPath)
        const existing = projects.find(
          (project) => project.rootPath.toLowerCase() === inspected.rootPath.toLowerCase()
        )
        if (existing) {
          projects = projects.map((project) =>
            project.id === existing.id
              ? { ...project, kind: 'software' as const, entryPath: inspected.entryPath }
              : project
          )
          const updated = findProject(existing.id)
          settings = { ...settings, lastProjectId: updated.id }
          return { ...updated }
        }
        const created = createProject(
          request.name?.trim() ||
            inspected.info.productName ||
            baseName(inspected.rootPath) ||
            '未命名软件',
          inspected.rootPath,
          'software',
          inspected.entryPath
        )
        settings = { ...settings, lastProjectId: created.id }
        return { ...created }
      },
      scan: async (request: SoftwareScanRequest): Promise<SoftwareScanResult> => {
        const project = findProject(request.projectId)
        await sleep(1200)
        return mockSoftwareScan(
          project,
          request.includeBinary !== false,
          request.textScan === 'all' || request.textScan === 'off' ? request.textScan : 'config'
        )
      }
    },

    files: {
      preview: async (projectId: number, relativePath: string): Promise<FilePreview> => {
        findProject(projectId)
        await sleep(90)
        const lower = relativePath.toLowerCase()
        if (/\.(png|jpe?g|webp|gif|bmp|ico)$/.test(lower)) {
          return { kind: 'image', dataUrl: MOCK_THUMBNAIL, lines: [], size: 48_213, reason: null }
        }
        if (/\.(json|ya?ml|toml|ini|cfg|txt|md|py|js|ts|tsx|css|html)$/.test(lower)) {
          return {
            kind: 'text',
            dataUrl: null,
            lines: ['{', '  "示例": "演示模式只展示占位内容"', '}'],
            size: 1024,
            reason: null
          }
        }
        return {
          kind: 'unavailable',
          dataUrl: null,
          lines: [],
          size: 0,
          reason: '演示模式无法预览这个文件。'
        }
      }
    },

    scan: async (request: ScanRequest): Promise<ScanResult> => {
      const project = findProject(request.projectId)
      const pathInfo = computePreview(request, project)
      emitProgress({ phase: 'preparing', percent: 3, currentFile: '读取匹配规则与忽略配置…' })
      await sleep(180)
      emitProgress({ phase: 'walking', percent: 9, currentFile: project.rootPath })
      await sleep(220)
      for (const [index, file] of SAMPLE_SCAN_FILE_NAMES.slice(0, 8).entries()) {
        emitProgress({
          phase: 'scanning',
          filesScanned: index + 1,
          filesTotal: 12,
          percent: 14 + index * 10,
          currentFile: file
        })
        await sleep(95)
      }
      emitProgress({
        phase: 'scanning',
        filesScanned: 11,
        filesTotal: 12,
        percent: 92,
        currentFile: 'notes/field-notes.txt'
      })
      await sleep(110)
      emitProgress({
        phase: 'finalizing',
        filesScanned: 12,
        filesTotal: 12,
        percent: 97,
        currentFile: '生成结果与文件指纹…'
      })
      await sleep(150)
      emitProgress({ phase: 'finalizing', filesScanned: 12, filesTotal: 12, percent: 100 })

      const result: ScanResult = {
        scanToken: `mock-scan-${Date.now()}`,
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        oldPathInput: request.oldPath.trim(),
        newPathInput: request.newPath.trim(),
        pathInfo,
        modes: request.modes ? { ...request.modes } : { ...settings.matchModes },
        items: request.oldPath.toLowerCase().includes('no-match') ? [] : createSampleOccurrences(),
        scannedFiles: 46,
        candidateFiles: 32,
        skippedFiles: 3,
        ignoredFiles: 118,
        durationMs: 1462,
        warnings: [
          'configs/dataset.json 中的相对路径无法解析为项目内路径，已按文件名匹配兜底。',
          'assets/models/dreamshaper_8.safetensors 超过单个文件大小上限，已跳过。'
        ],
        budgetStopped: false,
        createdAt: new Date().toISOString()
      }
      lastScan = { result, project }
      return result
    },

    scanCancel: async (): Promise<void> => {
      emitProgress({ phase: 'finalizing', percent: 100 })
    },

    apply: async ({ scanToken, occurrenceIds }): Promise<ApplyResult> => {
      await sleep(780)
      if (!lastScan || lastScan.result.scanToken !== scanToken) {
        fail('SCAN_EXPIRED', '本次扫描结果已过期，请重新扫描。')
      }
      if (occurrenceIds.length === 0) fail('EMPTY_SELECTION', '没有选中任何行。')
      const selectedSet = new Set(occurrenceIds)
      const selected = lastScan.result.items.filter((item) => selectedSet.has(item.id))
      if (selected.length === 0) fail('EMPTY_SELECTION', '选中的行不在本次扫描结果中。')
      const project = lastScan.project
      const files = [...new Set(selected.map((item) => item.filePath))]
      const now = new Date()
      const pad = (value: number): string => String(value).padStart(2, '0')
      const dirName = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
        now.getHours()
      )}${pad(now.getMinutes())}-brick`
      const backupDir = `${project.rootPath}\\.pathkeeper-backup\\${dirName}`
      const backupId = Math.max(0, ...backups.map((backup) => backup.id)) + 1
      const migrationId = Math.max(0, ...history.map((record) => record.id)) + 1
      const fileRecords = files.map((filePath, index) => ({
        id: 900 + index,
        migrationId,
        filePath,
        backupPath: `.pathkeeper-backup/${dirName}/${filePath}`,
        preHash: 'mock-pre-hash',
        postHash: 'mock-post-hash',
        replacements: selected.filter((item) => item.filePath === filePath).length
      }))
      backups = [
        {
          id: backupId,
          projectId: project.id,
          migrationId,
          dirName,
          absPath: backupDir,
          filesCount: files.length,
          sizeBytes: files.length * 24_576,
          createdAt: now.toISOString(),
          missing: false,
          orphaned: false
        },
        ...backups
      ]
      const record: MigrationRecord = {
        id: migrationId,
        projectId: project.id,
        oldPath: lastScan.result.oldPathInput,
        newPath: lastScan.result.newPathInput,
        kind: lastScan.result.pathInfo.kind,
        modes: { ...lastScan.result.modes },
        filesChanged: files.length,
        replacements: selected.length,
        status: 'applied',
        backupId,
        backupDir,
        backupRemoved: false,
        backupMissing: false,
        error: null,
        createdAt: now.toISOString(),
        rolledBackAt: null,
        files: fileRecords
      }
      history = [record, ...history]
      lastScan = null
      return {
        migrationId,
        backupId,
        filesChanged: files.length,
        replacements: selected.length,
        backupDir,
        skipped: []
      }
    },

    history: {
      list: async (projectId) => {
        await sleep(200)
        return history
          .filter((record) => record.projectId === projectId)
          .map((record) => ({ ...record, files: record.files.map((file) => ({ ...file })) }))
      },
      rollback: async (migrationId): Promise<RollbackResult> => {
        await sleep(720)
        const record = history.find((item) => item.id === migrationId)
        if (!record) fail('MIGRATION_NOT_FOUND', '迁移记录不存在。')
        if (record.status !== 'applied') fail('INVALID_STATUS', '只有已应用的迁移可以回滚。')
        if (record.backupMissing) fail('BACKUP_MISSING', '备份文件缺失，无法回滚。')
        if (record.backupRemoved) fail('BACKUP_REMOVED', '备份已被删除，无法回滚。')
        record.status = 'rolled_back'
        record.rolledBackAt = new Date().toISOString()
        return {
          migrationId,
          filesRestored: record.filesChanged,
          backupDir: record.backupDir ?? ''
        }
      },
      remove: async (migrationId) => {
        await sleep(280)
        const record = history.find((item) => item.id === migrationId)
        if (!record) fail('MIGRATION_NOT_FOUND', '迁移记录不存在。')
        history = history.filter((item) => item.id !== migrationId)
        backups = backups.map((backup) =>
          backup.migrationId === migrationId
            ? { ...backup, migrationId: null, orphaned: true }
            : backup
        )
      }
    },

    backups: {
      list: async (projectId) => {
        await sleep(180)
        return backups.filter((backup) => backup.projectId === projectId).map((backup) => ({ ...backup }))
      },
      remove: async (backupId) => {
        await sleep(280)
        if (!backups.some((backup) => backup.id === backupId)) fail('BACKUP_NOT_FOUND', '备份不存在。')
        backups = backups.filter((backup) => backup.id !== backupId)
        history = history.map((record) =>
          record.backupId === backupId ? { ...record, backupRemoved: true } : record
        )
      },
      reveal: async (backupId) => {
        await sleep(180)
        const backup = backups.find((item) => item.id === backupId)
        if (!backup) fail('BACKUP_NOT_FOUND', '备份不存在。')
        if (backup.missing) fail('BACKUP_MISSING', '备份目录已缺失。')
        console.info('[dev mock] 打开备份目录', backup.absPath)
      }
    },

    rules: {
      list: async (projectId) => {
        await sleep(180)
        return rules
          .filter((rule) => rule.builtin || rule.projectId === projectId || rule.projectId === 1)
          .map((rule) => ({ ...rule, projectId }))
      },
      add: async (projectId, input: RuleInput) => {
        await sleep(280)
        const created: MatchRule = {
          id: nextRuleId++,
          projectId,
          ruleKey: `custom-${nextRuleId}`,
          name: input.name,
          description: input.description,
          category: input.category,
          pattern: input.pattern,
          flags: input.flags,
          enabled: input.enabled,
          builtin: false,
          priority: input.priority ?? 50,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        rules = [...rules, created]
        return { ...created }
      },
      update: async (ruleId, patch) => {
        await sleep(240)
        const existing = rules.find((rule) => rule.id === ruleId)
        if (!existing) fail('RULE_NOT_FOUND', '匹配规则不存在。')
        rules = rules.map((rule) =>
          rule.id === ruleId ? { ...rule, ...patch, updatedAt: new Date().toISOString() } : rule
        )
        return { ...(rules.find((rule) => rule.id === ruleId) ?? existing) }
      },
      remove: async (ruleId) => {
        await sleep(220)
        if (!rules.some((rule) => rule.id === ruleId)) fail('RULE_NOT_FOUND', '匹配规则不存在。')
        rules = rules.filter((rule) => rule.id !== ruleId)
      },
      reset: async (projectId) => {
        await sleep(380)
        rules = createSeedRules()
        return rules.map((rule) => ({ ...rule, projectId }))
      },
      validate: async (pattern, flags) => {
        await sleep(120)
        return validatePattern(pattern, flags)
      },
      test: async (pattern, flags, sample) => {
        await sleep(180)
        return testPattern(pattern, flags, sample)
      }
    },

    ignores: {
      list: async (projectId) => {
        await sleep(160)
        return ignores.map((rule) => ({ ...rule, projectId }))
      },
      add: async (projectId, input: IgnoreInput) => {
        await sleep(220)
        const created: IgnoreRule = {
          id: nextIgnoreId++,
          projectId,
          pattern: input.pattern,
          kind: input.kind,
          label: input.label ?? input.pattern,
          enabled: input.enabled ?? true,
          builtin: false,
          sortOrder: 900 + nextIgnoreId,
          createdAt: new Date().toISOString()
        }
        ignores = [...ignores, created]
        return { ...created, projectId }
      },
      update: async (ruleId, patch) => {
        await sleep(180)
        if (!ignores.some((rule) => rule.id === ruleId)) fail('IGNORE_NOT_FOUND', '忽略规则不存在。')
        ignores = ignores.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule))
        const updated = ignores.find((rule) => rule.id === ruleId)
        if (!updated) fail('IGNORE_NOT_FOUND', '忽略规则不存在。')
        return { ...updated }
      },
      remove: async (ruleId) => {
        await sleep(180)
        if (!ignores.some((rule) => rule.id === ruleId)) fail('IGNORE_NOT_FOUND', '忽略规则不存在。')
        ignores = ignores.filter((rule) => rule.id !== ruleId)
      },
      reset: async (projectId) => {
        await sleep(320)
        ignores = createSeedIgnores()
        return ignores.map((rule) => ({ ...rule, projectId }))
      }
    },

    dialogs: {
      pickProjectPath: async (request: PickPathRequest): Promise<SelectedPath | null> => {
        await sleep(340)
        const project = findProject(request.projectId)
        const wantsDirectory = request.kind === 'directory'
        const relPath = wantsDirectory
          ? 'assets/textures'
          : request.side === 'old'
            ? DEMO_OLD_PATH
            : DEMO_NEW_PATH
        return {
          absPath: `${project.rootPath}\\${relPath.replace(/\//g, '\\')}`,
          relPath,
          exists: request.side === 'old',
          kind: request.kind
        }
      },
      saveTextFile: async (request: SaveTextRequest): Promise<string | null> => {
        await sleep(520)
        console.info('[dev mock] CSV 导出长度', request.content.length)
        return `C:\\Users\\lin\\Desktop\\${request.defaultName}`
      }
    },

    system: {
      info: async () => {
        await sleep(120)
        return { ...MOCK_SYSTEM_INFO }
      },
      showProjectFile: async (_projectId, relativePath) => {
        await sleep(160)
        console.info('[dev mock] 定位文件', relativePath)
      }
    },

    events: {
      onScanProgress: (handler) => {
        progressHandlers.add(handler)
        return () => {
          progressHandlers.delete(handler)
        }
      },
      onDependenciesChanged: () => () => undefined
    }
  }

  // Keep the demo defaults reachable for the initial composer prefill in dev.
  return api
}
