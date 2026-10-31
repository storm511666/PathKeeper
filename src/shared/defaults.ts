import type { AppSettings, IgnoreKind, MatchModes, RuleCategory } from './types'

/**
 * Built-in rules are copied into each project when it is created. Users can
 * disable, edit or restore them per project; the source here is only a seed.
 */
export interface BuiltinMatchRuleDefinition {
  key: string
  name: string
  description: string
  category: RuleCategory
  pattern: string
  flags: string
  priority: number
  enabled: boolean
}

export interface BuiltinIgnoreRuleDefinition {
  key: string
  pattern: string
  kind: IgnoreKind
  label: string
  sortOrder: number
  enabled: boolean
}

export const DEFAULT_MATCH_MODES: MatchModes = {
  strict: true,
  basename: true,
  directory: true
}

/** Hard ceiling for `AppSettings.maxFileSizeKb`: 1 GB expressed in KB. */
export const MAX_FILE_SIZE_KB_LIMIT = 1_048_576

/**
 * Validate a user-supplied per-file size limit. Backend validation and the
 * settings UI share this rule so the 1 GB ceiling cannot drift (2.1 plan B2).
 */
export function isValidMaxFileSizeKb(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_FILE_SIZE_KB_LIMIT
  )
}

export const DEFAULT_SETTINGS: AppSettings = {
  lastProjectId: null,
  matchModes: { ...DEFAULT_MATCH_MODES },
  caseSensitive: false,
  /**
   * 1 GB (1,048,576 KB) is the supported per-file ceiling in 2.1, not a
   * recommendation: very large files are streamed and reported only.
   */
  maxFileSizeKb: MAX_FILE_SIZE_KB_LIMIT,
  beginnerMode: true,
  dependencyCheckEnabled: true,
  dependencyAutoScanOnOpen: true,
  dependencyAutoWatch: true,
  dependencyAutoRepair: true
}

/**
 * Deliberately explicit, readable regexes. Every pattern exposes a `path`
 * named group, which is the exact span PathKeeper replaces. Capture groups
 * are queried with the `d` flag so the engine can use match indices.
 */
