# 测试指南

## 单元 / 集成测试（Vitest）

```powershell
npm test
```

覆盖范围：

- `tests/core/**` — 路径归一化、三种匹配模式、编码/BOM、规则校验、扫描器、替换文本；
  大文件安全读取（1 GB 稀疏二进制、流式文本、预算停止、取消）、新手可读词典（C7 表）、
  PE 导入表解析、`.lnk` 解析、渲染层 bridge envelope 包装；
- `tests/backend/**` — SQLite schema/种子（含 v3 迁移与旧 4 MB 默认值一次性迁移）、
  项目/规则/设置 CRUD、扫描会话、备份与写入、stale 扫描中止、回滚与冲突检测、
  历史/备份管理、软件项目添加/体检、文件预览边界。

跑单个文件或过滤：

```powershell
npx vitest run tests/core/path.test.ts
npx vitest run -t "basename"
```

## 端到端测试（Playwright + Electron）

端到端脚本位于 `tests/e2e/app.e2e.mjs`，通过 Playwright 的 Electron 驱动启动真实应用，
并使用临时 userData 与 demo-project 副本，因此不会污染你的真实数据。

```powershell
npm run build
npm run test:e2e
```
脚本会验证：

1. 应用以隔离 profile 启动并加载项目；
2. 添加 demo 项目；
3. 加载内置新手示例，验证“砖墙贴图（旧）”中文问题卡、候选缩略图与原始路径可达；
4. 录入迁移任务、扫描结果表格出现；
5. 应用选中修改后磁盘内容确实改变、备份目录与 manifest 存在；
6. 迁移历史回滚后文件恢复原状；
7. 设置中心/规则/备份页面可加载；
8. 目录迁移匹配；
9. 1 GB 上限可通过 IPC 保存，1 GB + 1 KB 被拒绝；
10. 软件体检：添加软件项目、PE 导入表解析出 DLL 依赖、软件报告页自动打开；
11. 软件报告路径问题给出「它是什么 / 它有什么用 / 不处理会怎样」四问四答，并可切换
    “路径引用检查范围”（仅配置文件 / 全部文本 / 不检查）；
12. 关键截图输出到 `docs/screenshots/`（含 `beginner-check.png`、`software-scan.png`、
    `software-path-help.png`）。

### 环境要求

- 已通过 `npm install` 安装 Electron 运行时；
- Windows 桌面会话（Electron 需要可用的窗口环境）；
- 如果 Electron 下载失败，设置 `ELECTRON_MIRROR` 后重试，见
  [PACKAGING.md](PACKAGING.md)。

脚本会自动创建临时项目副本和 userData，结束后清理，不改动真实项目与
`examples/demo-project`。

### 对打包产物做同一套 E2E

先构建免安装包，然后让脚本启动打包后的 exe：

```powershell
npm run dist:dir
$env:PATHKEEPER_E2E_EXECUTABLE = "release\win-unpacked\PathKeeper.exe"
npm run test:e2e
```

这会验证 asar 打包后的主进程、`node:sqlite` 与预加载桥接仍然完整，不只是开发构建可用。

## 手工验收清单

- [ ] 添加两个项目，切换后规则/历史互不串项目。
- [ ] 旧路径带 `./`、`../`、反斜杠、项目内绝对路径时均能命中。
- [ ] 关闭 Basename 模式后，裸文件名引用不再命中。
- [ ] 目录迁移把整个子目录引用重映射。
- [ ] 扫描后手动修改一个文件，再应用 → 整批中止并提示重新扫描，磁盘无变化。
- [ ] 应用后检查 `.pathkeeper-backup/<时间戳>/manifest.json`。
- [ ] 只回滚一次，文件恢复；回滚后再次修改文件 → 回滚冲突并拒绝。
- [ ] 删除备份后，历史中显示备份不可用且回滚按钮禁用。
- [ ] 自定义正则保存后立即参与下一次扫描。
- [ ] 关闭网络/断网时应用功能完全正常。
- [ ] 设置里把单文件上限设为 1048576 保存成功，重启后仍为 1 GB；输入 1048577 报错。
- [ ] 项目里放一个 1 GB 的二进制文件，扫描不卡死、不涨内存（只读文件头即跳过）。
- [ ] 20 MB 文本文件可扫完；扫描中点“停止扫描”能立即停下且无文件被修改。
- [ ] 新手模式下问题卡显示「砖墙贴图（旧）」等中文说明，展开“技术细节”能看到原始路径。
- [ ] “扫描一个软件”选一个程序/安装目录：能显示名称/版本/只读徽标、DLL 依赖分类、
      无法判断说明；页面无任何下载/修复/提权按钮；全程不启动目标程序。
