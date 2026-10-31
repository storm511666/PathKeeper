# 打包教程

PathKeeper 使用 [electron-builder](https://www.electron.build/) 打包 Windows x64 安装包和
便携版。以下是当前仓库验证过的流程。

## 1. 前置条件

- Windows 10/11 x64
- Node.js 22.12+（推荐 Node 24 LTS）
- npm 10+
- 能访问 npm registry 与 Electron / electron-builder 二进制下载源

## 2. 安装依赖

```powershell
cd PathKeeper
npm ci
```

首次安装会下载 Electron 运行时（约 100 MB）。如果下载失败，设置公共镜像后重试：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
```

electron-builder 自身还需要 NSIS 等工具。如果它在打包阶段卡在 downloads，可使用：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

> 这些镜像只是开发环境的下载加速，不写入应用，不会影响运行时「无网络」特性。

## 3. 开发运行

```powershell
npm run dev
```

Electron 主进程与 Vite 渲染层会同时启动。修改主进程/预加载会重启 Electron；修改渲染层会
热更新。

## 4. 构建产物

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run build` | `out/` | 未打包的编译结果；可用于检查构建 |
| `npm run dist:dir` | `release/win-unpacked/` | 免安装目录，最快验证 |
| `npm run dist` | `release/PathKeeper-<version>-x64-setup.exe` | 安装版 |
| `npm run dist:portable` | `release/PathKeeper-<version>-portable-x64.exe` | 便携版 |
| `npx electron-builder --win` | 上面两个 exe | 一次生成安装版 + 便携版 |

`dist` / `dist:portable` 会自动先执行类型检查与 electron-vite 构建。

> 说明：electron-builder 26 的 NSIS 载荷默认使用 7z `-mx=9` 高压缩，在较慢的机器上
> 可能耗时数分钟。可临时使用较快的级别：
>
> ```powershell
> $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = "5"
> npx electron-builder --win
> ```
>
> 需要一次生成安装版 + 便携版时，直接使用最后这条命令。

### 免安装目录验证

```powershell
npm run dist:dir
release\win-unpacked\PathKeeper.exe
```

应用数据位于 `%APPDATA%\PathKeeper`。测试时可以设置独立数据目录：

```powershell
$env:PATHKEEPER_USER_DATA = "$env:TEMP\pathkeeper-test-profile"
release\win-unpacked\PathKeeper.exe
```

## 5. 配置

打包配置集中在 `electron-builder.yml`：

- `appId: io.pathkeeper.app`
- `productName: PathKeeper`
- 文件仅包含 `out/**` 与 `package.json`（运行时依赖均被打包进渲染 bundle，无原生模块）
- Windows 图标 `build/icon.ico`
- NSIS：非一键安装、允许选择目录、创建桌面/开始菜单快捷方式，产物名 `PathKeeper-<version>-x64-setup.exe`
- Portable：单文件便携版，产物名 `PathKeeper-<version>-portable-x64.exe`
- `publish: null`：不启用任何自动发布/更新

图标源文件由脚本生成：

```powershell
python scripts/generate_icon.py
```

需要 Pillow。生成 `build/icon.png` 与多尺寸 `build/icon.ico`。

## 6. 代码签名（可选，但建议发布时配置）

没有签名时，Windows SmartScreen 可能提示「未知发布者」。取得代码签名证书后，可使用
electron-builder 支持的环境变量：

```powershell
$env:CSC_LINK = "C:\path\to\certificate.pfx"
$env:CSC_KEY_PASSWORD = "your-password"
npm run dist
```

也可以使用 Signtool 或云签名服务。**不要把证书、密码或带私有的签名配置提交到仓库。**

## 7. 发布到 GitHub Releases 的建议流程

```powershell
# 确认工作区干净、测试通过
npm ci
npm test
npm run build

# 更新版本号（package.json / CHANGELOG.md）
npm version 1.0.0 --no-git-tag-version

# 打包
npm run dist
npm run dist:portable

# 生成校验和
Get-FileHash release\*.exe -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash)  $([IO.Path]::GetFileName($_.Path))" } |
  Set-Content release\SHA256SUMS.txt
```

然后在 GitHub 创建 `v1.0.0` tag，将 `release\*.exe`、`release\SHA256SUMS.txt` 上传到
Release。不需要上传 `node_modules`、`out` 或 `win-unpacked`。

## 8. 常见问题

**Q: `npm ci` 后 Electron 可执行文件缺失？**
A: `node_modules/electron` 的安装脚本可能被拦截或下载失败。设置 `ELECTRON_MIRROR` 后执行
`node node_modules/electron/install.js`。

**Q: 打包后白屏？**
A: 检查 `out/renderer/index.html` 是否生成，以及 `main` 字段是否为 `./out/main/index.js`。
用 `npm run build` 先排查类型检查/构建错误。

**Q: 打包后无法扫描项目？**
A: 项目根需要可读；网络无关。如果项目位于受保护目录（如 `C:\Program Files`），Windows
权限会阻止写入备份和修改，请换普通用户目录。

**Q: 为什么安装包体积仍然不小？**
A: Electron 运行时本身约 100–200 MB。PathKeeper 没有引入数据库原生模块或 UI 框架，已尽量
精简；安装版压缩后通常小于 100 MB。

**Q: 支持 ARM64 吗？**
A: 当前配置固定 x64。可在 `electron-builder.yml` 中增加 `arm64` target，Electron 45 支持
Windows on ARM；需在目标设备上验证。
