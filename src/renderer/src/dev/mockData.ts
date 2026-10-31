import type {
  AppSettings,
  BackupRecord,
  IgnoreRule,
  MatchRule,
  MigrationRecord,
  Project,
  ScanOccurrence,
  SystemInfo
} from '@shared/types'

/**
 * Dev-only fixtures for `npm run dev:renderer`. The production renderer always
 * talks to the real preload bridge; nothing here is bundled into the app path.
 */

export const DEMO_ROOT = 'C:\\projects\\demo-project'
export const DEMO_OLD_PATH = 'assets/textures/old_brick_wall.png'
export const DEMO_NEW_PATH = 'assets/materials/brick_wall.png'

const CREATED = '2026-10-20T02:00:00.000Z'

export const MOCK_PROJECTS: Project[] = [
  {
    id: 1,
    name: 'demo-project',
    rootPath: DEMO_ROOT,
    entryPath: null,
    kind: 'project',
    createdAt: CREATED,
    lastOpenedAt: '2026-10-29T02:40:00.000Z'
  },
  {
    id: 2,
    name: 'brand-assets',
    rootPath: 'C:\\Users\\lin\\projects\\brand-assets',
    entryPath: null,
    kind: 'project',
    createdAt: '2026-10-12T06:30:00.000Z',
    lastOpenedAt: '2026-10-24T08:10:00.000Z'
  },
  {
    id: 3,
    name: '示例软件 App',
    rootPath: 'C:\\Program Files\\ExampleApp',
    entryPath: 'C:\\Program Files\\ExampleApp\\ExampleApp.exe',
    kind: 'software',
    createdAt: '2026-10-18T03:20:00.000Z',
    lastOpenedAt: '2026-10-28T09:05:00.000Z'
  }
]

export const MOCK_SOFTWARE_ROOT = 'C:\\Program Files\\ExampleApp'
export const MOCK_SOFTWARE_ENTRY = 'C:\\Program Files\\ExampleApp\\ExampleApp.exe'

export const MOCK_SETTINGS: AppSettings = {
  lastProjectId: 1,
  matchModes: { strict: true, basename: true, directory: true },
  caseSensitive: false,
  maxFileSizeKb: 1_048_576,
  beginnerMode: true,
  dependencyCheckEnabled: true,
  dependencyAutoScanOnOpen: true,
  dependencyAutoWatch: true,
  dependencyAutoRepair: true
}

export const MOCK_SYSTEM_INFO: SystemInfo = {
  appVersion: '2.1.2',
  electronVersion: '45.1.0',
  nodeVersion: '24.9.0',
  chromeVersion: '142.0.7444.59',
  platform: 'win32',
  userDataPath: 'C:\\Users\\lin\\AppData\\Roaming\\PathKeeper'
}

function matchRule(
  id: number,
  ruleKey: string,
  name: string,
  description: string,
  category: MatchRule['category'],
  pattern: string,
  flags: string,
  priority: number,
  builtin = true
): MatchRule {
  return {
    id,
    projectId: 1,
    ruleKey,
    name,
    description,
    category,
    pattern,
    flags,
    enabled: true,
    builtin,
    priority,
    createdAt: CREATED,
    updatedAt: CREATED
  }
}