export const BUILTIN_MATCH_RULES: BuiltinMatchRuleDefinition[] = [
  {
    key: 'workflow-comfyui',
    name: 'AI 工作流字段',
    description: 'ComfyUI / 工作流 JSON 中的 filename、ckpt_name、lora_name 等字段。',
    category: 'workflow',
    pattern: String.raw`"(?:filename|subfolder|ckpt_name|lora_name|vae_name|control_net_name|clip_name|unet_name|style_model_name|embedding_name|model_name|model|checkpoint|image|mask|audio|video|file|path|directory|dataset|output_name|input_name|prompt_file)"\s*:\s*"(?<path>(?:[^"\\\r\n]|\\.)+)"`,
    flags: 'gi',
    priority: 110,
    enabled: true
  },
  {
    key: 'markdown-link',
    name: 'Markdown 图片与链接',
    description: 'Markdown 中的 [文本](路径) 与 ![图片](路径)，支持尖括号路径与标题。',
    category: 'markdown',
    pattern: String.raw`!?\[[^\]\r\n]*\]\(\s*<?(?<path>[^)>\r\n]+?)>?(?:\s+["'(][^"')]*["')])?\s*\)`,
    flags: 'g',
    priority: 100,
    enabled: true
  },
  {
    key: 'markdown-reference',
    name: 'Markdown 引用式链接定义',
    description: 'Markdown 引用式链接的定义行：[标签]: 路径。',
    category: 'markdown',
    pattern: String.raw`^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*<?(?<path>[^>\r\n]+?)>?(?:[ \t]+["'(][^"')]*["')])?[ \t]*$`,
    flags: 'gm',
    priority: 100,
    enabled: true
  },
  {
    key: 'web-assets',
    name: 'HTML / Vue / React 资源属性',
    description: 'src、href、poster、data-src 等标签属性中的资源路径。',
    category: 'web',
    pattern: String.raw`\b(?:src|href|poster|data-src|data-original|xlink:href)\s*=\s*["'](?<path>[^"'\r\n]+)["']`,
    flags: 'gi',
    priority: 100,
    enabled: true
  },
  {
    key: 'code-import-path',
    name: '代码 import / require 路径',
    description: 'JavaScript、TypeScript、Python、Vue 等语言中 import / from / require 引用的文件路径。',
    category: 'code',
    pattern: String.raw`\b(?:from|import|require)\s*(?:\(\s*)?["'\x60](?<path>[^"'\x60\r\n]+)["'\x60]`,
    flags: 'gi',
    priority: 100,
    enabled: true
  },
  {
    key: 'web-css-url',
    name: 'CSS url() 资源',
    description: 'CSS / SCSS / Vue 样式中的 url(...) 资源路径。',
    category: 'web',
    pattern: String.raw`url\(\s*["']?(?<path>[^"')\s]+)["']?\s*\)`,
    flags: 'gi',
    priority: 95,
    enabled: true
  },
  {
    key: 'code-file-api',
    name: '代码文件读写调用',
    description: 'Python、JavaScript、Shell 等语言中 open / readFile / load / imread / Path 等调用的手写路径。',
    category: 'code',
    pattern: String.raw`\b(?:open|readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|source|load|loadtxt|imread|imwrite|Image\.open|json\.load|json\.loads|np\.load|np\.loadtxt|np\.save|np\.savez|torch\.load|torch\.save|pd\.read_csv|pd\.read_excel|pd\.read_json|pd\.to_csv|fs\.readFile|fs\.readFileSync|fs\.writeFile|fs\.writeFileSync|fs\.promises\.readFile|fs\.promises\.writeFile|Path|PurePath|PathBuf)\s*\(\s*[rbfu]?["'\x60](?<path>[^"'\x60\r\n]+)["'\x60]`,
    flags: 'gi',
    priority: 95,
    enabled: true
  },
  {
    key: 'config-path-field',
    name: '配置路径字段',
    description: 'JSON / YAML / TOML 配置中以 path、file、dir、input、output、model 等命名的字段（含引号键与列表项）。',
    category: 'config',
    pattern: String.raw`^[\t ]*(?:-[\t ]+)?"?[\w.-]*(?:path|file|dir|folder|source|target|input|output|model|image|dataset|root|ckpt|checkpoint|lora|vae|workflow|data|audio|video|mask)[\w.-]*"?[\t ]*[:=][\t ]*["'](?<path>[^"'\r\n]+)["']`,
    flags: 'gim',
    priority: 90,
    enabled: true
  },
  {
    key: 'config-path-unquoted',
    name: '配置路径字段（无引号）',
    description: 'YAML / 属性文件中未加引号的路径值，例如 model: assets/old.ckpt。',
    category: 'config',
    pattern: String.raw`^[\t ]*(?:-[\t ]+)?"?(?:[\w.-]*(?:path|file|dir|folder|source|target|input|output|root|model|image|dataset)[\w.-]*)"?[\t ]*[:=][\t ]*(?<path>[^\s"'#,\[\]{}<>*?][^\r\n#]*?)[\t ]*(?:#.*)?$`,
    flags: 'gm',
    priority: 85,
    enabled: true
  },
  {
    key: 'quoted-rooted-path',
    name: '引号内的绝对 / 上级路径',
    description: '任意文本中带引号的绝对路径、./ 或 ../ 开头的路径，可带空格、目录名和中文。',
    category: 'text',
    pattern: String.raw`["'\x60](?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|/)[^"'\x60\r\n]+)["'\x60]`,
    flags: 'g',
    priority: 80,
    enabled: true
  },
  {
    key: 'quoted-relative-path',
    name: '引号内的相对路径',
    description: '任意文本中带目录分隔符、带引号的相对路径。',
    category: 'text',
    pattern: String.raw`["'\x60](?<path>[^"'\x60\r\n]*[\\/][^"'\x60\r\n]*\.[A-Za-z0-9]{1,12})["'\x60]`,
    flags: 'g',
    priority: 70,
    enabled: true
  },
  {
    key: 'plain-path-token',
    name: '普通文本中的裸路径',
    description: '没有引号、带目录分隔符的路径片段，用于纯文本、脚本和日志。',
    category: 'text',
    pattern: String.raw`(?<![\w"'=<>])(?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|/)?(?:[\w.$@~-]+[\\/])+[\w.$@~-]+\.[A-Za-z0-9]{1,12})(?![\w"'<>])`,
    flags: 'g',
    priority: 30,
    enabled: true
  },
  {
    key: 'plain-directory-token',
    name: '普通文本中的裸目录',
    description: '没有引号、以分隔符结尾的目录路径，用于纯文本与迁移日志。',
    category: 'text',
    pattern: String.raw`(?<![\w"'=<>])(?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|/)?(?:[\w.$@~-]+[\\/])+)(?![\w])`,
    flags: 'g',
    priority: 25,
    enabled: true
  }
]

const DIRECTORIES: Array<[string, string]> = [
  ['.git', 'Git 元数据'],
  ['.svn', 'SVN 元数据'],
  ['.hg', 'Mercurial 元数据'],
  ['node_modules', 'Node 依赖'],
  ['dist', '构建产物'],
  ['build', '构建产物'],
  ['.next', 'Next.js 构建产物'],
  ['.nuxt', 'Nuxt 构建产物'],
  ['.venv', 'Python 虚拟环境'],
  ['venv', 'Python 虚拟环境'],
  ['__pycache__', 'Python 字节码'],
  ['.idea', 'JetBrains 配置'],
  ['.pathkeeper-backup', 'PathKeeper 备份'],
  ['.cache', '本地缓存']
]

