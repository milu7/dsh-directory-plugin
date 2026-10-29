# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-10-29

### 修复

- **探测起始目录期间（最长 1.5 秒）插件卸载不再失效**：`cancelActivePick` 现在也覆盖 worker
  尚未拉起的窗口，取消后不会再弹框（此前 `activeWorker` 未赋值时取消直接被忽略）。
- 日志脱敏现在也识别正斜杠写的绝对路径：`config-migrated D:/a/b` 这类迁移日志不再泄露完整目录。

### 变更

- 发布包（zip）带上 `docs/images`：README 里的三张示意图在包内不再是死链。
- README 修正「目录被删除」时的行为描述（插件的选择框回退到系统默认位置，而不是切换回内置选择器）。
## [1.1.0] - 2026-10-29

### 修复

- **非 Windows / 远程访问不再抢走 DSH 自带的目录选择器**：客户端先探测 `supported` 与 `local`，
  不满足就不接管 `directoryFlow` 槽位（以前会压住能用的内置选择器，在 Web GUI 上直接让「新建工作区」不可用）。
- `/pick` 只接受本机请求：非回环地址返回 403 `not-local`，避免远程访问时把模态框弹在宿主机屏幕上。
- 对话框出错或超时后也会恢复被禁用的 DSH 窗口（以前只有 worker 进程崩溃才会恢复，最坏情况下整个窗口点不动）。
- `SetTitle` / `GetOptions` 失败不再导致整个对话框打不开：标题降级为诊断，只有 `SetOptions` 失败才报错。
- 起始目录改由宿主异步探测（1.5s 上限）：断开的网络盘不会再让对话框以 `pick-timeout` 收场。
- `GetDisplayName` 失败会报出正确的阶段；选中但拿不到文件系统路径不再被当成「用户取消」静默丢弃。
- worker 的环境变量改成白名单，不再继承宿主进程的全部环境（含各类 API Key）。
- 日志默认脱敏：路径折成 `D:\…\目录名`，`koffi=` 只记来源（`vendor` / `dsh` / `override`）；
  需要完整路径排障时设 `DSH_DIRECTORY_LOG_PATHS=1`。
- 日志轮转失败时加了硬上限，不会再无限增长；响应补了 `x-content-type-options: nosniff`。

### 新增

- 设置页会提示「配置的目录已不存在，下次会回退到系统默认位置」。
- 错误码 `not-local`、`internal-error`、`body-too-large` 的中英文案；输入框加了 `maxLength`。
- `npm run pack`（`scripts/pack.mjs`）：按 `package.json` 的 `files` 白名单打包，写完回读中央目录校验，输出 sha256。
- GitHub Actions：Windows + Node 22/24 跑单测与语法检查；打 `v*` tag 时自动打包并上传 release。
- `engines.node >= 22`、`CHANGELOG.md`。

### 变更

- 版本 1.0.0 → 1.1.0。
- 日志新增 `pick-aborted`、`not-local` 事件；`pick` 行的路径字段改为脱敏后的形式。
- 起始目录诊断新增 `state`，未生效原因补充 `SetFolder`、`resolved-elsewhere`。
- `GET /config` 增加 `local`、`exists` 字段。

## [1.0.0] - 2026-10-18

- 首个发布版本：接管「新建工作区」的文件夹选择框，从一个可配置的目录开始；含设置页、安全回退与诊断日志。