export function createSeedRules(): MatchRule[] {
  return [
    matchRule(
      1,
      'workflow-comfyui',
      'AI 工作流字段',
      'ComfyUI / 工作流 JSON 中的 filename、ckpt_name、lora_name 等字段。',
      'workflow',
      String.raw`"(?:filename|subfolder|ckpt_name|lora_name|vae_name|image|mask|audio|video|file|path)"\s*:\s*"(?<path>(?:[^"\\\r\n]|\\.)+)"`,
      'gi',
      110
    ),
    matchRule(
      2,
      'markdown-link',
      'Markdown 图片与链接',
      'Markdown 中的 [文本](路径) 与 ![图片](路径)。',
      'markdown',
      String.raw`!?\[[^\]\r\n]*\]\(\s*<?(?<path>[^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)`,
      'gm',
      100
    ),
    matchRule(
      3,
      'web-assets',
      'HTML / Vue 资源属性',
      'src、href、poster、data-src 等标签属性中的资源路径。',
      'web',
      String.raw`\b(?:src|href|poster|data-src|data-original)\s*=\s*["'](?<path>[^"'\r\n]+)["']`,
      'gi',
      100
    ),
    matchRule(
      4,
      'code-file-api',
      '代码文件读写调用',
      'open / readFile / load / imread 等调用的手写路径。',
      'code',
      String.raw`\b(?:open|readFile|readFileSync|writeFile|writeFileSync|source|load|imread|Image\.open|json\.load)\s*\(\s*[rbfu]?["'\x60](?<path>[^"'\x60\r\n]+)["'\x60]`,
      'gi',
      95
    ),
    matchRule(
      5,
      'config-path-field',
      '配置路径字段',
      'JSON / YAML / TOML 配置中以 path、file、dir、texture 等命名的字段。',
      'config',
      String.raw`^[\t ]*(?:[\w.-]*(?:path|file|dir|folder|source|target|input|output|model|[Tt]exture|image|dataset)[\w.-]*)[\t ]*[:=][\t ]*["'](?<path>[^"'\r\n]+)["']`,
      'gim',
      90
    ),
    matchRule(
      6,
      'quoted-rooted-path',
      '引号内的绝对 / 上级路径',
      '任意文本中带引号的绝对路径、./ 或 ../ 开头的路径。',
      'text',
      String.raw`["'\x60](?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|/)[^"'\x60\r\n]*\.[A-Za-z0-9]{1,12})["'\x60]`,
      'g',
      80
    ),
    matchRule(
      7,
      'quoted-relative-path',
      '引号内的相对路径',
      '任意文本中带目录分隔符、带引号的相对路径。',
      'text',
      String.raw`["'\x60](?<path>[^"'\x60\r\n]*[\\/][^"'\x60\r\n]*\.[A-Za-z0-9]{1,12})["'\x60]`,
      'g',
      70
    ),
    matchRule(
      8,
      'plain-path-token',
      '普通文本中的裸路径',
      '没有引号、带目录分隔符的路径片段，用于纯文本、脚本和日志。',
      'text',
      String.raw`(?<![\w"'=<>])(?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|/)?(?:[\w.$@~-]+[\\/])+[\w.$@~-]+\.[A-Za-z0-9]{1,12})(?![\w"'<>])`,
      'g',
      30
    ),
    matchRule(
      9,
      'custom-env-path',
      '环境变量路径',
      '自定义：识别以 %VAR% 或 $env: 开头的 Windows 环境变量路径。',
      'custom',
      String.raw`(?<path>(?:%[A-Z_]+%|\$env:[A-Za-z_]+)[\\/][^"'\s]*\.[A-Za-z0-9]{1,12})`,
      'gi',
      60,
      false
    ),
    matchRule(
      10,
      'custom-url-to-file',
      'URL 中的本地文件',
      '自定义：识别 file:/// 形式的本地文件 URL。',
      'custom',
      String.raw`file:///(?<path>[^"'\s)]+)`,
      'gi',
      55,
      false
    )
  ]
}

export function createSeedIgnores(): IgnoreRule[] {
  const dirs: Array<[string, string]> = [
    ['.git', 'Git 元数据'],
    ['.svn', 'SVN 元数据'],
    ['node_modules', 'Node 依赖'],
    ['dist', '构建产物'],
    ['build', '构建产物'],
    ['.next', 'Next.js 构建产物'],
    ['.venv', 'Python 虚拟环境'],
    ['venv', 'Python 虚拟环境'],
    ['__pycache__', 'Python 字节码'],
    ['.idea', 'JetBrains 配置'],
    ['.pathkeeper-backup', 'PathKeeper 备份'],
    ['.cache', '本地缓存']
  ]
  const suffixes: string[] = [
    '.exe',
    '.dll',
    '.msi',
    '.bin',
    '.pyc',
    '.zip',
    '.7z',
    '.mp4',
    '.mkv',
    '.mp3',
    '.wav',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.psd',
    '.pdf',
    '.safetensors',
    '.ckpt',
    '.onnx',
    '.zipx',
    '.ttf',
    '.woff2'
  ]
  const createdAt = CREATED
  let id = 1
  let sortOrder = 0
  const rules: IgnoreRule[] = []
  for (const [pattern, label] of dirs) {
    rules.push({
      id: id++,
      projectId: 1,
      pattern,
      kind: 'dir',
      label,
      enabled: pattern !== '.cache',
      builtin: true,
      sortOrder: sortOrder++,
      createdAt
    })
  }
  for (const pattern of suffixes) {
    rules.push({
      id: id++,
      projectId: 1,
      pattern,
      kind: 'suffix',
      label: '二进制 / 媒体文件',
      enabled: true,
      builtin: true,
      sortOrder: sortOrder++,
      createdAt
    })
  }
  rules.push({
    id: id++,
    projectId: 1,
    pattern: '*.min.js',
    kind: 'glob',
    label: '压缩后的脚本',
    enabled: true,
    builtin: false,
    sortOrder: sortOrder++,
    createdAt
  })
  rules.push({
    id: id++,
    projectId: 1,
    pattern: 'logs',
    kind: 'dir',
    label: '运行日志',
    enabled: true,
    builtin: false,
    sortOrder: sortOrder++,
    createdAt
  })
  return rules
}

