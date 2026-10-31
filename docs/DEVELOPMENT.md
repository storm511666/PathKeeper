# 开发者说明

这份文档面向想修改 PathKeeper 的贡献者，说明模块边界、关键约定与验证方式。
产品与用户操作说明见 [README](../README.md)。

## 环境

- Windows 10/11 x64（主要目标平台）
- Node.js 22.12+（推荐 24 LTS）
- npm 10+

```powershell
npm install
npm run dev
```

Electron 二进制下载失败时，见 [打包教程](PACKAGING.md) 中的镜像设置。

## 目录

```text
src/
  main/
    core/       纯 Node 的路径归一化、扫描器、安全读取、PE 导入解析、文本编解码、规则引擎
    db/         node:sqlite 连接、schema 迁移、仓储
    services/   项目/规则/设置、扫描会话、安全写入、备份、回滚、软件信息、文件预览
    ipc.ts      IPC handlers、原生对话框、结构化响应 envelope、软件图标
    index.ts    Electron 主进程入口与本地网络策略
    window.ts   窗口创建、导航/权限限制
  preload/      contextBridge 暴露的最小 API（只转发 envelope）
  renderer/     React 19 多页 UI（智能检查/软件体检/路径迁移/历史/设置/dev mock）
  shared/       跨进程 DTO、IPC 通道、默认规则、新手可读词典
tests/
  core/         路径/编码/规则/扫描引擎/大文件/PE/可读性单测
  backend/      SQLite、服务、IPC、软件体检、真实示例项目集成测试
  e2e/          Playwright + Electron 端到端测试
examples/       demo-project（迁移）、beginner-sample（新手示例/软件目录）
docs/           架构、隐私、打包、规则、测试文档
```

## 模块边界

### core（纯 Node，不依赖 Electron/DB）

公开 API 见 `src/main/core/index.ts`，包括：

- `resolveMigrationPaths(projectRoot, oldInput, newInput, kindInput)`
- `scanProject(options)`：遍历项目、匹配路径、生成 occurrence 与文件快照
- `autoCheckProject(options)` / `scanDependencies(options)`：只读自动检查与依赖体检
- `scanSoftwarePackage(options)`：软件文本引用 + PE 导入表 DLL 依赖（`core/pe.ts`）
- `probeTextFile` / `streamTextLines` / `createReadBudget`：大文件安全读取与扫描预算
- `validateMatchRule` / `testMatchRule`：正则规则校验与样本测试
- `decodeTextBuffer` / `encodeTextBuffer` / `applyTextEdits`
- `createIgnoreEvaluator`

`core` 不做文件写入，也不读数据库或环境配置。扫描结果是确定性的：
`occurrence.filePath` 是项目相对 POSIX 路径，文件快照保存绝对路径与 SHA-256；
排序固定为文件路径 → offset → 规则。

### services / db

- `PathKeeperService` 是业务门面，构造参数只有 `userDataPath`，因此可以在临时目录
  里完整测试。
- 扫描结果在内存中缓存（随机 token，TTL 30 分钟）；apply 只接受缓存中的
  occurrence，并在写入前重新哈希所有选中文件。
- 备份写入 `<项目根>/.pathkeeper-backup/<时间戳>/files/`，同时写 `manifest.json`。
- 回滚前要求文件仍等于迁移后的 hash；否则结构化拒绝，不写任何文件。
- 数据库文件：`<userDataPath>/pathkeeper.sqlite`，启用 WAL 与外键。
- `ipc.ts` 是唯一把服务暴露给 Electron 的层；所有响应包装为
  `{ ok: true, data }` 或 `{ ok: false, error }`。

### renderer

- 只通过 `window.pathkeeper`（见 `src/shared/api.ts`）访问主进程；该对象是
  envelope 形式的 bridge，由 `src/renderer/src/api/bridge.ts` 包装成会抛正常
  `Error`（带 `code`/`details`）的 `PathKeeperApi`。这样跨 contextBridge 时错误码不会丢。
- 禁止 import Node/Electron；所有文件、数据库、对话框操作都走 IPC。
- 页面：智能检查、软件体检（`kind==='software'` 的项目自动进入）、路径迁移、迁移历史、
  设置中心；新手模式默认隐藏高级页面。扫描结果默认全选，但必须经过二次确认才能写入。
- 开发预览：`npm run dev:renderer`（http://localhost:5180）。当且仅当开发模式且
  没有 preload bridge 时，会加载 `src/renderer/src/dev/` 的 mock API；生产构建不包含
  该逻辑。

## 关键不变量

1. 扫描只读；任何写文件都必须由 apply / rollback 服务执行。
2. 选中文件在扫描后发生变化 → 整批中止，写入前不做部分提交。
3. 只替换规则捕获的 path 区间，并再次校验区间原文。
4. 写入路径必须位于项目根内，拒绝 `..` 与 symlink 逃逸。
5. 写前备份、写后记录 hash；回滚冲突时拒绝覆盖。
6. 运行时无网络请求、无遥测、无自动更新；生产环境拦截所有 http(s)/ws(s)。

## 路径匹配约定

- 输入旧路径/新路径会转换为项目内绝对路径与 POSIX 项目相对路径。
- 匹配模式：
  - `strict`：解析后的相对路径与旧路径完全一致；
  - `basename`：文件名一致，按引用风格重新计算完整新路径；
  - `directory`：仅目录迁移，重映射旧目录下所有引用（含目录自身）。
- 替换保留原写法：根相对/源文件相对/`./`/`../`/Windows 反斜杠/项目内绝对路径/
  JSON 转义反斜杠/Web 根路径。
- URL、模板变量、环境变量、glob、项目外绝对路径一律不处理。
- 修改规则时请补充 `tests/core` 对应用例；内置规则源在 `src/shared/defaults.ts`。

## 测试与构建

```powershell
npm run typecheck       # 主进程 + 渲染层
npm test                # 222 个单测/集成测试
npm run build           # 生产构建
npm run test:e2e        # Playwright Electron E2E（需先 npm run build）
npm run dist:dir        # 免安装 Windows 目录
npm run dist            # NSIS 安装包
npm run dist:portable   # 便携版
```

端到端测试用临时 userData 与示例项目副本，不会修改真实数据；也可对打包产物运行，
见 [测试指南](TESTING.md)。
