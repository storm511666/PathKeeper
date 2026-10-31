/**
 * Beginner-readable file humanization (PathKeeper 2.1 · workflow C).
 *
 * Turns a project-relative path such as `assets/textures/old_brick_wall.png`
 * into a plain-Chinese view: what kind of file it is, a readable title, a
 * breadcrumb and a one-sentence explanation. The original path is always kept
 * on the view so advanced users can still see (and copy) the raw data.
 *
 * This module is intentionally pure TypeScript: no Node.js, Electron, DOM or
 * React imports, so the main process and the renderer can share it.
 *
 * Honesty rules (plan C1/C5):
 * - Unknown English words are NEVER machine-translated or transliterated.
 *   When a file name cannot be explained, the title becomes
 *   `英文文件名，暂时无法解释` and the caller shows the original name/path.
 * - Roles are inferred from the same directory/extension rules the dependency
 *   scanner uses, or supplied by the caller through `options.role`.
 * - Colour is never the only signal: callers pair the icon/type label with the
 *   text returned here.
 */

import type { DependencyCandidateReason, DependencyRole, RuleCategory } from './types'

export type HumanConfidence = 'high' | 'medium' | 'low'

export interface HumanFileView {
  role: DependencyRole
  /** 配置 / 代码 / 素材 / 缓存 / 结果 / 普通文件 */
  roleLabel: string
  /** Semantic icon name (never an emoji); the renderer maps it to a real icon. */
  icon: string
  /** Readable Chinese title, e.g. `砖墙贴图（旧）`. */
  title: string
  /** Readable type, e.g. `图片素材` / `配置文件` / `Python 脚本`. */
  typeLabel: string
  /** `项目 / 素材 / 贴图 / 砖墙贴图（旧）` (POSIX segments, Chinese labels). */
  pathBreadcrumb: string
  /** The untouched path the caller passed in. */
  originalPath: string
  /** One plain-language sentence about what the file is for. */
  explanation: string
  confidence: HumanConfidence
}

export interface HumanizeFileOptions {
  /** Breadcrumb root label; defaults to `项目`. */
  projectName?: string
  /**
   * Authoritative role from the dependency scan. When present it wins over the
   * local heuristic, keeping the human view aligned with the scanner result.
   */
  role?: DependencyRole
}

/** Exact fallback title required when a file name contains unknown English words. */
export const UNKNOWN_ENGLISH_TITLE = '英文文件名，暂时无法解释'

const DEFAULT_ROOT = '项目'
const DEFAULT_TYPE_LABEL = '普通文件'

/* ------------------------------------------------------------------ */
/* C3 · 角色 → 中文                                                    */
/* ------------------------------------------------------------------ */

export const HUMAN_ROLE_LABELS: Record<DependencyRole, string> = {
  config: '配置',
  source: '代码',
  input: '素材',
  cache: '缓存',
  output: '结果',
  unknown: '普通文件'
}

/* ------------------------------------------------------------------ */
/* C3 · 扩展名 → 类型（先覆盖高频，不追求全量）                        */
/* ------------------------------------------------------------------ */

interface ExtensionInfo {
  /** Shown as `typeLabel`, e.g. 图片素材. */
  type: string
  /** Noun appended to the translated file name, e.g. 贴图 → 砖墙贴图. */
  noun: string | null
}

const EXTENSION_INFO: Record<string, ExtensionInfo> = {
  // 配置文件
  '.json': { type: '配置文件', noun: '配置' },
  '.jsonc': { type: '配置文件', noun: '配置' },
  '.yaml': { type: '配置文件', noun: '配置' },
  '.yml': { type: '配置文件', noun: '配置' },
  '.toml': { type: '配置文件', noun: '配置' },
  '.ini': { type: '配置文件', noun: '配置' },
  '.cfg': { type: '配置文件', noun: '配置' },
  '.conf': { type: '配置文件', noun: '配置' },
  '.env': { type: '配置文件', noun: '配置' },
  // 脚本 / 代码
  '.py': { type: 'Python 脚本', noun: '脚本' },
  '.js': { type: '代码文件', noun: '代码' },
  '.jsx': { type: '代码文件', noun: '代码' },
  '.mjs': { type: '代码文件', noun: '代码' },
  '.cjs': { type: '代码文件', noun: '代码' },
  '.ts': { type: '代码文件', noun: '代码' },
  '.tsx': { type: '代码文件', noun: '代码' },
  '.vue': { type: '代码文件', noun: '代码' },
  '.svelte': { type: '代码文件', noun: '代码' },
  '.rb': { type: '代码文件', noun: '代码' },
  '.go': { type: '代码文件', noun: '代码' },
  '.rs': { type: '代码文件', noun: '代码' },
  '.java': { type: '代码文件', noun: '代码' },
  '.kt': { type: '代码文件', noun: '代码' },
  '.cs': { type: '代码文件', noun: '代码' },
  '.c': { type: '代码文件', noun: '代码' },
  '.cc': { type: '代码文件', noun: '代码' },
  '.cpp': { type: '代码文件', noun: '代码' },
  '.h': { type: '代码文件', noun: '代码' },
  '.hpp': { type: '代码文件', noun: '代码' },
  '.php': { type: '代码文件', noun: '代码' },
  '.sh': { type: '脚本文件', noun: '脚本' },
  '.ps1': { type: '脚本文件', noun: '脚本' },
  '.bat': { type: '脚本文件', noun: '脚本' },
  '.cmd': { type: '脚本文件', noun: '脚本' },
  '.sql': { type: '数据库脚本', noun: '脚本' },
  '.html': { type: '网页文件', noun: '页面' },
  '.htm': { type: '网页文件', noun: '页面' },
  '.css': { type: '样式文件', noun: '样式' },
  // 图片素材
  '.png': { type: '图片素材', noun: '贴图' },
  '.jpg': { type: '图片素材', noun: '贴图' },
  '.jpeg': { type: '图片素材', noun: '贴图' },
  '.webp': { type: '图片素材', noun: '贴图' },
  '.gif': { type: '图片素材', noun: '贴图' },
  '.bmp': { type: '图片素材', noun: '贴图' },
  '.tif': { type: '图片素材', noun: '贴图' },
  '.tiff': { type: '图片素材', noun: '贴图' },
  '.svg': { type: '图片素材', noun: '贴图' },
  // 数据表 / 数据
  '.csv': { type: '数据表', noun: '数据' },
  '.tsv': { type: '数据表', noun: '数据' },
  '.xlsx': { type: '数据表', noun: '表格' },
  '.xls': { type: '数据表', noun: '表格' },
  '.parquet': { type: '数据表', noun: '数据' },
  '.arrow': { type: '数据表', noun: '数据' },
  '.feather': { type: '数据表', noun: '数据' },
  // 模型文件
  '.pt': { type: '模型文件', noun: '模型' },
  '.pth': { type: '模型文件', noun: '模型' },
  '.ckpt': { type: '模型文件', noun: '模型' },
  '.onnx': { type: '模型文件', noun: '模型' },
  '.safetensors': { type: '模型文件', noun: '模型' },
  '.bin': { type: '模型文件', noun: '模型' },
  '.pkl': { type: '模型文件', noun: '模型' },
  '.pickle': { type: '模型文件', noun: '模型' },
  '.npy': { type: '模型文件', noun: '模型' },
  '.npz': { type: '模型文件', noun: '模型' },
  // 音视频素材
  '.wav': { type: '音频素材', noun: '音频' },
  '.mp3': { type: '音频素材', noun: '音频' },
  '.flac': { type: '音频素材', noun: '音频' },
  '.ogg': { type: '音频素材', noun: '音频' },
  '.mp4': { type: '视频素材', noun: '视频' },
  '.mov': { type: '视频素材', noun: '视频' },
  '.webm': { type: '视频素材', noun: '视频' },
  // 说明文档
  '.md': { type: '说明文档', noun: '说明' },
  '.mdx': { type: '说明文档', noun: '说明' },
  '.txt': { type: '说明文档', noun: '说明' },
  // 程序 / 运行库 / 压缩包 / 日志
  '.exe': { type: '程序', noun: '程序' },
  '.dll': { type: '运行库', noun: '运行库' },
  '.msi': { type: '安装包', noun: '安装包' },
  '.zip': { type: '压缩包', noun: '压缩包' },
  '.7z': { type: '压缩包', noun: '压缩包' },
  '.rar': { type: '压缩包', noun: '压缩包' },
  '.tar': { type: '压缩包', noun: '压缩包' },
  '.gz': { type: '压缩包', noun: '压缩包' },
  '.log': { type: '日志文件', noun: '日志' },
  // 缓存
  '.tmp': { type: '缓存文件', noun: '缓存' },
  '.cache': { type: '缓存文件', noun: '缓存' },
  '.pyc': { type: '缓存文件', noun: '缓存' },
  '.pyo': { type: '缓存文件', noun: '缓存' },
  '.lock': { type: '缓存文件', noun: '缓存' },
  // 2.1.2 · installed-software formats (additive; C7 labels above stay untouched)
  '.ico': { type: '图标文件', noun: '图标' },
  '.icns': { type: '图标文件', noun: '图标' },
  '.cur': { type: '图标文件', noun: '图标' },
  '.woff': { type: '字体文件', noun: '字体' },
  '.woff2': { type: '字体文件', noun: '字体' },
  '.ttf': { type: '字体文件', noun: '字体' },
  '.otf': { type: '字体文件', noun: '字体' },
  '.ttc': { type: '字体文件', noun: '字体' },
  '.eot': { type: '字体文件', noun: '字体' },
  '.so': { type: '运行库', noun: '库' },
  '.dylib': { type: '运行库', noun: '库' },
  '.lib': { type: '静态库', noun: '库' },
  '.ocx': { type: '运行库', noun: '库' },
  '.ax': { type: '运行库', noun: '库' },
  '.pak': { type: '资源包', noun: '资源包' },
  '.dat': { type: '数据文件', noun: '数据' },
  '.db': { type: '数据库文件', noun: '数据库' },
  '.sqlite': { type: '数据库文件', noun: '数据库' },
  '.sqlite3': { type: '数据库文件', noun: '数据库' },
  '.mui': { type: '语言资源', noun: '语言资源' },
  '.sys': { type: '驱动文件', noun: '驱动' },
  '.drv': { type: '驱动文件', noun: '驱动' },
  '.msix': { type: '安装包', noun: '安装包' },
  '.appx': { type: '安装包', noun: '安装包' },
  '.cab': { type: '安装包', noun: '安装包' },
  '.iso': { type: '镜像文件', noun: '镜像' },
  '.doc': { type: 'Word 文档', noun: '文档' },
  '.docx': { type: 'Word 文档', noun: '文档' },
  '.pdf': { type: 'PDF 文档', noun: '文档' },
  '.rtf': { type: '文档', noun: '文档' },
  '.odt': { type: '文档', noun: '文档' },
  '.pptx': { type: '幻灯片', noun: '幻灯片' },
  '.lua': { type: 'Lua 脚本', noun: '脚本' },
  '.vbs': { type: 'VBScript 脚本', noun: '脚本' },
  '.pl': { type: 'Perl 脚本', noun: '脚本' },
  '.tmj': { type: '游戏地图数据', noun: '地图' },
  '.tsj': { type: '游戏地图数据', noun: '地图' },
  '.json5': { type: '配置文件', noun: '配置' },
  '.properties': { type: '配置文件', noun: '配置' },
  '.plist': { type: '配置文件', noun: '配置' },
  '.reg': { type: '注册表文件', noun: '注册表' },
  '.inf': { type: '安装信息文件', noun: '安装信息' },
  '.xml': { type: '数据文件', noun: '数据' },
  '.asset': { type: '游戏资源', noun: '资源' },
  '.assets': { type: '游戏资源', noun: '资源' },
  '.bundle': { type: '游戏资源', noun: '资源' },
  '.unity3d': { type: '游戏资源', noun: '资源' },
  '.ress': { type: '游戏资源', noun: '资源' },
  '.resource': { type: '游戏资源', noun: '资源' }
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.svg'
])
const DATA_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.xlsx',
  '.xls',
  '.parquet',
  '.arrow',
  '.feather'
])
const MODEL_EXTENSIONS = new Set([
  '.pt',
  '.pth',
  '.ckpt',
  '.onnx',
  '.safetensors',
  '.bin',
  '.pkl',
  '.pickle',
  '.npy',
  '.npz'
])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm'])
const PROGRAM_EXTENSIONS = new Set(['.exe', '.msi'])
const LIBRARY_EXTENSIONS = new Set(['.dll'])