function migrationFile(
  id: number,
  migrationId: number,
  filePath: string,
  replacements: number,
  backupName: string
): MigrationRecord['files'][number] {
  return {
    id,
    migrationId,
    filePath,
    backupPath: `.pathkeeper-backup/${backupName}/${filePath}`,
    preHash: '3f9c6a1b8d4e2f5079a1c3b5d7e9f102',
    postHash: '8a1d3f5b7c9e0a2b4d6f8e0c1a3b5d7',
    replacements
  }
}

export function createSeedHistory(): MigrationRecord[] {
  return [
    {
      id: 12,
      projectId: 1,
      oldPath: 'assets/textures/old_brick_wall.png',
      newPath: 'assets/materials/brick_wall.png',
      kind: 'file',
      modes: { strict: true, basename: true, directory: true },
      filesChanged: 8,
      replacements: 14,
      status: 'applied',
      backupId: 5,
      backupDir: `${DEMO_ROOT}\\.pathkeeper-backup\\20261029-1014-brick`,
      backupRemoved: false,
      backupMissing: false,
      error: null,
      createdAt: '2026-10-29T02:14:08.000Z',
      rolledBackAt: null,
      files: [
        migrationFile(31, 12, 'README.md', 3, '20261029-1014-brick'),
        migrationFile(32, 12, 'workflows/comfyui_workflow.json', 2, '20261029-1014-brick'),
        migrationFile(33, 12, 'scripts/preprocess.py', 2, '20261029-1014-brick'),
        migrationFile(34, 12, 'web/index.html', 1, '20261029-1014-brick'),
        migrationFile(35, 12, 'configs/pipeline.yaml', 1, '20261029-1014-brick')
      ]
    },
    {
      id: 11,
      projectId: 1,
      oldPath: 'datasets/raw/images',
      newPath: 'datasets/processed/images',
      kind: 'directory',
      modes: { strict: true, basename: false, directory: true },
      filesChanged: 5,
      replacements: 5,
      status: 'applied',
      backupId: 4,
      backupDir: `${DEMO_ROOT}\\.pathkeeper-backup\\20261028-1630-dataset`,
      backupRemoved: false,
      backupMissing: true,
      error: null,
      createdAt: '2026-10-28T08:30:41.000Z',
      rolledBackAt: null,
      files: [
        migrationFile(21, 11, 'configs/dataset.json', 2, '20261028-1630-dataset'),
        migrationFile(22, 11, 'scripts/preprocess.py', 1, '20261028-1630-dataset'),
        migrationFile(23, 11, 'notes/field-notes.txt', 2, '20261028-1630-dataset')
      ]
    },
    {
      id: 9,
      projectId: 1,
      oldPath: 'configs/old_pipeline.yaml',
      newPath: 'configs/pipeline.yaml',
      kind: 'file',
      modes: { strict: true, basename: true, directory: true },
      filesChanged: 2,
      replacements: 3,
      status: 'rolled_back',
      backupId: 3,
      backupDir: `${DEMO_ROOT}\\.pathkeeper-backup\\20261026-0915-config`,
      backupRemoved: false,
      backupMissing: false,
      error: null,
      createdAt: '2026-10-26T01:15:22.000Z',
      rolledBackAt: '2026-10-26T02:02:10.000Z',
      files: [
        migrationFile(11, 9, 'scripts/render.js', 2, '20261026-0915-config'),
        migrationFile(12, 9, 'README.md', 1, '20261026-0915-config')
      ]
    },
    {
      id: 8,
      projectId: 1,
      oldPath: 'assets/textures/old_brick_normal.png',
      newPath: 'assets/materials/brick_normal.png',
      kind: 'file',
      modes: { strict: true, basename: true, directory: false },
      filesChanged: 0,
      replacements: 0,
      status: 'failed',
      backupId: null,
      backupDir: null,
      backupRemoved: false,
      backupMissing: false,
      error: '写入前检查失败：scripts/render.js 在扫描后被其他程序修改，本次写入已整体中止。',
      createdAt: '2026-10-25T06:44:03.000Z',
      rolledBackAt: null,
      files: []
    }
  ]
}

