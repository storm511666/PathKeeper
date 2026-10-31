export interface BridgeError extends Error {
  code?: string
  details?: unknown
}

export interface ErrorDescription {
  /** Friendly, user-facing explanation. */
  message: string
  /** Backend error code when the bridge provided one. */
  code: string | null
  /** Original technical message, kept for a details line/tooltip. */
  raw: string | null
}

interface FriendlyRule {
  test: RegExp
  message: string
}

const FRIENDLY_RULES: FriendlyRule[] = [
  {
    test: /STALE|CONFLICT|CHANGED|POST_HASH|HASH_MISMATCH/i,
    message: '目标文件在扫描后已被修改，为避免覆盖他人改动，操作已中止。请重新扫描后再试。'
  },
  {
    test: /BACKUP[_ -]?(MISSING|GONE|REMOVED)|MISSING[_ -]?BACKUP/i,
    message: '备份文件缺失或已被删除，无法执行回滚。'
  },
  {
    test: /SCAN[_ -]?(EXPIRED|TOKEN|UNKNOWN)|EXPIRED/i,
    message: '本次扫描结果已过期，请重新扫描后再应用。'
  },
  {
    test: /NOT[_ -]?FOUND|NO_SUCH|ENOENT/i,
    message: '找不到对应的记录或文件，可能已被移动或删除。请刷新后重试。'
  },
  {
    test: /EACCES|EPERM|PERMISSION|ACCESS_DENIED/i,
    message: '没有权限访问该文件或目录，请检查文件是否被其他程序占用。'
  },
  {
    test: /ENOSPC|DISK|NO_SPACE/i,
    message: '磁盘空间不足，操作未完成。'
  },
  {
    test: /EBUSY|LOCKED|BUSY/i,
    message: '文件正被其他程序占用，请关闭相关程序后重试。'
  }
]

export function asBridgeError(value: unknown): BridgeError {
  if (value instanceof Error) return value
  const error = new Error(typeof value === 'string' ? value : '未知错误')
  return error
}

export function errorMessage(value: unknown): string {
  return describeError(value).message
}

export function errorCode(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return null
}

export function describeError(value: unknown): ErrorDescription {
  const error = asBridgeError(value)
  const code = errorCode(value)
  const raw = typeof error.message === 'string' && error.message.length > 0 ? error.message : null
  const haystack = `${code ?? ''} ${raw ?? ''}`
  const matched = FRIENDLY_RULES.find((rule) => rule.test.test(haystack))
  return {
    message: matched ? matched.message : raw ?? '操作失败，请重试。',
    code,
    raw: matched ? raw : null
  }
}

/* ------------------------------------------------------------------ */
/* Beginner-facing error help                                          */
/* ------------------------------------------------------------------ */

export interface HumanError {
  title: string
  message: string
  steps: string[]
  /** Raw backend message. Hidden inside a "技术细节" disclosure. */
  technical: string | null
  code: string | null
}