/* ------------------------------------------------------------------ */
/* C3 · 目录 → 中文                                                    */
/* ------------------------------------------------------------------ */

const DIRECTORY_LABELS: Record<string, string> = {
  assets: '素材',
  asset: '素材',
  textures: '贴图',
  texture: '贴图',
  materials: '材质',
  material: '材质',
  configs: '配置',
  config: '配置',
  scripts: '脚本',
  script: '脚本',
  data: '数据',
  dataset: '数据集',
  datasets: '数据集',
  output: '输出',
  outputs: '输出',
  preview: '预览',
  docs: '文档',
  doc: '文档',
  src: '源码',
  source: '源码',
  models: '模型',
  model: '模型',
  workflows: '工作流',
  workflow: '工作流',
  images: '图片',
  image: '图片',
  styles: '样式',
  style: '样式',
  web: '网页',
  cache: '缓存',
  tmp: '临时',
  temp: '临时',
  results: '结果',
  result: '结果',
  dist: '构建输出',
  build: '构建',
  tests: '测试',
  test: '测试',
  examples: '示例',
  example: '示例',
  demo: '示例',
  logs: '日志',
  // 2.1.2 · installed-software directory vocabulary
  resources: '资源',
  resource: '资源',
  static: '静态资源',
  'offline-pack': '离线资源包',
  offlinepack: '离线资源包',
  offline: '离线资源包',
  pack: '资源包',
  packs: '资源包',
  workbench: '工作台',
  cards: '卡片',
  card: '卡片',
  locales: '本地化',
  locale: '本地化',
  lang: '本地化',
  languages: '本地化',
  plugins: '插件',
  plugin: '插件',
  theme: '主题',
  themes: '主题',
  skins: '皮肤',
  skin: '皮肤',
  runtime: '运行时',
  drivers: '驱动',
  binaries: '程序',
  agents: '代理',
  skills: '技能',
  knowledgebase: '知识库',
  templates: '模板',
  updates: '更新',
  update: '更新',
  installer: '安装',
  setup: '安装',
  native: '原生组件',
  chrome: '浏览器内核',
  chromium: '浏览器内核',
  main: '主程序资源'
}

/* ------------------------------------------------------------------ */
/* C3 · 文件名词元 → 中文（未知词不翻译，绝不编造）                    */
/* ------------------------------------------------------------------ */

const TOKEN_LABELS: Record<string, string> = {
  old: '旧',
  new: '新',
  brick: '砖',
  wall: '墙',
  texture: '贴图',
  material: '材质',
  preview: '预览',
  pipeline: '流程',
  preprocess: '预处理',
  config: '配置',
  sample: '示例',
  test: '测试',
  main: '主',
  backup: '备份',
  temp: '临时',
  draft: '草稿',
  final: '最终',
  // A small set of unambiguous everyday words, so common demo projects read
  // naturally. Anything not listed here is treated as unknown on purpose.
  readme: '说明',
  image: '图片',
  img: '图片',
  data: '数据',
  dataset: '数据集',
  model: '模型',
  script: '脚本',
  render: '渲染',
  workflow: '工作流',
  normal: '法线',
  mask: '遮罩',
  demo: '示例',
  settings: '设置',
  setting: '设置',
  user: '用户',
  file: '文件',
  guide: '指南',
  note: '笔记',
  notes: '笔记',
  output: '输出',
  input: '输入',
  cache: '缓存',
  result: '结果',
  log: '日志',
  // 2.1.2 · installed-software file-name vocabulary. Curated, unambiguous
  // everyday words only; anything not listed here stays unknown on purpose.
  icon: '图标',
  icons: '图标',
  app: '应用',
  apps: '应用',
  application: '应用',
  account: '账户',
  accounts: '账户',
  asset: '素材',
  assets: '素材',
  static: '静态资源',
  resource: '资源',
  resources: '资源',
  offline: '离线',
  pack: '资源包',
  packs: '资源包',
  workbench: '工作台',
  card: '卡片',
  cards: '卡片',
  report: '报告',
  reports: '报告',
  update: '更新',
  updates: '更新',
  setup: '安装',
  driver: '驱动',
  drivers: '驱动',
  runtime: '运行时',
  native: '原生',
  chrome: '浏览器内核',
  chromium: '浏览器内核',
  locale: '本地化',
  locales: '本地化',
  lang: '语言',
  languages: '语言',
  language: '语言',
  skin: '皮肤',
  skins: '皮肤',
  theme: '主题',
  themes: '主题',
  plugin: '插件',
  plugins: '插件',
  module: '模块',
  modules: '模块',
  lib: '库',
  libs: '库',
  bin: '程序',
  binary: '二进制',
  binaries: '程序',
  python: 'Python',
  node: 'Node',
  nodejs: 'Node',
  tool: '工具',
  tools: '工具',
  docs: '文档',
  doc: '文档',
  template: '模板',
  templates: '模板',
  samples: '示例',
  package: '包',
  packages: '包',
  configs: '配置',
  configuration: '配置',
  manifest: '清单',
  index: '索引',
  caches: '缓存',
  logo: '标志',
  logos: '标志',
  font: '字体',
  fonts: '字体',
  audio: '音频',
  videos: '视频',
  masks: '遮罩',
  models: '模型',
  workflows: '工作流',
  batch: '批处理',
  runner: '运行器',
  runners: '运行器',
  agent: '代理',
  agents: '代理',
  host: '宿主',
  knowledgebase: '知识库',
  docx: 'Word 文档',
  installer: '安装器',
  install: '安装',
  uninstall: '卸载',
  uninstaller: '卸载程序',
  patch: '补丁',
  patches: '补丁',
  skill: '技能',
  skills: '技能',
  scenario: '场景',
  scenarios: '场景',
  changelog: '更新日志',
  version: '版本',
  info: '信息',
  read: '读取',
  license: '许可',
  notice: '声明',
  defaults: '默认',
  profile: '配置',
  profiles: '配置',
  workspace: '工作区',
  project: '项目',
  library: '库',
  source: '源码',
  src: '源码',
  dist: '构建输出',
  build: '构建',
  outputs: '输出',
  tests: '测试',
  example: '示例',
  images: '图片',
  picture: '图片',
  pictures: '图片',
  background: '背景',
  splash: '启动画面',
  banner: '横幅',
  thumbnail: '缩略图',
  avatar: '头像',
  cursor: '光标',
  sprite: '精灵图',
  sound: '声音',
  sounds: '声音',
  music: '音乐',
  voice: '语音',
  map: '地图',
  maps: '地图',
  level: '关卡',
  levels: '关卡',
  save: '存档',
  saves: '存档',
  screenshot: '截图',
  screenshots: '截图'
}

