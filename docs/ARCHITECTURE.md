# PathKeeper 架构说明

本文记录实现层面的关键决策与不变量，方便维护者快速定位代码。

## 进程划分

```text
┌──────────────────────────── renderer (React) ────────────────────────────┐
│ 多页 UI（智能检查 / 软件体检 / 路径迁移 / 历史 / 设置）                     │
│ 表格选择 · 确认弹窗 · CSV 导出 · 扫描进度 · 新手可读层 · 软件报告          │
│ 只能访问 window.pathkeeper（contextBridge 暴露的窄 API）                    │
│ api/bridge.ts 把 envelope 还原成本地 Error（保留 code/details）             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ invoke / event（结构化 envelope，错误即数据）
┌───────────────────────────────▼──────────────────────────────────────────┐
│ preload (sandboxed)                                                       │
│ 白名单 IPC 方法；只转发 envelope，不在桥接层抛异常                         │
│ 不暴露 ipcRenderer、Node、文件系统                                         │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────┐
│ main                                                                      │
│  ipc.ts — 参数收口、对话框、响应 envelope、软件图标                        │
│  services/PathKeeperService — 项目/规则/扫描会话/应用/回滚/历史/软件       │
│  services/software-info — 版本信息（只读）、快捷方式解析                    │
│  services/file-preview — 只读缩略图/文本预览                               │
│  db/ — SQLite（node:sqlite, WAL）                                          │
│  core/ — 纯 Node 引擎（无 Electron / DB 依赖）                             │
│    safeRead / scan / dependencyScan / autoCheck / pe / softwareScan       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **core 不做任何 I/O 决策之外的副作用**：只读文件、计算匹配，绝不写文件。

> contextBridge 在跨上下文传递异常时只保留 message/stack，自定义的 `code` 会丢失。
> PathKeeper 的通俗错误引导依赖稳定错误码，因此 preload 只转发
> `IpcResponse` envelope，由渲染层 `api/bridge.ts` 在本地重新抛出带 `code`/`details`
> 的 `PathKeeperIpcError`。

- **只有 services 的 apply / rollback 会写用户文件**，且必须先经过扫描缓存与 stale 校验。
- **渲染层没有 Node 权限**，所有磁盘操作都在主进程完成。
- 生产环境用 `webRequest.onBeforeRequest` 拒绝全部 http(s)/ws(s) 请求，默认会话拒绝所有
  权限申请；导航、window.open、webview 全部禁止。

## 安全不变量

1. 扫描（项目迁移 / 自动检查 / 依赖体检 / 软件体检）是纯读取，不产生任何文件写入；
   软件体检也绝不启动或加载目标程序。
2. 应用修改必须满足：
   - 扫描 token 存在且未过期；
   - 每个选中 occurrence 来自缓存扫描；
   - 所有选中文件的当前 SHA-256 与扫描快照一致（否则整批中止）；
   - 写入路径必须落在项目根内；
   - 先备份，后写入；备份 manifest 记录原始 hash。
3. 只替换 occurrence 中的 `offset/length` 区间，并再次校验区间原文等于 `oldText`。
4. 冲突时整批中止，绝不「尽量修改」。
5. 回滚要求当前文件仍等于迁移后的 hash，避免覆盖扫描之后的其他人工修改。
6. 所有写操作（apply/rollback）串行执行。

## 数据模型

数据库位于 `<userData>/pathkeeper.sqlite`，启用 WAL 与外键。

| 表 | 用途 |
| --- | --- |
| `meta` | schema 版本、安装信息、一次性设置迁移标记 |
| `projects` | 项目根、名称、最近打开时间；v3 起含 `kind`（project/software）与 `entry_path` |
| `settings` | 键值形式的全局设置（上次项目、匹配模式、单文件上限等） |
| `ignore_rules` | 每个项目一套忽略规则（内置 + 自定义） |
| `match_rules` | 每个项目一套路径匹配正则（内置 + 自定义） |
| `migrations` | 一次写入的历史记录、状态、备份引用 |
| `migration_files` | 被修改文件、备份相对路径、修改前后 hash |
| `backups` | 备份目录索引、文件数、大小、孤儿状态 |
| `software_dependencies` | 软件体检结果的可选持久化（v3 追加，当前仅建表） |

删除项目会删除其数据库记录，但**不会删除项目目录中的 `.pathkeeper-backup`**；备份只能在
设置中心显式删除。

## 大文件安全读取（2.1）

单文件上限默认 1 GB（`1_048_576` KB），但引擎从不整文件读入：

1. 先读 ≤8 KB 文件头做嗅探（NUL、BOM、UTF-16 启发式），二进制直接跳过；
2. ≤16 MB：完整读取并解码，计算 SHA-256 快照，允许自动修复；
3. 16 MB–1 GB：流式按行扫描（256 KB 分块、`TextDecoder` fatal、中途 NUL 即停止），
   只产出报告，不写快照 → 应用时该项自动跳过；
4. >64 MB 额外提示“仅报告”；
5. 单次扫描共享预算（默认 512 MB / 120 秒），超预算停止并在结果里 `budgetStopped: true`；
   `scanCancel` 可随时中止迁移扫描、依赖体检和软件体检。

## 软件体检（2.1）

- `Project.kind === 'software'` 的项目根 = 软件安装目录，`entryPath` = 选中的程序；
- 文本引用复用依赖引擎（`scanDependencies`），与普通项目共用规则/忽略/预算；
  默认范围（`textScan: 'config'`）只内容扫描配置格式，并跳过日志/缓存/脚本包/捆绑运行时/
  测试/安装器清单，只使用非“裸路径”规则，剔除指向被忽略目录的引用；
  `textScan: 'all'` 才做全文本扫描，`textScan: 'off'` 跳过文本检查。报告最多展示 80 条，
  并如实给出“跳过/截断”数量；
- 二进制依赖由纯 Node 的 PE 导入表解析器完成（`core/pe.ts`）：
  只读 DOS/PE/可选头、节表和导入目录，按 RVA→文件偏移做小范围定位读取，
  绝不整文件加载、绝不 `LoadLibrary`/执行目标程序；
- DLL 解析顺序：安装目录 → `bin/lib/runtime/plugins` → `System32` → `SysWOW64` → `PATH`；
  `api-ms-win-*` / `ext-ms-*` 一律按系统组件处理，避免假问题；
- 分类为 `app-local / system / unknown`，缺失项只给建议（重装运行库 / 询问作者），
  不提供下载、复制、提权或自动修复；
- 报告里的每条路径问题都会经过共享解释层（`src/shared/fileHumanize.ts`）：
  `humanizeSoftwareFile` 给出中文类型/标题/它是什么/有什么用/所在位置/推测置信度，
  `humanizeReferenceUsage` 解释引用方式，`humanizeMissingReason` / `IF_IGNORED_WITHOUT_CANDIDATES`
  说明找不到的原因和不处理的后果；候选文件带缩略图或首行预览以及“替换后怎样”的说明。
  未知英文名不编造翻译，但一定给出类型、用途推测和查看方式；
- 版本信息通过一次只读 PowerShell 元数据查询获取（5 秒超时、失败回退文件名）；
  图标由主进程 `app.getFileIcon` 读取。

## 扫描流程

1. 把旧路径/新路径解析为项目内绝对路径与规范化相对路径（拒绝越界、空值、根目录）。
2. 从数据库读取本项目启用的匹配规则与忽略规则。
3. 遍历项目文件（不跟随 symlink）：
   - 目录/后缀/glob 忽略；
   - 先做 ≤8 KB 头部嗅探：二进制（NUL）直接跳过，不读全文件；
   - 超过单文件上限 / 不支持的编码 → 跳过并计数；
   - ≤16 MB 解码（UTF-8 / UTF-8 BOM / UTF-16 LE / BE）并计算 SHA-256；
   - 16 MB–1 GB 流式按行扫描，只出报告不写快照（apply 时自动跳过该项）；
   - 共享扫描预算（默认 512 MB / 120 秒），超预算停止并标记 `budgetStopped`。
4. 对每个文件运行每条规则；利用 `d` 旗标取得捕获组精确下标；去重重叠捕获（高优先级/更
   具体的规则胜出）。
5. 过滤 URL、模板变量、glob 通配符、包管理器协议等非本地路径。
6. 对每个候选路径做归一化并尝试匹配：
   - 源文件相对解析；
   - 项目根相对解析；
   - 按启用的模式（strict / basename / directory）判定；
   - 生成保留原写法风格的新路径。
7. 组装 occurrence（行号、列、50 字符上下文、偏移、规则来源），并返回快照供 apply 校验。

扫描会话仅保存在主进程内存中（按 token），不会把源文件内容传到渲染层。

## 路径替换风格

| 原引用形态 | 处理方式 |
| --- | --- |
| 项目根相对 `assets/a.png` | 新值同样为项目根相对 |
| 源文件相对 `../assets/a.png` | 从当前源文件目录重新计算相对路径 |
| `./` 前缀 | 结果保留 `./` |
| Windows 反斜杠 | 结果使用反斜杠 |
| JSON 双反斜杠 | 结果重新转义为 `\\` |
| 项目内绝对路径 | 生成新的项目内绝对路径 |
| Web 根路径 `/assets/a.png` | 保留前导 `/` |
| 裸文件名 `a.png` | 使用新文件名；目录迁移时计算新相对路径 |

匹配统一在规范化 POSIX 路径空间内进行，输出前再还原写法风格。

## 数据库与编码

- 使用 Electron 内置 Node 24 的 `node:sqlite`（`DatabaseSync`），不需要 `better-sqlite3`，
  也不需要 `electron-rebuild` 或原生工具链。
- 文件编码在扫描时识别，apply 时按原编码与 BOM 写回；无法可靠解码的文件不会被扫描/修改。
- 写入采用「同目录临时文件 + rename」，并保留原文件权限。

## 可测试性

- `core/` 与 `db/`、`services/` 不依赖 Electron（除 `ipc.ts` 的对话框与窗口）。
- 服务通过注入的 `userDataPath` 构造，因此可以在临时目录中跑完整读写/回滚集成测试。
- E2E 用 Playwright 的 Electron 驱动，配合 `PATHKEEPER_USER_DATA` 隔离测试数据。
