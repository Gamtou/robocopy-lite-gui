# Robocopy Lite

Windows 桌面同步与备份工具。用任务列表配置和监测备份，底层调用 Windows 自带的 Robocopy。

## 下载与使用

从 [GitHub Releases](https://github.com/Gamtou/robocopy-lite-gui/releases/latest) 下载 Windows x64 便携版 EXE，双击打开。新建任务后，选择两个文件夹和同步模式，再点击「保存并开始」。关闭窗口时默认缩到系统托盘。从托盘选择「退出」可停止本应用的后台同步。

- **单向累计备份**将来源的新文件和更新复制到目标，保留目标独有文件。
- **双向同步**监测两边的变动，遇到同名文件冲突时保留原件，等待选择处理方式。
- **任务管理**支持暂停、继续、编辑目录和取消。文件夹不可用时自动暂停，重新接入后可手动继续。
- **进度和日志**提供当前文件、可获取的复制进度，以及可按任务和状态筛选的日志。Windows 权限允许时，可取消或接管外部 Robocopy。

任务配置、双向同步基准和日志保存在 Windows 当前用户的应用数据目录。

## 开发与打包

在 Windows 上使用 Node.js 22.12 或更新版本，运行：

```powershell
npm.cmd ci
npx.cmd --no install-electron
npm.cmd run check
npm.cmd start
npm.cmd run build:win
```

便携 EXE 位于 `dist/`。Windows 自带的 Robocopy 用于执行实际文件复制。

[产品方案](产品方案.md) · [技术方案](技术方案.md) · [第三方图形授权](THIRD-PARTY-NOTICES.md)