/** Tokens that read better as a parenthesised suffix: 砖墙贴图（旧）. */
const MODIFIER_TOKENS = new Set(['old', 'new', 'temp', 'backup', 'draft', 'final'])

/* ------------------------------------------------------------------ */
/* Role inference (mirrors the dependency scanner's rules)             */
/* ------------------------------------------------------------------ */

const CACHE_SEGMENTS = new Set([
  'cache',
  'caches',
  '.cache',
  'tmp',
  'temp',
  '.tmp',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache'
])
const OUTPUT_SEGMENTS = new Set([
  'output',
  'outputs',
  'dist',
  'build',
  'out',
  'results',
  'result',
  'renders',
  'render',
  'generated',
  'release',
  'logs',
  'exports'
])
const INPUT_SEGMENTS = new Set([
  'assets',
  'asset',
  'data',
  'dataset',
  'datasets',
  'input',
  'inputs',
  'models',
  'model',
  'textures',
  'images',
  'image',
  'audio',
  'video',
  'resources',
  'samples',
  'media'
])
const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env'
])
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.php',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.vue',
  '.svelte',
  '.html',
  '.htm',
  '.css',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml'
])
const INPUT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.svg',
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.mp4',
  '.mov',
  '.webm',
  '.csv',
  '.tsv',
  '.parquet',
  '.arrow',
  '.feather',
  '.npy',
  '.npz',
  '.pt',
  '.pth',
  '.onnx',
  '.safetensors',
  '.ckpt',
  '.bin',
  '.pkl',
  '.pickle'
])
const CACHE_EXTENSIONS = new Set(['.tmp', '.cache', '.pyc', '.pyo', '.lock'])

/* ------------------------------------------------------------------ */
/* Path parsing                                                        */
/* ------------------------------------------------------------------ */

interface ParsedPath {
  /** POSIX directory segments, original case. */
  directories: string[]
  /** File name including the extension, original case. */
  baseName: string
  /** File name without the extension, original case. */
  stem: string
  /** Lower-cased extension including the dot, or '' when there is none. */
  extension: string
}

function parseRelativePath(relativePath: string): ParsedPath {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const trimmed = normalized.replace(/\/+$/, '')
  if (trimmed.trim().length === 0) {
    return { directories: [], baseName: '', stem: '', extension: '' }
  }
  const parts = trimmed.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) {
    return { directories: [], baseName: '', stem: '', extension: '' }
  }
  const baseName = parts[parts.length - 1] ?? ''
  const directories = parts.slice(0, -1)
  const dot = baseName.lastIndexOf('.')
  const extension = dot > 0 ? baseName.slice(dot).toLowerCase() : ''
  const stem = extension.length > 0 ? baseName.slice(0, dot) : baseName
  return { directories, baseName, stem, extension }
}

/** Splits snake_case / kebab-case / camelCase / PascalCase into lower-cased words. */
export function splitFileNameTokens(stem: string): string[] {
  const spaced = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase())
}

function inferRole(parsed: ParsedPath): DependencyRole {
  if (parsed.baseName.length === 0) return 'unknown'
  const segments = parsed.directories.map((segment) => segment.toLowerCase())
  const base = parsed.baseName.toLowerCase()
  const extension = parsed.extension
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment)) || CACHE_EXTENSIONS.has(extension)) {
    return 'cache'
  }
  if (segments.some((segment) => OUTPUT_SEGMENTS.has(segment))) {
    return 'output'
  }
  if (CONFIG_EXTENSIONS.has(extension) || base.startsWith('config')) {
    return 'config'
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    return 'source'
  }
  if (
    segments.some((segment) => INPUT_SEGMENTS.has(segment)) ||
    INPUT_EXTENSIONS.has(extension)
  ) {
    return 'input'
  }
  return 'unknown'
}

/* ------------------------------------------------------------------ */
/* Title composition                                                   */
/* ------------------------------------------------------------------ */

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

function withModifiers(title: string, modifiers: string[]): string {
  if (modifiers.length === 0) return title
  return `${title}（${modifiers.join('，')}）`
}

interface TitleResult {
  title: string
  /** True when the title is a real explanation rather than the honest fallback. */
  translated: boolean
}

function unknownTitle(): TitleResult {
  return { title: UNKNOWN_ENGLISH_TITLE, translated: false }
}

function appendNoun(base: string, noun: string | null): string {
  if (noun === null || noun.length === 0) return base
  if (base.length === 0) return noun
  return base.endsWith(noun) ? base : `${base}${noun}`
}

function composeTitle(stem: string, noun: string | null): TitleResult {
  if (stem.length === 0) return unknownTitle()

  // A file name that already contains Chinese is readable as-is; never replace
  // it with machine output. Only add the type noun when it is missing.
  if (CJK_PATTERN.test(stem)) {
    return { title: appendNoun(stem, noun), translated: true }
  }

  const tokens = splitFileNameTokens(stem)
  if (tokens.length === 0) return unknownTitle()

  const words: string[] = []
  const modifiers: string[] = []
  const numbers: string[] = []

  for (const token of tokens) {
    if (/^[0-9]+$/.test(token)) {
      numbers.push(token)
      continue
    }
    const translation = TOKEN_LABELS[token]
    if (translation === undefined) {
      // Unknown English word: never translate, never guess. The caller still
      // shows the honest type label plus the original name.
      return unknownTitle()
    }
    if (MODIFIER_TOKENS.has(token)) {
      modifiers.push(translation)
    } else {
      words.push(translation)
    }
  }

  const numberSuffix = numbers.length > 0 ? ` ${numbers.join(' ')}` : ''
  const base = appendNoun(words.join(''), noun)
  if (base.length === 0) return unknownTitle()
  return { title: `${withModifiers(base, modifiers)}${numberSuffix}`, translated: true }
}

function typeLabelFor(role: DependencyRole, info: ExtensionInfo | null): string {
  if (role === 'output') return '结果文件'
  if (role === 'cache') return '缓存文件'
  return info?.type ?? DEFAULT_TYPE_LABEL
}

function nounFor(role: DependencyRole, info: ExtensionInfo | null, extension: string): string | null {
  if (role === 'output') return '结果'
  if (role === 'cache') return '缓存'
  const extensionInfo = info ?? EXTENSION_INFO[extension] ?? null
  return extensionInfo?.noun ?? null
}

function explanationFor(role: DependencyRole, extension: string): string {
  if (role === 'config') return '程序启动时会读取的配置文件'
  if (role === 'source') {
    return extension === '.py' || extension === '.sh' || extension === '.ps1'
      ? '程序运行或构建时会用到的脚本'
      : '程序运行或构建时会用到的代码'
  }
  if (role === 'cache') return '程序运行中产生的临时缓存，可以重新生成'
  if (role === 'output') return '程序运行后生成的结果，通常可以删除或重新生成'
  if (role === 'input') {
    if (IMAGE_EXTENSIONS.has(extension)) return '程序启动时会读取的图片素材'
    if (DATA_EXTENSIONS.has(extension)) return '程序会读取的数据表'
    if (MODEL_EXTENSIONS.has(extension)) return '程序会加载的模型文件'
    if (AUDIO_EXTENSIONS.has(extension)) return '程序会读取的音频素材'
    if (VIDEO_EXTENSIONS.has(extension)) return '程序会读取的视频素材'
    return '程序启动时会读取的素材或数据'
  }
  return '项目里被其他文件引用的普通文件'
}