export function createSeedBackups(): BackupRecord[] {
  return [
    {
      id: 5,
      projectId: 1,
      migrationId: 12,
      dirName: '20261029-1014-brick',
      absPath: `${DEMO_ROOT}\\.pathkeeper-backup\\20261029-1014-brick`,
      filesCount: 8,
      sizeBytes: 1_486_208,
      createdAt: '2026-10-29T02:14:09.000Z',
      missing: false,
      orphaned: false
    },
    {
      id: 4,
      projectId: 1,
      migrationId: 11,
      dirName: '20261028-1630-dataset',
      absPath: `${DEMO_ROOT}\\.pathkeeper-backup\\20261028-1630-dataset`,
      filesCount: 5,
      sizeBytes: 902_112,
      createdAt: '2026-10-28T08:30:42.000Z',
      missing: true,
      orphaned: false
    },
    {
      id: 3,
      projectId: 1,
      migrationId: 9,
      dirName: '20261026-0915-config',
      absPath: `${DEMO_ROOT}\\.pathkeeper-backup\\20261026-0915-config`,
      filesCount: 2,
      sizeBytes: 12_288,
      createdAt: '2026-10-26T01:15:23.000Z',
      missing: false,
      orphaned: false
    },
    {
      id: 2,
      projectId: 1,
      migrationId: null,
      dirName: '20261022-1402-orphan',
      absPath: `${DEMO_ROOT}\\.pathkeeper-backup\\20261022-1402-orphan`,
      filesCount: 3,
      sizeBytes: 48_000,
      createdAt: '2026-10-22T06:02:11.000Z',
      missing: false,
      orphaned: true
    }
  ]
}

interface OccurrenceSeed {
  filePath: string
  line: number
  column: number
  ruleId: number
  ruleKey: string
  ruleName: string
  ruleCategory: ScanOccurrence['ruleCategory']
  matchMode: ScanOccurrence['matchMode']
  oldText: string
  newText: string
  context: string
}

