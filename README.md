# IINA NAS Video Review

**把 IINA 变成 NAS 视频审核工作台。** 支持 SMB 目录浏览、逐条 KEEP、审核进度恢复、经确认永久删除，以及视频加载后自动预生成 Timeline 缩略图。

[English](README.en.md) · **v0.2.54 Beta** · [GPL-3.0](LICENSE) · [Releases](https://github.com/jieyujing/iina-nas-video-review/releases)

> [!WARNING]
> **D 键会永久删除 NAS 文件。** 插件通过 `/bin/rm` 删除 SMB 路径，不经过废纸篓。虽然删除前校验挂载、目录和文件身份并逐条确认，但该操作**不是原子身份条件删除**，存在 TOCTOU 风险。先使用可丢弃文件测试，并确保 NAS 有快照或备份。

## 功能

| 功能 | 说明 |
| --- | --- |
| 文件夹导航 | 收藏目录、浏览文件、直接使用 IINA 播放 |
| Review Queue | KEEP / PENDING / DELETED；列表跟随并居中定位当前播放视频 |
| 全队列浏览 | 鼠标滚轮或触控板上下滚动，按需读取前后 120 条窗口，可从第 1 条浏览到最后一条；滚动不改变审核进度 |
| 进度恢复 | KEEP 和队列进度保存在本机；重启后验证原 SMB 共享再恢复 |
| 快捷键 | `K` Keep & Next · `D` 删除当前正在播放的 Review 视频（支持递归扫描）· `0` 打开 Timeline |
| Timeline | 视频加载后后台预生成；默认 10 分钟/张，支持 1–60 分钟；每页 35 张，不设 40 张总量限制 |
| 解码缓存 | FFmpeg 串行运行、JPEG 写入 Mac 本地缓存；HEVC 优先 VideoToolbox |
| 删除后清理 | D 确认删除成功后，异步清理该视频的插件 JPEG；失败任务下次启动继续，不影响 Review 进度 |

## 环境要求

- macOS 和支持插件的 [IINA](https://iina.io/)。
- Finder 中已挂载并具备相应权限的 SMB 共享（如 `/Volumes/ShareName`）。
- Timeline 依赖 `ffmpeg`、`ffprobe`。**当前固定使用 Apple Silicon Homebrew 路径** `/opt/homebrew/bin`；不自动搜索其他路径。
- 源码构建需要 Node.js、npm、Python 3、`zip`。

```bash
brew install ffmpeg
```

## 安装

从 [Releases](https://github.com/jieyujing/iina-nas-video-review/releases) 获取 `.iinaplgz`，在 **IINA → 设置 → 插件** 中从文件安装。也可以自行构建：

```bash
git clone https://github.com/jieyujing/iina-nas-video-review.git
cd iina-nas-video-review/viewer-fork
npm install
npm test
npm run build
python3 scripts/package_dev.py
(cd release-staging && zip -qr ../../nas-review-file-viewer-0.2.54.iinaplgz Info.json LICENSE THUMBNAILS_MIT_LICENSE.md UPSTREAM.md pref.html dist)
```

## 快速使用

1. 在 Finder 挂载 SMB，共享目录通过侧栏的 `+` 加入书签，开始 Review。
2. 点击视频播放；`K` 记录 KEEP 并进入下一条；完整播放可以自动 KEEP。
3. 按 `D` 时，仔细核对原生确认框中的目标文件。递归、非递归 SMB Review 均支持删除；目标始终是当前实际播放且属于 Review 的视频，包括重看已 KEEP 的视频。不会删除整个子目录。`/bin/rm` 退出码 0 被视为命令成功；非零会显示错误，无法获取可靠退出结果则为 `UNKNOWN` 且禁止自动重试。
4. 按 `0` 查看 Timeline。缩略图在视频加载后就开始预生成；未完成的页面会显示进度。切换视频停止旧任务，JPEG 只存本地。
5. Review 列表每次仅加载约 120 条；用滚轮、触控板或滚动条向下/向上浏览完整队列，不需要等待审核完成。手动浏览时，后台 KEEP/D 状态更新不会突然拉回播放项；点击某条视频后重新跟随播放位置。窗口请求超时可重新滚动重试。

## 数据与安全边界

- KEEP 是审核状态，**不是备份**；插件不会复制或保护原文件。
- 恢复时以**原 SMB 目录**为准：已不存在的媒体在队列中记作 DELETED，但这不能证明是谁删除的。
- 删除身份预检查与路径 `rm` 之间存在竞态；建议只使用测试文件和 NAS 快照。
- `rm` 成功与审核进度保存分别处理，进度保存失败不会导致再次执行删除。
- 仅当 `/bin/rm` 明确返回 0，才将该视频关联的 NAS Review JPEG 加入本地持久清理队列；清理与 FFmpeg 生成串行执行。清理失败不影响删除判定，下次 IINA 启动后重试。旧版遗留且无法匹配原始缓存哈希的图片不会被猜测清理。
- **IINA 原生 `thumb_cache` 完全不受影响**；也不会删除字幕、海报或其他视频的缓存。
- 检查点位于本地 IINA 首选项；Timeline JPEG 位于本地缓存。分享日志前请去除 NAS 路径、文件名与凭据。
- 当前为 Beta：对不同 IINA 版本、Intel Mac 和非默认 FFmpeg 路径的兼容性尚未完整验证。

## 开发与许可证

主代码位于 [`viewer-fork/`](viewer-fork/)，其中 `src/` 为插件逻辑、`ui/` 为侧栏、`tests/` 为 Node 测试；运行 `cd viewer-fork && npm test && npm run build`。

本项目按 **GNU GPL v3** 开源，保留 [qktechies/iina-plugin-file-viewer](https://github.com/qktechies/iina-plugin-file-viewer) 的上游著作权与许可证。Timeline 缓存解析参考 [aminozuur/iina-thumbnails](https://github.com/aminozuur/iina-thumbnails)（MIT），其声明见 [`viewer-fork/THUMBNAILS_MIT_LICENSE.md`](viewer-fork/THUMBNAILS_MIT_LICENSE.md)。详见 [`viewer-fork/UPSTREAM.md`](viewer-fork/UPSTREAM.md)。

欢迎通过 [Issues](https://github.com/jieyujing/iina-nas-video-review/issues) 反馈问题，**不要提交真实媒体文件名或未经脱敏的诊断日志**。