function iconFor(role: DependencyRole, extension: string): string {
  if (role === 'config') return 'settings'
  if (role === 'source') return 'code'
  if (role === 'cache') return 'archive'
  if (role === 'output') return 'sparkles'
  if (role === 'input') {
    if (IMAGE_EXTENSIONS.has(extension)) return 'image'
    if (DATA_EXTENSIONS.has(extension)) return 'table'
    if (MODEL_EXTENSIONS.has(extension)) return 'box'
    if (AUDIO_EXTENSIONS.has(extension)) return 'music'
    if (VIDEO_EXTENSIONS.has(extension)) return 'video'
    return 'file-input'
  }
  if (PROGRAM_EXTENSIONS.has(extension)) return 'app-window'
  if (LIBRARY_EXTENSIONS.has(extension)) return 'package'
  return 'file'
}

function confidenceFor(info: ExtensionInfo | null, translated: boolean): HumanConfidence {
  if (info === null) return 'low'
  return translated ? 'high' : 'medium'
}

/* ------------------------------------------------------------------ */
/* Breadcrumb                                                          */
/* ------------------------------------------------------------------ */

function translateDirectory(segment: string): string {
  const label = DIRECTORY_LABELS[segment.toLowerCase()]
  // Unknown directories keep their raw name: no invented translations.
  return label ?? segment
}

