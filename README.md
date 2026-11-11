# IINA NAS Video Review

**把 IINA 变成 NAS 视频审核工作台。** 支持 SMB 目录浏览、逐条 KEEP、审核进度恢复、经确认永久删除，以及视频加载后自动预生成 Timeline 缩略图。

[English](README.en.md) · **v0.2.79 Beta 预发布** · [GPL-3.0](LICENSE) · [Releases](https://github.com/jieyujing/iina-nas-video-review/releases)

> [!WARNING]
> **D 键会永久删除 NAS 文件。** 插件通过 `/bin/rm` 删除 SMB 路径，不经过废纸篓。虽然删除前校验挂载、目录和文件身份，默认逐条确认（可显式开启跳过确认），但该操作**不是原子身份条件删除**，存在 TOCTOU 风险。先使用可丢弃文件测试，并确保 NAS 有快照或备份。

## 功能

| 功能 | 说明 |
| --- | --- |
| 文件夹导航 | 收藏目录、浏览文件、直接使用 IINA 播放 |
| Review Queue（v0.2.64 修复） | 已加载待审核视频自然完播，或拖动到最后数秒乃至 100%，均自动标记 KEEP；兼容拖动后缺失最后一帧进度事件、先清空 URL 的 IINA 事件顺序；不因停止、跳到中间或迟到的 EOF 误标 |
| 全队列浏览 | 鼠标滚轮或触控板上下滚动，按需读取前后 120 条窗口，可从第 1 条浏览到最后一条；滚动不改变审核进度 |
| 进度恢复 | KEEP 和队列进度保存在本机；重启后验证原 SMB 共享再恢复 |
| 快捷键 | 视频 Review：`K` Keep & Next、`D` 删除当前视频；目录模式：`D` 删除已选中的子目录；`0` 打开 Timeline |
| 删除确认选项 | Review 中可开启 Skip delete confirmation，D 不再弹出普通确认；默认关闭，重启仍保留配置，删除失败和 UNKNOWN 安全拦截保持不变 |
| 串行后台删除队列（v0.2.63） | D 先持久化删除任务并切下一条；允许连续 D→D→D、随时 K；后台只有一个 worker，逐条重新验证 SMB 身份再执行 rm。成功才将原视频标记 DELETED；失败不回退当前播放；UNKNOWN 暂停后续删除并禁止自动重试。重启后未执行任务需确认才能恢复，执行中断任务必须人工核对 |
| 重启恢复与 UNKNOWN 核对（v0.2.65） | 恢复时不会被旧 UNKNOWN 任务倒退游标；已有其他未排队视频可继续 Review。核对按钮检查持久化任务及原 SMB 文件，不再依赖旧版单条删除日志；原文件存在时只解除该任务 UNKNOWN，不重删；缺失时经确认更新对应 Review 状态。未执行的任务仍暂停，恢复需要另行确认 |
| 删除队列完成标识（v0.2.66） | Review 面板顶部显示后台删除任务状态及运行、排队、暂停、UNKNOWN、成功、失败数量；所有任务确认落盘后才出现“删除队列已完成 / Safe to close IINA”。失败、人工核对、暂停、UNKNOWN 与未执行删除均有独立提示，不会误报全部成功 |
| 精简 Review 界面（v0.2.67） | 主界面只突出统计卡片、K/D 操作、简洁删除队列状态、视频列表。备份设置、K 监听调试、完整删除安全说明收进列表下方的「高级设置与帮助」折叠区；UNKNOWN 核对、暂停恢复与关键错误仍直接可见 |
| 审核统计 | 显示未删除、未缺失的视频总数，以及 KEEP、DELETED、MISSING 数量；队列快照条目保持不变以维持分页和恢复一致性 |
| 目录模式（v0.2.60） | 只在已验证 SMB 共享上开启；单击选中子目录，双击进入；D / 删除按钮在两次原生确认后递归删除整个目录及其所有内容；不受视频跳过确认开关影响 |
| Timeline | 视频加载后后台预生成；默认 10 分钟/张，支持 1–60 分钟；每页 35 张，不设 40 张总量限制 |
| 解码缓存 | FFmpeg 串行运行、JPEG 写入 Mac 本地缓存；HEVC 优先 VideoToolbox |
| 删除后清理 | D 确认删除成功后，异步清理该视频的插件 JPEG；失败任务下次启动继续，不影响 Review 进度 |
| 重启后恢复 | 允许同一 SMB 共享重新挂载时本地设备号改变；若先启动 IINA 后连接 SMB，可重新打开侧栏或点击 Resume 重试，不会丢失 KEEP |
| NAS 目录备份 | **默认开启**，在已验证的 SMB Review 目录中异步保存 `.iina-nas-review/review-state.v1.json`；支持逐目录暂停及断线后重试 |

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
(cd release-staging && zip -qr ../../nas-review-file-viewer-0.2.79.iinaplgz Info.json LICENSE THUMBNAILS_MIT_LICENSE.md UPSTREAM.md pref.html dist)
```

## 快速使用

1. 在 Finder 挂载 SMB，共享目录通过侧栏的 `+` 加入书签，开始 Review。
2. 点击视频播放；`K` 记录 KEEP 并进入下一条；已加载视频自然完播或主动拖动到片尾最后数秒，会自动保存 KEEP 并继续播放下一条（暂停时拖动同样适用）。停止、拖到中间、迟到的旧视频 EOF 不会自动标记 KEEP。
3. 按 `D` 默认会显示原生确认框供你核对目标；开启 Review 中的 Skip delete confirmation 后不再弹出确认框。递归、非递归 SMB Review 均支持删除；目标始终是当前实际播放且属于 Review 的视频，包括重看已 KEEP 的视频。**视频 Review 模式**下不会删除整个子目录；目录模式则单独要求两次确认后递归删除。`/bin/rm` 退出码 0 被视为命令成功；非零会显示错误，无法获取可靠退出结果则为 `UNKNOWN` 且禁止自动重试。
4. 按 `0` 查看 Timeline。缩略图在视频加载后就开始预生成；未完成的页面会显示进度。切换视频停止旧任务，JPEG 只存本地。
5. Review 列表每次仅加载约 120 条；用滚轮、触控板或滚动条向下/向上浏览完整队列，不需要等待审核完成。手动浏览时普通 KEEP/D 状态刷新不会突然拉回；**实际播放的视频发生切换时**将重新高亮并居中当前播放项。窗口请求超时可重新滚动重试。
6. **v0.2.58 NAS 目录备份默认开启**：每次创建或恢复已验证的 SMB Review，KEEP/DELETED 都先存本地，再异步写入隐藏状态文件。可在 Review 中点击 **Pause NAS backup** 关闭当前目录的自动备份，关闭设置在重启后仍保留；再次点击 **Enable NAS folder backup** 可恢复。不同目录独立设置，其他未暂停目录依然默认开启。状态 `synced` 表示同步成功；`pending` 表示可在下次启动或重新打开侧栏时重试；`conflict` 表示发现其他写入者或不同修订，不会覆盖。
7. 如果本地 checkpoint 丢失，请先在 Finder 挂载原 SMB，选中原 Review 目录后点击 **Restore Review from NAS backup…**。仅在没有原始本地 checkpoint 时允许显式导入，并重新核对来源和媒体清单；不自动播放或删除媒体。已存在但损坏或过期的本地 checkpoint 也不会被静默覆盖。
8. **目录模式（v0.2.60 本地测试候选）：** 在 Folders 页面切换到 **Directory mode**，单击子文件夹选中，双击进入，按 `D` 或点击 **Permanently delete selected folder…**。两次独立的 IINA 原生确认均不可跳过。仅能删选定的 SMB 根目录下的子目录；SMB 挂载根、书签根、符号链接、正在播放媒体所在目录以及有未完成 Review checkpoint 的情况下都会被拒绝。删除执行非原子路径式 `/bin/rm -r`，没有废纸篓与撤销；测试前请准备 NAS 快照或备份，真实 SMB 删除尚未完成实机验收。

## 数据与安全边界

- KEEP 是审核状态，**不是备份**；插件不会复制或保护原文件。
- 恢复时以**原 SMB 目录**为准：已不存在的媒体在队列中记作 DELETED，但这不能证明是谁删除的。
- 删除身份预检查与路径 `rm` 之间存在竞态；建议只使用测试文件和 NAS 快照。
- `rm` 成功与审核进度保存分别处理，进度保存失败不会导致再次执行删除。
- 仅当 `/bin/rm` 明确返回 0，才将该视频关联的 NAS Review JPEG 加入本地持久清理队列；清理与 FFmpeg 生成串行执行。清理失败不影响删除判定，下次 IINA 启动后重试。旧版遗留且无法匹配原始缓存哈希的图片不会被猜测清理。
- **IINA 原生 `thumb_cache` 完全不受影响**；也不会删除字幕、海报或其他视频的缓存。
- 检查点位于本地 IINA 首选项；Timeline JPEG 位于本地缓存。分享日志前请去除 NAS 路径、文件名与凭据。
- 目录状态文件采用相对视频路径，保存 KEEP/PENDING/DELETED、游标、修订号与检查字段，不包含 Mac 的 `/Volumes` 绝对路径。独立文件夹使用临时写入、读回校验及写入锁，然后在同一目录执行 rename；这不保证所有 SMB 服务器的断电持久性，也不提供跨设备自动合并。如果意外退出后留下锁，请先人工核查后处理；插件不会自行删除未知锁。
- **NAS 备份默认开启，仅针对已经验证身份的 SMB Review 根目录**；本地测试目录不会启用 NAS 写入。手动暂停按目录保留。已有其他设备写入的状态会触发 `conflict`，不会自动覆盖。备份状态仅用于非破坏性审核恢复，不能作为 D 删除授权、目标身份或文件存在性的证据。
- v0.2.56 修复重启后 SMB `st_dev` 变化导致的误拒绝，并允许重新打开侧栏时重试未成功的恢复；恢复仍须匹配原挂载源、路径与目录 inode，且不会自动播放媒体。**恢复失败时不要 Discard checkpoint**；检查挂载路径及 Debug Log 后重试。
- 当前为 Beta：对不同 IINA 版本、Intel Mac 和非默认 FFmpeg 路径的兼容性尚未完整验证。

## 开发与许可证

主代码位于 [`viewer-fork/`](viewer-fork/)，其中 `src/` 为插件逻辑、`ui/` 为侧栏、`tests/` 为 Node 测试；运行 `cd viewer-fork && npm test && npm run build`。

本项目按 **GNU GPL v3** 开源，保留 [qktechies/iina-plugin-file-viewer](https://github.com/qktechies/iina-plugin-file-viewer) 的上游著作权与许可证。Timeline 缓存解析参考 [aminozuur/iina-thumbnails](https://github.com/aminozuur/iina-thumbnails)（MIT），其声明见 [`viewer-fork/THUMBNAILS_MIT_LICENSE.md`](viewer-fork/THUMBNAILS_MIT_LICENSE.md)。详见 [`viewer-fork/UPSTREAM.md`](viewer-fork/UPSTREAM.md)。

欢迎通过 [Issues](https://github.com/jieyujing/iina-nas-video-review/issues) 反馈问题，**不要提交真实媒体文件名或未经脱敏的诊断日志**。