const SUFFIXES: Array<[string, string]> = [
  ['.exe', '可执行文件'],
  ['.dll', '动态库'],
  ['.sys', '系统文件'],
  ['.msi', '安装包'],
  ['.bin', '二进制文件'],
  ['.so', '动态库'],
  ['.dylib', '动态库'],
  ['.a', '静态库'],
  ['.lib', '静态库'],
  ['.class', 'Java 字节码'],
  ['.jar', 'Java 归档'],
  ['.war', 'Java Web 归档'],
  ['.pyc', 'Python 字节码'],
  ['.pyo', 'Python 字节码'],
  ['.o', '目标文件'],
  ['.obj', '目标 / 3D 模型'],
  ['.pdb', '调试符号'],
  ['.zip', '压缩包'],
  ['.7z', '压缩包'],
  ['.rar', '压缩包'],
  ['.tar', '压缩包'],
  ['.gz', '压缩包'],
  ['.tgz', '压缩包'],
  ['.bz2', '压缩包'],
  ['.xz', '压缩包'],
  ['.zst', '压缩包'],
  ['.iso', '光盘镜像'],
  ['.img', '磁盘镜像'],
  ['.mp4', '视频'],
  ['.mkv', '视频'],
  ['.mov', '视频'],
  ['.avi', '视频'],
  ['.webm', '视频'],
  ['.mp3', '音频'],
  ['.wav', '音频'],
  ['.flac', '音频'],
  ['.ogg', '音频'],
  ['.m4a', '音频'],
  ['.aac', '音频'],
  ['.png', '位图'],
  ['.jpg', '位图'],
  ['.jpeg', '位图'],
  ['.gif', '位图'],
  ['.webp', '位图'],
  ['.bmp', '位图'],
  ['.ico', '图标'],
  ['.tif', '位图'],
  ['.tiff', '位图'],
  ['.psd', 'Photoshop 工程'],
  ['.ai', 'Illustrator 工程'],
  ['.eps', '矢量图'],
  ['.pdf', '文档'],
  ['.doc', '文档'],
  ['.docx', '文档'],
  ['.xls', '表格'],
  ['.xlsx', '表格'],
  ['.ppt', '演示文稿'],
  ['.pptx', '演示文稿'],
  ['.db', '数据库'],
  ['.sqlite', '数据库'],
  ['.sqlite3', '数据库'],
  ['.parquet', '数据文件'],
  ['.npy', 'NumPy 数据'],
  ['.npz', 'NumPy 数据'],
  ['.pkl', 'Python 数据'],
  ['.pickle', 'Python 数据'],
  ['.pt', '模型权重'],
  ['.pth', '模型权重'],
  ['.ckpt', '模型权重'],
  ['.safetensors', '模型权重'],
  ['.onnx', '模型文件'],
  ['.h5', '模型 / 数据文件'],
  ['.hdf5', '模型 / 数据文件'],
  ['.glb', '3D 模型'],
  ['.gltf', '3D 模型'],
  ['.fbx', '3D 模型'],
  ['.stl', '3D 模型'],
  ['.step', 'CAD 模型'],
  ['.stp', 'CAD 模型'],
  ['.iges', 'CAD 模型'],
  ['.igs', 'CAD 模型'],
  ['.dwg', 'CAD 图纸'],
  ['.dxf', 'CAD 图纸'],
  ['.rvt', 'Revit 工程'],
  ['.rfa', 'Revit 族'],
  ['.max', '3ds Max 工程'],
  ['.blend', 'Blender 工程'],
  ['.ttf', '字体'],
  ['.otf', '字体'],
  ['.woff', '字体'],
  ['.woff2', '字体'],
  ['.eot', '字体']
]

let sortOrder = 0

export const BUILTIN_IGNORE_RULES: BuiltinIgnoreRuleDefinition[] = [
  ...DIRECTORIES.map(([pattern, label], index) => ({
    key: `dir-${pattern.replace(/^\./, 'dot-')}`,
    pattern,
    kind: 'dir' as const,
    label,
    sortOrder: sortOrder++,
    enabled: true
  })),
  ...SUFFIXES.map(([pattern, label]) => ({
    key: `suffix-${pattern.replace('.', '')}`,
    pattern,
    kind: 'suffix' as const,
    label,
    sortOrder: sortOrder++,
    enabled: true
  }))
]