function breadcrumbFor(
  parsed: ParsedPath,
  title: string,
  rootLabel: string
): string {
  const root = rootLabel.length > 0 ? rootLabel : DEFAULT_ROOT
  if (parsed.baseName.length === 0) return root
  const directories = parsed.directories.map(translateDirectory)
  const leaf = title === UNKNOWN_ENGLISH_TITLE ? parsed.baseName : title
  return [root, ...directories, leaf].join(' / ')
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Builds the beginner-readable view of a project-relative file path.
 *
 * Deterministic and side-effect free. Never throws: an empty or odd path still
 * yields a low-confidence view with the honest fallback title.
 */
export function humanizeFileView(
  relativePath: string,
  options: HumanizeFileOptions = {}
): HumanFileView {
  const rawPath = typeof relativePath === 'string' ? relativePath : ''
  const parsed = parseRelativePath(rawPath)
  const info = parsed.extension.length > 0 ? EXTENSION_INFO[parsed.extension] ?? null : null
  const role = options.role ?? inferRole(parsed)
  const noun = nounFor(role, info, parsed.extension)
  const titleResult = composeTitle(parsed.stem, noun)
  const rootLabel = options.projectName?.trim() ?? ''
  const translated = titleResult.translated && parsed.baseName.length > 0
  return {
    role,
    roleLabel: HUMAN_ROLE_LABELS[role],
    icon: iconFor(role, parsed.extension),
    title: titleResult.title,
    typeLabel: typeLabelFor(role, info),
    pathBreadcrumb: breadcrumbFor(parsed, titleResult.title, rootLabel),
    originalPath: rawPath,
    // When the English name cannot be explained, saying so is the honest
    // explanation; inventing a purpose would be worse than admitting the gap.
    explanation: translated ? explanationFor(role, parsed.extension) : UNKNOWN_ENGLISH_TITLE,
    confidence: confidenceFor(info, translated)
  }
}

/** `图片素材 ·「砖墙贴图（旧）」` — the exact beginner summary used in the C7 table. */
export function formatHumanFileSummary(view: HumanFileView): string {
  return `${view.typeLabel} ·「${view.title}」`
}

/** Evidence-based "why do we recommend this file" sentence for candidate rows. */
const CANDIDATE_REASON_EVIDENCE: Record<DependencyCandidateReason, string> = {
  'same-name': '文件名完全相同，可能是同一份文件',
  'similar-name': '文件名很像，可能是改过名的同一份文件',
  'same-folder': '和原来的文件在同一个文件夹'
}

export function candidateReasonEvidence(reason: DependencyCandidateReason): string {
  return CANDIDATE_REASON_EVIDENCE[reason]
}

/* ================================================================== */
/* 2.1.2 · 软件文件说明层：它是什么 / 它有什么用 / 为什么找不到        */
/* ================================================================== */

/**
 * Plain-Chinese view of one file inside an installed software folder.
 *
 * Unlike `HumanFileView` (which is tuned for project assets), this view answers
 * the four beginner questions for a path found by the software scan: what kind
 * of file is it, what is it called in Chinese, what is it, what does the
 * program do with it, and where does it live. Unknown file names still fall
 * back to `UNKNOWN_ENGLISH_TITLE`; the other fields stay useful and honest.
 */
export interface HumanSoftwareFileView {
  /** e.g. 界面图标素材 / 配置数据 / 运行库 / 说明文档 */
  typeLabel: string
  /** e.g. 「账户图标」; unknown falls back to UNKNOWN_ENGLISH_TITLE (keep honest) */
  title: string
  /** 它是什么：one plain-Chinese sentence, may cite 目录/扩展名 evidence */
  whatItIs: string
  /** 它有什么用：one plain-Chinese sentence about what the program does with it */
  whatFor: string
  /** 所在位置的中文说明, e.g. 「离线资源包 / 主程序资源」 */
  locationLabel: string
  /** 推测置信度: high / medium / low */
  confidence: HumanConfidence
}

type SoftwareFileKind =
  | 'icon'
  | 'vector'
  | 'image'
  | 'font'
  | 'library'
  | 'program'
  | 'installer'
  | 'resource-pack'
  | 'config'
  | 'document'
  | 'script'
  | 'map'
  | 'model'
  | 'data'
  | 'binary'
  | 'archive'
  | 'database'
  | 'locale'
  | 'driver'
  | 'game-asset'
  | 'unknown'

/* ------------------------------------------------------------------ */
/* 2.1.2 · 扩展名 → 文件种类（typeLabel 与用途说明都由它推导）          */
/* ------------------------------------------------------------------ */

const SOFTWARE_KIND_BY_EXTENSION: Record<string, SoftwareFileKind> = {
  '.ico': 'icon',
  '.icns': 'icon',
  '.cur': 'icon',
  '.svg': 'vector',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.psd': 'image',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.ttc': 'font',
  '.eot': 'font',
  '.fon': 'font',
  '.dll': 'library',
  '.so': 'library',
  '.dylib': 'library',
  '.lib': 'library',
  '.ocx': 'library',
  '.ax': 'library',
  '.exe': 'program',
  '.com': 'program',
  '.msi': 'installer',
  '.msix': 'installer',
  '.appx': 'installer',
  '.cab': 'installer',
  '.iso': 'installer',
  '.pak': 'resource-pack',
  '.json': 'config',
  '.jsonc': 'config',
  '.json5': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.cfg': 'config',
  '.conf': 'config',
  '.env': 'config',
  '.properties': 'config',
  '.plist': 'config',
  '.xml': 'config',
  '.reg': 'config',
  '.inf': 'config',
  '.md': 'document',
  '.mdx': 'document',
  '.txt': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.pdf': 'document',
  '.rtf': 'document',
  '.odt': 'document',
  '.pptx': 'document',
  '.py': 'script',
  '.pyw': 'script',
  '.js': 'script',
  '.mjs': 'script',
  '.cjs': 'script',
  '.ts': 'script',
  '.ps1': 'script',
  '.bat': 'script',
  '.cmd': 'script',
  '.sh': 'script',
  '.vbs': 'script',
  '.lua': 'script',
  '.pl': 'script',
  '.tmj': 'map',
  '.tsj': 'map',
  '.onnx': 'model',
  '.pt': 'model',
  '.pth': 'model',
  '.ckpt': 'model',
  '.safetensors': 'model',
  '.pkl': 'model',
  '.pickle': 'model',
  '.csv': 'data',
  '.tsv': 'data',
  '.xlsx': 'data',
  '.xls': 'data',
  '.dat': 'data',
  '.bin': 'binary',
  '.zip': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.db': 'database',
  '.sqlite': 'database',
  '.sqlite3': 'database',
  '.mui': 'locale',
  '.sys': 'driver',
  '.drv': 'driver',
  '.asset': 'game-asset',
  '.assets': 'game-asset',
  '.bundle': 'game-asset',
  '.unity3d': 'game-asset',
  '.ress': 'game-asset',
  '.resource': 'game-asset'
}

const SOFTWARE_KIND_LABELS: Record<SoftwareFileKind, string> = {
  icon: '图标素材',
  vector: '矢量图素材',
  image: '图片素材',
  font: '字体文件',
  library: '运行库',
  program: '程序',
  installer: '安装包',
  'resource-pack': '资源包',
  config: '配置数据',
  document: '说明文档',
  script: '脚本文件',
  map: '游戏地图数据',
  model: '模型文件',
  data: '数据文件',
  binary: '二进制数据',
  archive: '压缩包',
  database: '数据库文件',
  locale: '语言资源',
  driver: '驱动文件',
  'game-asset': '游戏资源',
  unknown: '未知类型文件'
}

/** Exact extension → typeLabel mapping (extend here when new formats show up). */
const SOFTWARE_TYPE_LABELS: Record<string, string> = {
  '.ico': '图标素材',
  '.icns': '图标素材',
  '.cur': '图标素材',
  '.svg': '矢量图素材',
  '.png': '图片素材',
  '.jpg': '图片素材',
  '.jpeg': '图片素材',
  '.webp': '图片素材',
  '.gif': '动图素材',
  '.bmp': '图片素材',
  '.tif': '图片素材',
  '.tiff': '图片素材',
  '.psd': '图片素材',
  '.woff': '字体文件',
  '.woff2': '字体文件',
  '.ttf': '字体文件',
  '.otf': '字体文件',
  '.ttc': '字体文件',
  '.eot': '字体文件',
  '.fon': '字体文件',
  '.dll': '运行库',
  '.so': '运行库',
  '.dylib': '运行库',
  '.lib': '静态库',
  '.ocx': '运行库',
  '.ax': '运行库',
  '.exe': '程序',
  '.com': '程序',
  '.msi': '安装包',
  '.msix': '安装包',
  '.appx': '安装包',
  '.cab': '安装包',
  '.iso': '镜像文件',
  '.pak': '资源包',
  '.json': '配置数据',
  '.jsonc': '配置数据',
  '.json5': '配置数据',
  '.yaml': '配置数据',
  '.yml': '配置数据',
  '.toml': '配置数据',
  '.ini': '配置数据',
  '.cfg': '配置数据',
  '.conf': '配置数据',
  '.env': '配置数据',
  '.properties': '配置数据',
  '.plist': '配置数据',
  '.xml': '配置数据',
  '.reg': '注册表文件',
  '.inf': '安装信息文件',
  '.md': '说明文档',
  '.mdx': '说明文档',
  '.txt': '说明文档',
  '.doc': 'Word 文档',
  '.docx': 'Word 文档',
  '.pdf': 'PDF 文档',
  '.rtf': '文档',
  '.odt': '文档',
  '.pptx': '幻灯片',
  '.py': 'Python 脚本',
  '.pyw': 'Python 脚本',
  '.js': 'JavaScript 脚本',
  '.mjs': 'JavaScript 脚本',
  '.cjs': 'JavaScript 脚本',
  '.ts': 'TypeScript 脚本',
  '.ps1': 'PowerShell 脚本',
  '.bat': '批处理脚本',
  '.cmd': '批处理脚本',
  '.sh': 'Shell 脚本',
  '.vbs': 'VBScript 脚本',
  '.lua': 'Lua 脚本',
  '.pl': 'Perl 脚本',
  '.tmj': '游戏地图数据',
  '.tsj': '游戏地图数据',
  '.onnx': '模型文件',
  '.pt': '模型文件',
  '.pth': '模型文件',
  '.ckpt': '模型文件',
  '.safetensors': '模型文件',
  '.pkl': '模型文件',
  '.pickle': '模型文件',
  '.csv': '数据表',
  '.tsv': '数据表',
  '.xlsx': '数据表',
  '.xls': '数据表',
  '.dat': '数据文件',
  '.bin': '二进制数据',
  '.zip': '压缩包',
  '.7z': '压缩包',
  '.rar': '压缩包',
  '.tar': '压缩包',
  '.gz': '压缩包',
  '.db': '数据库文件',
  '.sqlite': '数据库文件',
  '.sqlite3': '数据库文件',
  '.mui': '语言资源',
  '.sys': '驱动文件',
  '.drv': '驱动文件',
  '.asset': '游戏资源',
  '.assets': '游戏资源',
  '.bundle': '游戏资源',
  '.unity3d': '游戏资源',
  '.ress': '游戏资源',
  '.resource': '游戏资源'
}

/** Noun appended to the translated stem, per kind (null = do not append). */
const SOFTWARE_KIND_NOUNS: Record<SoftwareFileKind, string | null> = {
  icon: null,
  vector: null,
  image: '图片',
  font: '字体',
  library: '库',
  program: '程序',
  installer: '安装包',
  'resource-pack': '资源包',
  config: '配置',
  document: '文档',
  script: '脚本',
  map: '地图',
  model: '模型',
  data: '数据',
  binary: '数据',
  archive: '压缩包',
  database: '数据库',
  locale: '语言资源',
  driver: '驱动',
  'game-asset': '资源',
  unknown: null
}

function softwareKindFor(extension: string): SoftwareFileKind {
  return SOFTWARE_KIND_BY_EXTENSION[extension] ?? 'unknown'
}

function softwareTypeLabelFor(extension: string): string {
  const explicit = SOFTWARE_TYPE_LABELS[extension]
  if (explicit !== undefined) return explicit
  return SOFTWARE_KIND_LABELS[softwareKindFor(extension)]
}

/* ------------------------------------------------------------------ */
/* 2.1.2 · installed-software vocabulary                               */
/* ------------------------------------------------------------------ */

/**
 * Installed software speaks a different dialect than a project folder:
 * `icon-ms-accounts.svg`, `offline-pack`, `chrome_100_percent.pak`. These
 * translations are curated by hand (never machine translation). A word that is
 * not listed here keeps the file name unknown on purpose.
 */
const SOFTWARE_TOKEN_LABELS: Record<string, string> = {
  ...TOKEN_LABELS,
  icon: '图标',
  icons: '图标',
  app: '应用',
  apps: '应用',
  application: '应用',
  account: '账户',
  accounts: '账户',
  asset: '素材',
  assets: '素材',
  static: '静态资源',
  resource: '资源',
  resources: '资源',
  offline: '离线',
  pack: '资源包',
  packs: '资源包',
  workbench: '工作台',
  card: '卡片',
  cards: '卡片',
  report: '报告',
  reports: '报告',
  update: '更新',
  updates: '更新',
  setup: '安装',
  driver: '驱动',
  drivers: '驱动',
  runtime: '运行时',
  native: '原生',
  chrome: '浏览器内核',
  chromium: '浏览器内核',
  locale: '本地化',
  locales: '本地化',
  lang: '语言',
  language: '语言',
  languages: '语言',
  skin: '皮肤',
  skins: '皮肤',
  theme: '主题',
  themes: '主题',
  plugin: '插件',
  plugins: '插件',
  module: '模块',
  modules: '模块',
  lib: '库',
  libs: '库',
  bin: '程序',
  binary: '二进制',
  binaries: '程序',
  python: 'Python',
  node: 'Node',
  nodejs: 'Node',
  tool: '工具',
  tools: '工具',
  docs: '文档',
  doc: '文档',
  template: '模板',
  templates: '模板',
  sample: '示例',
  samples: '示例',
  package: '包',
  packages: '包',
  configs: '配置',
  configuration: '配置',
  manifest: '清单',
  index: '索引',
  caches: '缓存',
  logo: '标志',
  logos: '标志',
  font: '字体',
  fonts: '字体',
  audio: '音频',
  video: '视频',
  videos: '视频',
  masks: '遮罩',
  models: '模型',
  workflows: '工作流',
  batch: '批处理',
  runner: '运行器',
  runners: '运行器',
  agent: '代理',
  agents: '代理',
  host: '宿主',
  knowledgebase: '知识库',
  docx: 'Word 文档',
  installer: '安装器',
  install: '安装',
  uninstall: '卸载',
  uninstaller: '卸载程序',
  patch: '补丁',
  patches: '补丁',
  skill: '技能',
  skills: '技能',
  scenario: '场景',
  scenarios: '场景',
  changelog: '更新日志',
  version: '版本',
  info: '信息',
  license: '许可',
  notice: '声明',
  defaults: '默认',
  profile: '配置',
  profiles: '配置',
  workspace: '工作区',
  project: '项目',
  library: '库',
  source: '源码',
  src: '源码',
  dist: '构建输出',
  build: '构建',
  outputs: '输出',
  tests: '测试',
  example: '示例',
  images: '图片',
  picture: '图片',
  pictures: '图片',
  background: '背景',
  splash: '启动画面',
  banner: '横幅',
  thumbnail: '缩略图',
  avatar: '头像',
  cursor: '光标',
  sprite: '精灵图',
  sound: '声音',
  sounds: '声音',
  music: '音乐',
  voice: '语音',
  map: '地图',
  maps: '地图',
  level: '关卡',
  levels: '关卡',
  save: '存档',
  saves: '存档',
  screenshot: '截图',
  screenshots: '截图'
}

/** Common shorter forms; marked as a guess so confidence stays honest. */
const SOFTWARE_ABBREVIATIONS: Record<string, string> = {
  ms: '微软',
  win: 'Windows',
  win32: '32 位 Windows',
  win64: '64 位 Windows',
  x64: '64 位',
  x86: '32 位',
  arm64: 'ARM64',
  ui: '界面',
  api: '接口',
  gpu: '显卡',
  cpu: '处理器',
  pc: '电脑',
  dpi: '缩放',
  sdk: '开发包',
  ocr: '文字识别',
  dx: 'DirectX',
  d3d: 'Direct3D',
  vk: 'Vulkan',
  gl: 'OpenGL'
}

/**
 * Well-known tool / vendor proper names. They are NOT translated — the title
 * keeps the original spelling (e.g.「mypy 配置」), which is honest and still
 * understandable. Random unknown words never end up here.
 */
const SOFTWARE_KNOWN_TOOL_NAMES = new Set([
  'mypy',
  'pylint',
  'ruff',
  'pytest',
  'pip',
  'conda',
  'git',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'ffmpeg',
  'ffprobe',
  'openssl',
  'curl',
  'wget',
  'cmake',
  'ninja',
  'meson',
  'gradle',
  'maven',
  'dotnet',
  'powershell',
  'bash',
  'webpack',
  'vite',
  'rollup',
  'esbuild',
  'babel',
  'eslint',
  'prettier',
  'sass',
  'nginx',
  'docker',
  'electron'
])

const SOFTWARE_HEAD_FIRST_TOKENS = new Set([
  'icon',
  'logo',
  'sprite',
  'banner',
  'avatar',
  'thumbnail',
  'cursor',
  'shortcut',
  'font',
  'theme',
  'skin',
  'locale',
  'plugin',
  'module',
  'manifest',
  'prefab',
  'atlas',
  'tileset'
])

/** Generic single-word names that read better when the parent folder is cited. */
const SOFTWARE_GENERIC_STEMS = new Set([
  'manifest',
  'index',
  'config',
  'configs',
  'settings',
  'package',
  'data',
  'info',
  'version',
  'main',
  'defaults',
  'profile'
])

const SOFTWARE_HINT_DIRECTORY_LABELS = new Set([
  '素材',
  '卡片',
  '图标',
  '字体',
  '主题',
  '皮肤',
  '插件',
  '模块',
  '模型',
  '地图',
  '场景',
  '技能',
  '代理',
  '补丁',
  '更新',
  '安装',
  '文档',
  '音频',
  '视频',
  '语言',
  '标志',
  '背景',
  '工作流',
  '本地化'
])

const SOFTWARE_DIRECTORY_LABELS: Record<string, string> = {
  ...DIRECTORY_LABELS,
  assets: '素材',
  static: '静态资源',
  resources: '资源目录',
  resource: '资源目录',
  res: '资源目录',
  'offline-pack': '离线资源包',
  offlinepack: '离线资源包',
  offline: '离线资源包',
  pack: '资源包',
  packs: '资源包',
  workbench: '工作台',
  cards: '卡片',
  card: '卡片',
  locales: '本地化',
  locale: '本地化',
  lang: '本地化',
  languages: '本地化',
  plugins: '插件',
  plugin: '插件',
  theme: '主题',
  themes: '主题',
  skins: '皮肤',
  skin: '皮肤',
  runtime: '运行时',
  drivers: '驱动',
  driver: '驱动',
  binaries: '程序',
  bin: '程序',
  docs: '文档',
  doc: '文档',
  agents: '代理',
  agent: '代理',
  skills: '技能',
  skill: '技能',
  knowledgebase: '知识库',
  templates: '模板',
  template: '模板',
  update: '更新',
  updates: '更新',
  setup: '安装',
  installer: '安装',
  native: '原生组件',
  chrome: '浏览器内核',
  chromium: '浏览器内核',
  python: 'Python 环境',
  node: 'Node 环境',
  nodejs: 'Node 环境',
  tools: '工具',
  tool: '工具',
  lib: '库',
  libs: '库',
  module: '模块',
  modules: '模块',
  model: '模型',
  models: '模型',
  workflow: '工作流',
  workflows: '工作流',
  batch: '批处理',
  runner: '运行器',
  host: '宿主',
  application: '应用目录',
  app: '应用目录',
  apps: '应用目录',
  main: '主程序资源',
  fonts: '字体',
  font: '字体',
  audio: '音频',
  video: '视频',
  masks: '遮罩',
  preview: '预览'
}

/* ------------------------------------------------------------------ */
/* 2.1.2 · what is it / what is it for copy                            */
/* ------------------------------------------------------------------ */

const SOFTWARE_WHAT_IT_IS: Record<SoftwareFileKind, string> = {
  icon: '它是一个图标素材，用来在程序界面或 Windows 里显示小图标。',
  vector: '它是一张矢量图素材，用文字描述图形，放大后不会变模糊。',
  image: '它是一张图片素材，程序界面或文档显示内容时会用到它。',
  font: '它是一个字体文件，程序界面用它显示指定样式的文字。',
  library: '它是一个动态链接库，里面是可以被程序反复调用的共享代码。',
  program: '它是一个可执行程序，是软件真正运行起来的程序本体。',
  installer: '它是一个安装包，用来把软件安装或更新到电脑上。',
  'resource-pack': '它是一个资源包，通常把许多界面、语言或图片资源打包在同一个文件里。',
  config: '它是一份配置数据，里面用文字保存软件运行时读取的设置项。',
  document: '它是一份说明文档，保存文字、图片和排版内容。',
  script: '它是一个脚本文件，里面是让程序或系统自动执行的一组命令。',
  map: '它是一份游戏地图数据，保存地图的图层和对象信息。',
  model: '它是一个模型文件，保存程序运行时要加载的模型数据。',
  data: '它是一份数据文件，内容通常是程序运行时读取的数据。',
  binary: '它是一个二进制数据文件，内容通常只有程序自己能解析。',
  archive: '它是一个压缩包，里面打包了多个文件。',
  database: '它是一个数据库文件，保存结构化的数据记录。',
  locale: '它是一份界面语言资源，保存程序界面上的文字。',
  driver: '它是一个驱动文件，帮助系统或软件与硬件、系统功能打交道。',
  'game-asset': '它是一个游戏资源文件，保存游戏运行时加载的素材或数据。',
  unknown: '静态检查无法确定它是什么类型的文件。'
}

const SOFTWARE_WHAT_FOR: Record<SoftwareFileKind, string> = {
  icon: '程序界面显示图标时会读取它；图标缺失时对应按钮或文件可能显示成空白方块。',
  vector: '程序界面显示图标或图案时会读取它。',
  image: '程序界面显示图片、缩略图或背景时会读取它。',
  font: '程序界面显示文字时会加载它来决定字体样式；缺失时可能改用默认字体。',
  library: '程序启动或某个功能运行时加载这份库文件；它缺失通常会让启动或对应功能失败。',
  program: '用户双击它、或系统启动软件时会运行它。',
  installer: '安装或更新软件时会用到它，平时运行软件一般不需要它。',
  'resource-pack': '程序启动或切换界面时会读取里面的资源；它缺失可能让界面显示不全或某个功能报错。',
  config: '软件启动或某个功能会读取这份配置；文件缺失时可能改用默认值，也可能报错。',
  document: '一般给用户查看说明；如果软件会读取它，缺失时对应帮助内容可能显示不出来。',
  script: '安装、更新或某个功能运行时可能执行它；具体什么时候执行，静态检查无法确认。',
  map: '游戏运行到这张地图时会读取它的地图数据。',
  model: '程序需要用到对应模型时会加载它；它缺失通常会让该功能失败。',
  data: '程序运行时会读取其中的数据；静态检查无法确定具体用在哪个功能。',
  binary: '程序可能会读取它来使用其中的数据（静态检查无法确定具体用途）。',
  archive: '安装、更新或解压素材时可能用到它，平时运行软件一般不直接读取。',
  database: '程序保存或查询数据时会读写它；它缺失可能丢失历史数据。',
  locale: '程序会根据系统语言加载对应文字；它缺失时界面可能显示英文或空白。',
  driver: '系统或软件需要驱动硬件、使用某项系统功能时会加载它。',
  'game-asset': '游戏运行时会加载这份素材或数据。',
  unknown: '程序可能会读取它，也可能是安装包里用不到的文件；静态检查无法确定具体用途。'
}

/* ------------------------------------------------------------------ */
/* 2.1.2 · title / location / confidence helpers                       */
/* ------------------------------------------------------------------ */

const SOFTWARE_SCALE_PATTERN = /(?:^|[_-])(\d{1,3})[_-]percent$/i
const LATIN_WORD_PATTERN = /[A-Za-z0-9]/
const VERSION_SEGMENT_PATTERN = /^\d+(?:\.\d+){1,}$/
const VERSION_PREFIX_SEGMENT_PATTERN = /^v\d+(?:\.\d+)*$/i

function isVersionDirectory(segment: string): boolean {
  return VERSION_SEGMENT_PATTERN.test(segment) || VERSION_PREFIX_SEGMENT_PATTERN.test(segment)
}

function isHashLikeName(stem: string): boolean {
  if (/^[0-9a-f]{16,}$/i.test(stem)) return true
  if (/^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{16,}$/i.test(stem)) return true
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem)
}