const OCCURRENCE_SEEDS: OccurrenceSeed[] = [
  {
    filePath: 'README.md',
    line: 14,
    column: 8,
    ruleId: 2,
    ruleKey: 'markdown-link',
    ruleName: 'Markdown 图片与链接',
    ruleCategory: 'markdown',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '![砖墙纹理](assets/textures/old_brick_wall.png)，旧的材质路径曾写在这里。'
  },
  {
    filePath: 'README.md',
    line: 18,
    column: 32,
    ruleId: 7,
    ruleKey: 'quoted-relative-path',
    ruleName: '引号内的相对路径',
    ruleCategory: 'text',
    matchMode: 'strict',
    oldText: './assets/textures/old_brick_wall.png',
    newText: './assets/materials/brick_wall.png',
    context: '旧路径也出现在行内代码里：`./assets/textures/old_brick_wall.png`。'
  },
  {
    filePath: 'README.md',
    line: 23,
    column: 5,
    ruleId: 2,
    ruleKey: 'markdown-link',
    ruleName: 'Markdown 图片与链接',
    ruleCategory: 'markdown',
    matchMode: 'basename',
    oldText: 'old_brick_wall.png',
    newText: 'brick_wall.png',
    context: '历史截图：`old_brick_wall.png` 被多次引用在文档里。'
  },
  {
    filePath: 'web/index.html',
    line: 18,
    column: 10,
    ruleId: 3,
    ruleKey: 'web-assets',
    ruleName: 'HTML / Vue 资源属性',
    ruleCategory: 'web',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '<img src="assets/textures/old_brick_wall.png" alt="砖墙材质预览" />'
  },
  {
    filePath: 'workflows/comfyui_workflow.json',
    line: 7,
    column: 17,
    ruleId: 1,
    ruleKey: 'workflow-comfyui',
    ruleName: 'AI 工作流字段',
    ruleCategory: 'workflow',
    matchMode: 'strict',
    oldText: 'assets\\\\textures\\\\old_brick_wall.png',
    newText: 'assets\\\\materials\\\\brick_wall.png',
    context: '"filename": "assets\\textures\\old_brick_wall.png",'
  },
  {
    filePath: 'workflows/comfyui_workflow.json',
    line: 25,
    column: 21,
    ruleId: 1,
    ruleKey: 'workflow-comfyui',
    ruleName: 'AI 工作流字段',
    ruleCategory: 'workflow',
    matchMode: 'basename',
    oldText: 'old_brick_wall.png',
    newText: 'brick_wall.png',
    context: '"mask_name": "old_brick_wall.png",'
  },
  {
    filePath: 'configs/pipeline.json',
    line: 5,
    column: 17,
    ruleId: 5,
    ruleKey: 'config-path-field',
    ruleName: '配置路径字段',
    ruleCategory: 'config',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '  "texture_path": "assets/textures/old_brick_wall.png",'
  },
  {
    filePath: 'configs/pipeline.yaml',
    line: 9,
    column: 16,
    ruleId: 5,
    ruleKey: 'config-path-field',
    ruleName: '配置路径字段',
    ruleCategory: 'config',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '  texture_path: "assets/textures/old_brick_wall.png"'
  },
  {
    filePath: 'configs/dataset.json',
    line: 12,
    column: 21,
    ruleId: 5,
    ruleKey: 'config-path-field',
    ruleName: '配置路径字段',
    ruleCategory: 'config',
    matchMode: 'basename',
    oldText: 'old_brick_wall.png',
    newText: 'brick_wall.png',
    context: '  "texture_file": "old_brick_wall.png",'
  },
  {
    filePath: 'scripts/preprocess.py',
    line: 23,
    column: 25,
    ruleId: 4,
    ruleKey: 'code-file-api',
    ruleName: '代码文件读写调用',
    ruleCategory: 'code',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '    texture = Image.open("assets/textures/old_brick_wall.png")'
  },
  {
    filePath: 'scripts/preprocess.py',
    line: 57,
    column: 17,
    ruleId: 4,
    ruleKey: 'code-file-api',
    ruleName: '代码文件读写调用',
    ruleCategory: 'code',
    matchMode: 'basename',
    oldText: 'old_brick_wall.png',
    newText: 'brick_wall.png',
    context: '    mask = Image.open("old_brick_wall.png").convert("L")'
  },
  {
    filePath: 'scripts/render.js',
    line: 31,
    column: 23,
    ruleId: 4,
    ruleKey: 'code-file-api',
    ruleName: '代码文件读写调用',
    ruleCategory: 'code',
    matchMode: 'strict',
    oldText: './assets/textures/old_brick_wall.png',
    newText: './assets/materials/brick_wall.png',
    context: "const texture = load('./assets/textures/old_brick_wall.png')"
  },
  {
    filePath: 'styles/preview.css',
    line: 12,
    column: 21,
    ruleId: 8,
    ruleKey: 'plain-path-token',
    ruleName: '普通文本中的裸路径',
    ruleCategory: 'text',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '  background-image: url(assets/textures/old_brick_wall.png);'
  },
  {
    filePath: 'notes/field-notes.txt',
    line: 4,
    column: 9,
    ruleId: 6,
    ruleKey: 'quoted-rooted-path',
    ruleName: '引号内的绝对 / 上级路径',
    ruleCategory: 'text',
    matchMode: 'strict',
    oldText: 'C:\\projects\\demo-project\\assets\\textures\\old_brick_wall.png',
    newText: 'C:\\projects\\demo-project\\assets\\materials\\brick_wall.png',
    context: '绝对路径检查："C:\\projects\\demo-project\\assets\\textures\\old_brick_wall.png"'
  },
  {
    filePath: 'notes/field-notes.txt',
    line: 9,
    column: 16,
    ruleId: 8,
    ruleKey: 'plain-path-token',
    ruleName: '普通文本中的裸路径',
    ruleCategory: 'text',
    matchMode: 'strict',
    oldText: 'assets/textures/old_brick_wall.png',
    newText: 'assets/materials/brick_wall.png',
    context: '备份说明：旧材质 assets/textures/old_brick_wall.png 已移动到 materials 目录。'
  }
]

export function createSampleOccurrences(): ScanOccurrence[] {
  return OCCURRENCE_SEEDS.map((seed, index) => ({
    id: `occ-${String(index + 1).padStart(3, '0')}`,
    filePath: seed.filePath,
    line: seed.line,
    column: seed.column,
    ruleId: seed.ruleId,
    ruleKey: seed.ruleKey,
    ruleName: seed.ruleName,
    ruleCategory: seed.ruleCategory,
    matchMode: seed.matchMode,
    snippet: seed.context.trim(),
    oldText: seed.oldText,
    newText: seed.newText,
    context: seed.context,
    offset: 1200 + index * 320,
    length: seed.oldText.length
  }))
}

export const SAMPLE_SCAN_FILE_NAMES = [
  'README.md',
  'web/index.html',
  'workflows/comfyui_workflow.json',
  'configs/pipeline.json',
  'configs/pipeline.yaml',
  'configs/dataset.json',
  'scripts/preprocess.py',
  'scripts/render.js',
  'styles/preview.css',
  'notes/field-notes.txt'
]
