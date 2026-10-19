# 目录插件 · dsh-directory-plugin

**让 DeepSeek Harness 桌面端「新建工作区」永远从你自己的目录开始。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-desktop-4D6BFE)

---

DSH 桌面端新建工作区时会直接弹出系统文件夹选择框，起点永远是系统默认位置（通常是下载
文件夹），而且这个对话框不接受任何调用参数。本插件把它换成「**默认打开在你设定的目录**」
的原生选择框：你只需要在设置里指定一次，之后每次新建工作区都从那里开始，具体子目录仍然
由你自己挑。

中文名「目录插件」，仓库/包名即英文 id：`dsh-directory-plugin`。

> 只支持 Windows：起始目录依赖 Win32 COM 的 `IFileDialog::SetFolder`。

## 预览

<p align="center">
  <img src="docs/images/overview.png" alt="默认从系统下载目录开始；安装插件后从 D:\Projects 开始" width="880">
</p>

<p align="center"><sub>同一操作，不同起点：默认从系统下载目录出发，插件从你设定的目录出发（示意图）</sub></p>

## 功能

- **接管目录选择流程**：替换「新建工作区」弹出的文件夹对话框，从一个可配置的目录开始。
- **设置页**：DSH 设置里新增「新建工作区目录」，可输入路径、点「浏览…」选择、保存或一键
  恢复系统默认。
- **安全回退**：插件不可用、目录被删除或对话框出错时，自动退回 DSH 内置行为，不会报错、
  不会挡住新建工作区。
- **诊断日志**：每次弹框都会记录起始目录是否生效，方便排查。

## 安装

前置条件：Windows 10/11 + DeepSeek Harness **桌面端**。

1. 把仓库克隆或下载到本地，例如 `D:\Plugins\dsh-directory-plugin`；
2. 用 DSH 自带的插件命令行把它登记进 `desktop` 配置档（`link:` 表示直接引用本地目录，
   不复制文件）：

```powershell
# 按实际情况修改这两个变量
$DSH_EXE = 'C:\Program Files\DSH\DSH NEXT.exe'   # 你的 DSH 桌面端安装位置
$PLUGIN  = 'D:\Plugins\dsh-directory-plugin'     # 本仓库所在的本地目录

$CLI = Join-Path (Split-Path $DSH_EXE) 'resources\app.asar\lib\plugin-cli.js'

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
& $DSH_EXE --expose-internals $CLI desktop add "link:$PLUGIN"
```

3. **重启 DSH 桌面端**（插件组合在启动时读取）。
4. 打开 设置 →「新建工作区目录」，选一个目录并保存，然后试一次「新建工作区」。

## 使用

1. 设置 →「新建工作区目录」；
2. 点「浏览…」选目录，或手动输入路径，点「保存」；
3. 之后每次「新建工作区」，选择框都会从该目录开始；
4. 「恢复系统默认」清空配置，回到 DSH 原来的行为。

设置页：

<p align="center">
  <img src="docs/images/settings.png" alt="设置 → 新建工作区目录：输入框、浏览…、保存、恢复系统默认" width="880">
</p>

<p align="center"><sub>设置 →「新建工作区目录」：输入框、浏览…、保存、恢复系统默认（示意图）</sub></p>

配置示例（`%USERPROFILE%\.dsh\workspace-directory.json`）：

```json
{ "directory": "D:\\Projects" }
```

旧版本（`workspace-anchor.json` / `default-workspace-directory.json`）的配置会在首次读取时
自动迁移，无需手动处理。

## 工作原理

插件同时挂在两个平面上：

| 平面 | 文件 | 作用 |
| --- | --- | --- |
| 宿主（host） | `lib/index.js` | 注册两个同源 HTTP 路由：`/dsh-directory-plugin/config`、`/dsh-directory-plugin/pick` |
| 浏览器（client） | `client/client.js` | 接管 `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow` 槽位，并注册设置页 |
| 核心 | `lib/core.js` | 配置读写、目录校验、拉起对话框子进程 |
| Worker | `lib/dialog-worker.cjs` | 一次性 Node 子进程，用 koffi 直接调 Win32 COM |

弹框链路：客户端槽位 `open` → `POST /pick` → `core.pickDirectory()` 拉起 worker →
`CoCreateInstance(FileOpenDialog)` → `SHCreateItemFromParsingName` 造 `IShellItem` →
`IFileDialog::SetFolder`（vtable 第 12 槽）→ `Show()`。失败时客户端回退到桌面端内置的
`__DSH_DIRECTORY_PICKER__`。

<p align="center">
  <img src="docs/images/how-it-works.png" alt="弹框链路：客户端槽位 → 宿主路由 → Worker → Win32 COM → 原生选择框" width="880">
</p>

<p align="center"><sub>从点击「新建工作区」到原生选择框打开（示意图）</sub></p>

koffi 3.1.1 已随仓库放在 `vendor/`，安装时不需要联网。

## 排错

诊断日志：`%USERPROFILE%\.dsh\workspace-directory.log`

| 日志 | 含义 |
| --- | --- |
| `host-routes-registered /dsh-directory-plugin` | 宿主侧已加载、HTTP 路由就绪 |
| `pick D:\Projects\demo initial={"applied":true,...}` | 选择框确实以配置目录为起点 |
| `pick (cancelled) ...` | 用户取消了 |
| `pick-failed ...` | 对话框进程出错，界面会回退到系统默认行为 |

判断是否生效：

1. 重启后日志出现 `host-routes-registered` → 宿主侧已起来；
2. 新建工作区时日志新增 `pick ... initial={"applied":true}` → 走的是本插件的对话框；
3. 若日志没有新增 `pick` 行、弹出的还是旧对话框，说明浏览器侧接管没生效：功能退化为 DSH
   原生行为，不会报错。请附上日志和现象提 issue。

## 兼容性

- Windows 10 / 11，x64（`vendor` 内置的是 win32-x64 的 koffi 二进制）。
- 依赖 DSH 桌面端（Next 内核）的槽位与客户端插件加载机制；如果未来版本移除或重命名这些
  槽位，插件会静默回退，不影响 DSH 本身。
- 插件不会改动 DSH 安装目录里的任何文件。

## 卸载

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
& $DSH_EXE --expose-internals $CLI desktop remove dsh-directory-plugin
```

然后重启 DSH。配置文件与日志会留在 `%USERPROFILE%\.dsh` 下，可手动删除。

## 目录结构

```
package.json            插件清单（宿主入口 + 浏览器入口 + cordis 层）
cordis.patch.yml        往组合里插入本插件的那一行
lib/index.js            宿主插件：HTTP 路由
lib/core.js             配置读写 + 拉起对话框子进程
lib/dialog-worker.cjs   Win32 文件夹对话框 worker（支持起始目录）
client/client.js        浏览器 bundle：接管目录流程 + 设置页
vendor/                 随包携带的 koffi 3.1.1
docs/images/            README 示意图（overview / settings / how-it-works）
LICENSE                 MIT
```

## English

**Directory Plugin** (`dsh-directory-plugin`) is a plugin for the DeepSeek Harness desktop
app on Windows. It replaces the folder chooser used by *New Workspace* with a native dialog
that opens at a directory you configure (DSH's built-in picker always starts at the system
default). It adds a settings page, falls back silently to the stock picker when anything
goes wrong, and ships koffi so no network install is needed.

## License

[MIT](LICENSE) © 2026 milu7