function joinTitleParts(parts: string[]): string {
  let result = ''
  for (const part of parts) {
    if (part.length === 0) continue
    if (result.length === 0) {
      result = part
      continue
    }
    const previous = result[result.length - 1] ?? ''
    const next = part[0] ?? ''
    if (LATIN_WORD_PATTERN.test(previous) && CJK_PATTERN.test(next)) result += ' '
    else if (CJK_PATTERN.test(previous) && LATIN_WORD_PATTERN.test(next)) result += ' '
    result += part
  }
  return result
}

function appendSoftwareNoun(base: string, noun: string | null): string {
  if (noun === null || noun.length === 0) return base
  if (base.length === 0) return noun
  if (base.endsWith(noun)) return base
  return joinTitleParts([base, noun])
}

interface TokenTranslation {
  word: string
  /** True when the word is a shorthand guess / preserved proper name. */
  heuristic: boolean
}

function softwareTokenTranslation(token: string): TokenTranslation | null {
  const label = SOFTWARE_TOKEN_LABELS[token]
  if (label !== undefined) return { word: label, heuristic: false }
  const abbreviation = SOFTWARE_ABBREVIATIONS[token]
  if (abbreviation !== undefined) return { word: abbreviation, heuristic: true }
  if (SOFTWARE_KNOWN_TOOL_NAMES.has(token)) return { word: token, heuristic: true }
  return null
}