const HUMAN_GUIDES: Record<string, Omit<HumanError, 'technical' | 'code'>> = {
  DEPENDENCY_DISABLED: {
    title: '智能检查现在是关闭的',
    message: '你之前在设置里关闭了智能检查。这个开关不会影响手动路径迁移。',
    steps: ['打开“设置中心”', '找到“智能检查”开关并打开', '回到“智能检查”重新试一次']
  },
  DEPENDENCY_PREFLIGHT_FAILED: {
    title: '这个文件暂时不能用来修复',
    message: 'PathKeeper 在写入之前检查了文件位置和类型，发现还有一项不符合要求，所以没有修改任何文件。',
    steps: ['确认文件确实在项目文件夹里', '重新选择文件，或按提示修正后重试', '如果拿不准，先点“跳过”这一项']
  },
  DEPENDENCY_REPAIR_EMPTY: {
    title: '没有找到可以修改的引用',
    message: '文件位置检查通过了，但项目里没有匹配到可替换的旧路径文字。可能这个引用写法不在扫描规则里，或者已经修好了。',
    steps: ['点“重新体检”看问题是否还在', '如果问题还在，使用“手动路径迁移”并检查路径写法', '仍然不行时，把引用所在文件发给维护者检查']
  },
  DEPENDENCY_CACHE_FAILED: {
    title: '缓存文件没有移动',
    message: 'PathKeeper 只移动已确认属于缓存的现有文件；这次没有找到可安全移动的项，所以没有改动任何文件。',
    steps: ['重新体检，确认缓存文件还在', '如果缓存文件已不存在，让原程序重新生成', '不要手动删除不认识的缓存目录']
  },
  PROJECT_ROOT_INVALID: {
    title: '这个文件夹不能作为项目',
    message: 'PathKeeper 需要一个真实存在的文件夹，并且你有读取权限。',
    steps: ['确认文件夹没有被删除或改名', '换一个最外层的项目文件夹', '不要选择单个文件或系统盘根目录']
  },
  FILE_NOT_FOUND: {
    title: '找不到这个文件或示例',
    message: '它可能已经被移动、改名或删除。PathKeeper 不会因此修改任何项目文件。',
    steps: ['确认文件仍在原来的文件夹', '重新加载示例工程或重新添加项目', '找不到时可以先跳过这一项']
  },
  PATH_OUTSIDE_PROJECT: {
    title: '这个路径不在当前项目里',
    message: 'PathKeeper 只处理当前项目文件夹里的文件，避免误改项目外的内容。',
    steps: ['在项目文件夹里选择新位置', '确认项目根目录选对了', '不要把盘符或项目外的绝对路径填进来']
  },
  NO_RULES: {
    title: '没有可用的匹配规则',
    message: '依赖检查依赖内置的路径识别规则；规则被全部关闭时就无法检查。',
    steps: ['打开“设置中心”', '在高级模式里恢复默认匹配规则', '回到“智能检查”重新体检']
  },
  SCAN_FAILED: {
    title: '检查没有完成',
    message: '读取项目时遇到了问题。没有文件被修改，可以安全地重试。',
    steps: ['确认项目文件夹仍然存在、可以读取', '关闭可能占用文件的程序', '重新体检；仍失败时查看技术细节并反馈']
  },
  SCAN_CANCELLED: {
    title: '扫描已停止',
    message: '你点了“停止扫描”，所以这一次扫描提前结束了。没有文件被修改，随时可以再扫一次。',
    steps: ['需要时点“重新体检”或“开始扫描”', '文件很大时扫描本来就慢，可以只扫描需要的项目', '如果总是在中途停下，可在设置里调小“单个文件大小上限”']
  },
  SOFTWARE_TARGET_INVALID: {
    title: '这个位置不能用来体检软件',
    message: '请选择一个 .exe 程序、它的快捷方式，或者软件自己的安装文件夹。PathKeeper 不会启动它。',
    steps: ['在“扫描一个软件”里重新选择程序或安装目录', '不要选择系统盘根目录或用户主目录', '如果是快捷方式，也可以直接选它指向的程序']
  },
  SOFTWARE_SYSTEM_DIRECTORY: {
    title: '这是系统目录，不能当作软件目录',
    message: 'C:\\Windows 这类目录是操作系统自身的位置，不适合作为软件体检范围。',
    steps: ['改选具体软件的安装目录', '例如 C:\\Program Files\\软件名 这样的文件夹', '不确定时，从快捷方式右键“打开文件所在位置”找到安装目录']
  },
  SOFTWARE_INSPECT_FAILED: {
    title: '没有读到这个程序的信息',
    message: '读取程序版本信息时失败了，但你的文件没有被修改。可以继续用它所在的目录做只读体检。',
    steps: ['确认文件没有被删除或占用', '改选软件安装目录再试一次', '看不到版本号不影响后面的体检结果']
  },
  SOFTWARE_SCAN_FAILED: {
    title: '软件体检没有完成',
    message: '读取软件目录时遇到了问题。全程只读，没有启动或修改这个软件。',
    steps: ['确认软件目录可以正常打开', '关闭可能占用文件的程序后重试', '仍然失败时查看“技术细节”并反馈']
  },
  SCAN_STALE: {
    title: '项目在检查后发生了变化',
    message: '为了避免覆盖你刚做的改动，PathKeeper 已停止这一次写入。',
    steps: ['点“重新体检”', '确认最新的文件状态', '再决定是否修复']
  },
  APPLY_FAILED: {
    title: '修复没有写入',
    message: '写入前检查没有通过，或者有文件被占用。PathKeeper 已保持项目原样。',
    steps: ['关闭占用项目文件的程序', '重新体检后再试', '如果反复失败，先不要继续批量修复']
  },
  INTERNAL: {
    title: '软件遇到一个内部问题',
    message: '这不是你操作错了。项目文件没有被自动修改，可以先重试。',
    steps: ['重新体检或重启软件', '确认项目文件夹可读写', '仍然失败时，把技术细节反馈给维护者']
  }
}

const GENERIC_STEPS = [
  '确认项目文件夹还在、可以正常打开',
  '重新体检一次，让软件读取最新状态',
  '如果仍然失败，展开“技术细节”并反馈'
]

export function humanizeError(value: unknown): HumanError {
  const described = describeError(value)
  const code = described.code
  const guide = code ? HUMAN_GUIDES[code] : undefined
  return {
    title: guide?.title ?? '操作没有完成',
    message: guide?.message ?? described.message,
    steps: guide?.steps ?? GENERIC_STEPS,
    technical: described.raw,
    code
  }
}
