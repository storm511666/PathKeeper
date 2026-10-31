# 贡献指南

感谢你愿意参与 PathKeeper。这个项目的核心原则是**安全优先、纯本地、可审计**，任何改动都
不得破坏这些约束。

## 开始之前

1. 安装 Node.js 22.12+ 与 npm。
2. `npm install`
3. `npm run dev`
4. 阅读 [docs/DEVELOPMENT.md](DEVELOPMENT.md) 与 [docs/ARCHITECTURE.md](ARCHITECTURE.md)。

如果 Electron 下载失败：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## 可以贡献什么

- 新格式的内置扫描规则（需附最小样本与测试）
- 路径归一化 / 替换边界情况
- Windows 高 DPI、输入法、键盘可访问性
- 备份完整性、回滚冲突处理
- 文档、示例项目、翻译

## 开发约定

- TypeScript strict；主进程/预加载/渲染层分别通过类型检查。
- `src/main/core` 不得引入 Electron 依赖。
- 所有文件修改必须经过扫描缓存与 stale 校验；不得新增静默写入路径。
- 不引入网络请求、遥测、自动更新、外部字体或远程图片。
- 不引入需要原生编译的依赖（保持 `npm install` 零工具链）。
- 用户可见文案使用简体中文，代码注释/标识符使用英文。
- 提交前运行：

```powershell
npm run typecheck
npm test
npm run build
```

## 提交 PR

- 描述动机、行为变化与验证方式。
- UI 改动附截图（可使用 demo 项目）。
- 新增规则附样本文本与单测。
- 安全相关修改请说明威胁模型与失败时的行为。

## 安全报告

请勿在公开 issue 中披露可利用细节，见 [SECURITY.md](SECURITY.md)。

## License

贡献即表示同意以 [MIT License](LICENSE) 授权。