function softwareDirectoryHint(directories: string[]): string | null {
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const segment = directories[index]
    if (segment === undefined) continue
    const label = SOFTWARE_DIRECTORY_LABELS[segment.toLowerCase()]
    if (label !== undefined && SOFTWARE_HINT_DIRECTORY_LABELS.has(label)) return label
  }
  return null
}

function softwareLocationLabelFor(parsed: ParsedPath, projectName?: string): string {
  const trimmedName = typeof projectName === 'string' ? projectName.trim() : ''
  const rootLabel = trimmedName.length > 0 ? `${trimmedName} 安装目录` : '软件安装目录'
  if (parsed.directories.length === 0) return rootLabel
  const labels: string[] = []
  for (const segment of parsed.directories) {
    const lower = segment.toLowerCase()
    const label = isVersionDirectory(segment)
      ? '版本目录'
      : SOFTWARE_DIRECTORY_LABELS[lower] ?? segment
    const previous = labels.length > 0 ? labels[labels.length - 1] : undefined
    if (previous === label) continue
    labels.push(label)
  }
  return labels.length > 0 ? labels.join(' / ') : rootLabel
}

interface SoftwareTitleResult {
  title: string
  translated: boolean
  hashedName: boolean
  usedHeuristic: boolean
}

function unknownSoftwareTitle(hashedName: boolean, usedHeuristic: boolean): SoftwareTitleResult {
  return { title: UNKNOWN_ENGLISH_TITLE, translated: false, hashedName, usedHeuristic }
}

function composeSoftwareTitle(parsed: ParsedPath): SoftwareTitleResult {
  const stem = parsed.stem
  if (stem.length === 0) return unknownSoftwareTitle(false, false)
  const kind = softwareKindFor(parsed.extension)
  const hashedName = isHashLikeName(stem)

  // A name that already contains Chinese is readable as-is; never replace it.
  if (CJK_PATTERN.test(stem)) {
    return {
      title: appendSoftwareNoun(stem, SOFTWARE_KIND_NOUNS[kind]),
      translated: true,
      hashedName: false,
      usedHeuristic: false
    }
  }

  let working = stem
  let scaleSuffix = ''
  const scale = SOFTWARE_SCALE_PATTERN.exec(working)
  if (scale !== null) {
    const scaleValue = scale[1] ?? ''
    scaleSuffix = `（${scaleValue}% 缩放）`
    working = working.slice(0, scale.index)
  }

  const tokens = splitFileNameTokens(working)
  if (tokens.length === 0) return unknownSoftwareTitle(hashedName, scaleSuffix.length > 0)

  const words: string[] = []
  const modifiers: string[] = []
  const numbers: string[] = []
  let usedHeuristic = scaleSuffix.length > 0
  let firstContentToken: string | null = null

  for (const token of tokens) {
    if (/^[0-9]+$/.test(token)) {
      numbers.push(token)
      continue
    }
    // Unknown English word: never translate, never guess. The view still
    // explains the type/location honestly, but the title stays the fallback.
    const translation = softwareTokenTranslation(token)
    if (translation === null) return unknownSoftwareTitle(hashedName, usedHeuristic)
    if (translation.heuristic) usedHeuristic = true
    if (firstContentToken === null) firstContentToken = token
    if (MODIFIER_TOKENS.has(token)) modifiers.push(translation.word)
    else words.push(translation.word)
  }

  if (words.length === 0) return unknownSoftwareTitle(hashedName, usedHeuristic)

  // English sometimes puts the kind first: `icon-ms-accounts` reads
  // 「微软账户图标」, not 「图标微软账户」.
  if (
    firstContentToken !== null &&
    SOFTWARE_HEAD_FIRST_TOKENS.has(firstContentToken) &&
    words.length > 1
  ) {
    const head = words[0] ?? ''
    const rest = words.slice(1)
    words.length = 0
    for (const word of rest) words.push(word)
    if (head.length > 0) words.push(head)
  }

  let base = joinTitleParts(words)
  if (firstContentToken !== null && SOFTWARE_GENERIC_STEMS.has(firstContentToken)) {
    const hint = softwareDirectoryHint(parsed.directories)
    if (hint !== null) base = joinTitleParts([hint, base])
  }
  const withNoun = appendSoftwareNoun(base, SOFTWARE_KIND_NOUNS[kind])
  if (withNoun.length === 0) return unknownSoftwareTitle(hashedName, usedHeuristic)
  const numberSuffix = numbers.length > 0 ? ` ${numbers.join(' ')}` : ''
  return {
    title: `${withModifiers(withNoun, modifiers)}${scaleSuffix}${numberSuffix}`,
    translated: true,
    hashedName,
    usedHeuristic
  }
}

function softwareWhatItIs(
  parsed: ParsedPath,
  kind: SoftwareFileKind,
  hashedName: boolean,
  translated: boolean
): string {
  if (parsed.baseName.length === 0) return '没有提供文件路径，无法判断它是什么。'
  const extension = parsed.extension
  if (kind === 'unknown') {
    const nameNote = hashedName
      ? '文件名是一串无法识别的字母和数字（可能是哈希或随机编码），'
      : ''
    if (extension.length === 0) {
      return `${nameNote}文件名没有扩展名，静态检查无法确定它是什么类型的文件。`
    }
    return `${nameNote}扩展名 ${extension} 不常见，静态检查无法确定它是什么类型的文件。`
  }
  const core = SOFTWARE_WHAT_IT_IS[kind]
  const evidence = `扩展名 ${extension}`
  if (hashedName) {
    return `文件名是一串无法识别的字母和数字（可能是哈希或随机编码），只能根据${evidence}推测：${core}`
  }
  if (!translated) {
    return `文件名里有无法识别的英文单词，只能根据${evidence}推测：${core}`
  }
  return `从${evidence} 和文件名看，${core}`
}

function softwareWhatFor(
  parsed: ParsedPath,
  kind: SoftwareFileKind,
  translated: boolean,
  role: DependencyRole
): string {
  if (parsed.baseName.length === 0) return '没有提供文件路径，无法判断它有什么用。'
  if ((kind === 'data' || kind === 'binary' || kind === 'unknown') && role === 'cache') {
    return '它放在缓存目录里，通常是程序运行时临时生成的数据，删掉后一般会重新生成（静态检查无法确定具体用途）。'
  }
  if ((kind === 'data' || kind === 'binary') && role === 'output') {
    return '它放在输出目录里，通常是程序运行后生成的结果，一般可以删除或重新生成。'
  }
  const base = SOFTWARE_WHAT_FOR[kind]
  if (kind === 'unknown' || translated) return base
  return `只能根据扩展名推测它的用途：${base}`
}

function softwareConfidence(
  translated: boolean,
  extensionKnown: boolean,
  hashedName: boolean,
  usedHeuristic: boolean
): HumanConfidence {
  if (!translated) {
    if (hashedName) return 'low'
    return extensionKnown ? 'medium' : 'low'
  }
  if (!extensionKnown) return 'medium'
  return usedHeuristic ? 'medium' : 'high'
}

/* ------------------------------------------------------------------ */
/* 2.1.2 · public software-facing API                                 */
/* ------------------------------------------------------------------ */

/**
 * Builds the plain-Chinese “what is it / what is it for” view of one file
 * inside an installed software folder.
 *
 * Deterministic and side-effect free. Never throws; an empty or unusual path
 * still yields an honest low-confidence view with the fallback title.
 */
export function humanizeSoftwareFile(
  relativePath: string,
  options: { projectName?: string } = {}
): HumanSoftwareFileView {
  const rawPath = typeof relativePath === 'string' ? relativePath : ''
  const parsed = parseRelativePath(rawPath)
  const kind = softwareKindFor(parsed.extension)
  const titleInfo = composeSoftwareTitle(parsed)
  const translated = titleInfo.translated && parsed.baseName.length > 0
  const role = inferRole(parsed)
  return {
    typeLabel: softwareTypeLabelFor(parsed.extension),
    title: translated ? titleInfo.title : UNKNOWN_ENGLISH_TITLE,
    whatItIs: softwareWhatItIs(parsed, kind, titleInfo.hashedName, translated),
    whatFor: softwareWhatFor(parsed, kind, translated, role),
    locationLabel: softwareLocationLabelFor(parsed, options.projectName),
    confidence: softwareConfidence(
      translated,
      kind !== 'unknown',
      titleInfo.hashedName,
      titleInfo.usedHeuristic
    )
  }
}

/* ------------------------------------------------------------------ */
/* 2.1.2 · reference usage                                            */
/* ------------------------------------------------------------------ */

const REFERENCE_USAGE_BY_RULE: Record<string, string> = {
  'AI 工作流字段': '工作流运行时按这个路径加载模型、图片或音频等文件。',
  'Markdown 图片与链接': '文档显示图片或打开链接时会用到这个路径。',
  'Markdown 引用式链接定义': '文档打开链接时会按这个路径找到对应的文件。',
  'HTML / Vue / React 资源属性': '程序显示界面时会加载这个资源（图片、样式或脚本）。',
  'CSS url() 资源': '界面套用样式时会加载这个资源文件。',
  '代码 import / require 路径': '脚本运行时会按这个路径加载代码模块。',
  '代码文件读写调用': '脚本运行时会按这个路径读取或写入文件。',
  '配置路径字段': '软件启动或某个功能会读这份配置，并把这段文字当作文件路径。',
  '配置路径字段（无引号）': '软件读取配置时会把这段没有引号的值当作文件路径。',
  '引号内的绝对 / 上级路径': '代码或文本里写死的路径，运行时可能按它读取文件（静态检查不能确认）。',
  '引号内的相对路径': '文本里出现的相对路径，运行时可能按它读取文件（静态检查不能确认）。',
  '普通文本中的裸路径': '只是文本里出现的一段路径，可能是注释或运行时拼接（静态检查无法确认）。',
  '普通文本中的裸目录': '只是文本里出现的一段目录路径，可能是注释或运行时拼接（静态检查无法确认）。',
  'quoted-rooted-path': '代码或文本里写死的路径，运行时可能按它读取文件（静态检查不能确认）。',
  'quoted-relative-path': '文本里出现的相对路径，运行时可能按它读取文件（静态检查不能确认）。',
  'plain-path-token': '只是文本里出现的一段路径，可能是注释或运行时拼接（静态检查无法确认）。',
  'plain-directory-token': '只是文本里出现的一段目录路径，可能是注释或运行时拼接（静态检查无法确认）。',
  'config-path-field': '软件启动或某个功能会读这份配置，并把这段文字当作文件路径。',
  'config-path-unquoted': '软件读取配置时会把这段没有引号的值当作文件路径。',
  'code-import-path': '脚本运行时会按这个路径加载代码模块。',
  'code-file-api': '脚本运行时会按这个路径读取或写入文件。',
  'web-assets': '程序显示界面时会加载这个资源（图片、样式或脚本）。',
  'web-css-url': '界面套用样式时会加载这个资源文件。',
  'workflow-comfyui': '工作流运行时按这个路径加载模型、图片或音频等文件。',
  'markdown-link': '文档显示图片或打开链接时会用到这个路径。',
  'markdown-reference': '文档打开链接时会按这个路径找到对应的文件。'
}

const REFERENCE_USAGE_BY_CATEGORY: Record<RuleCategory, string> = {
  markdown: '文档里的引用，渲染或打开文档时会用到这个路径。',
  code: '代码里的路径引用，运行时可能按它读取文件。',
  config: '配置里的路径引用，软件读取配置时会用到这个路径。',
  web: '界面资源引用，程序显示界面时会加载它。',
  workflow: '工作流里的路径引用，工作流运行时可能加载对应文件。',
  text: '文本里的路径引用，可能只是注释或运行时拼接（静态检查无法确认）。',
  custom: '自定义规则匹配到的路径引用，具体用途要结合文件内容判断。'
}

const REFERENCE_USAGE_FALLBACK =
  '这里写着一段文件路径，程序运行时可能会按它读取文件（静态检查无法确认具体用途）。'

function referenceUsageSentence(ruleName: string, ruleCategory: RuleCategory, context: string): string {
  const byRule = REFERENCE_USAGE_BY_RULE[ruleName]
  if (byRule !== undefined) {
    if (ruleName === 'Markdown 图片与链接' || ruleName === 'markdown-link') {
      if (context.includes('![')) return '文档显示图片时，会按这个路径加载这张图片。'
      if (context.includes('](')) return '文档里的链接指向这个路径，打开链接时会打开对应文件。'
    }
    return byRule
  }
  const byCategory = REFERENCE_USAGE_BY_CATEGORY[ruleCategory]
  if (byCategory !== undefined) return byCategory
  return REFERENCE_USAGE_FALLBACK
}

/**
 * 引用方式 → 中文解释：程序/文档是怎么用到这个文件的。
 *
 * Combines the matched rule (`ruleName`), the rule category and the raw
 * `context` line into one plain sentence. Unknown rules fall back to the
 * category and then to an honest generic sentence.
 */
export function humanizeReferenceUsage(reference: {
  ruleName: string
  ruleCategory: RuleCategory
  context: string
}): string {
  const ruleName = typeof reference?.ruleName === 'string' ? reference.ruleName.trim() : ''
  const ruleCategory = reference?.ruleCategory
  const context = typeof reference?.context === 'string' ? reference.context : ''
  const usage =
    ruleCategory !== undefined
      ? referenceUsageSentence(ruleName, ruleCategory, context)
      : REFERENCE_USAGE_FALLBACK
  if (ruleName.length === 0) return usage
  return `这处引用来自「${ruleName}」规则：${usage}`
}

/* ------------------------------------------------------------------ */
/* 2.1.2 · why it is missing / candidate explanations                  */
/* ------------------------------------------------------------------ */

const MISSING_REASON_BASE =
  '程序会按引用里写的路径到安装目录里找这个文件，但静态检查在磁盘上没找到它。静态检查只读取文件和引用文字、不会运行软件，所以无法确认软件运行时会不会通过别的方式（例如系统目录、注册表或联网下载）找到它。'

/**
 * “为什么找不到 / 找到替代位置意味着什么” 的固定说明句。
 *
 * The returned text does NOT cover “不处理会怎样”; callers pair it with
 * `IF_IGNORED_WITHOUT_CANDIDATES` (or their own sentence) for that question.
 */
export function humanizeMissingReason(hasCandidates: boolean): string {
  if (hasCandidates) {
    return `${MISSING_REASON_BASE}下面列出的这些文件可能是同一份文件的其他位置，处理前建议先看缩略图或文件首行内容核对。`
  }
  return `${MISSING_REASON_BASE}目前没有找到可能的替代文件；如果这个文件本来是可选的、或由程序运行时自动生成，也可能没有影响，但静态检查无法判断。`
}

/** 不处理会怎样（没有候选文件时）。 */
export const IF_IGNORED_WITHOUT_CANDIDATES =
  '如果暂时不处理：引用指向的位置在安装目录里仍然是空的。用到这个文件的功能可能报错、显示缺失或表现异常，也可能暂时不受影响——静态检查无法确认，建议先备份，等真正用到相关功能时再观察。'

/** 全局诚实话术：静态检查能看到什么、看不到什么。 */
export const STATIC_CHECK_LIMIT_NOTE =
  '说明：静态检查只读取安装目录里的文件和引用文字，不会运行软件，也不会联网；所以「找不到文件」只代表当前安装目录里没有它，不能据此断定软件已经坏了。'

const CANDIDATE_EXPLANATIONS: Record<DependencyCandidateReason, string> = {
  'same-name':
    '文件名和缺失的文件完全一样，很可能是同一份文件的另一份副本；替换后程序读到的内容基本不变（替换只改文本引用，不会复制或删除文件）。',
  'similar-name':
    '文件名相近，可能是改过名或同系列的版本；替换前建议用缩略图或文件首行内容核对，确认是同一个文件再改（替换只改文本引用，不会复制或删除文件）。',
  'same-folder':
    '这个文件和缺失的文件在同一个文件夹里，可能是替代版本或同名不同格式的文件；替换前建议先看缩略图或文件首行内容，确认后再处理（替换只改文本引用，不会复制或删除文件）。'
}

/**
 * 候选为什么可能是同一个文件 + 替换后的效果（不夸大、不编造证据）。
 *
 * Only reasons the scanner actually provides are stated: never identical
 * size/hash claims. The final clause always repeats that a replacement only
 * edits the text reference.
 */
export function humanizeCandidateExplanation(reason: DependencyCandidateReason): string {
  switch (reason) {
    case 'same-name':
      return CANDIDATE_EXPLANATIONS['same-name']
    case 'similar-name':
      return CANDIDATE_EXPLANATIONS['similar-name']
    case 'same-folder':
      return CANDIDATE_EXPLANATIONS['same-folder']
    default:
      return '这个文件和缺失的文件有一些相似之处；替换前建议核对内容，确认后再处理（替换只改文本引用，不会复制或删除文件）。'
  }
}
