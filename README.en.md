# IINA NAS Video Review

**Turn IINA into a lightweight NAS video review workstation.** Browse mounted SMB folders, keep or delete videos, resume review progress, and pre-generate Timeline thumbnails as soon as playback loads.

[简体中文](README.md) · **v0.2.54 Beta** · [GPL-3.0](LICENSE) · [Releases](https://github.com/jieyujing/iina-nas-video-review/releases)

> [!WARNING]
> **D permanently removes an SMB file.** The plugin runs `/bin/rm` against a pathname, bypassing Trash. Although it verifies the mount, folder and file before requesting separate native confirmation, it is **not an atomic identity-conditional delete** and is subject to TOCTOU races. Test with disposable media and keep NAS snapshots/backups.

## Features

| Feature | Details |
| --- | --- |
| Folder navigation | Bookmark folders, browse files and play directly in IINA |
| Review queue | KEEP / PENDING / DELETED; follow and center the currently playing video |
| Full queue browsing | Scroll up/down to load adjacent bounded 120-row windows all the way through the Review queue, without changing playback or KEEP progress |
| Resume | Save KEEP decisions and queue progress locally; verify the original SMB share on restart |
| Hotkeys | `K` Keep & Next · `D` delete the playing Review video (recursive scans supported) · `0` open Timeline |
| Timeline | Prefetch on video load; default 10 min/sample, configurable 1–60; 35 thumbnails per page, no 40-frame total cap |
| Decode and cache | Serialized FFmpeg jobs, JPEGs stored on the Mac, VideoToolbox preferred for HEVC |
| Post-delete cleanup | A confirmed D removal queues cleanup of that video's plugin JPEGs; failed jobs retry on IINA startup |

## Requirements

- macOS and an [IINA](https://iina.io/) version supporting plugins.
- A mounted SMB share with appropriate permissions (for example, `/Volumes/ShareName`).
- `ffmpeg` and `ffprobe` for Timeline. **The current implementation expects Apple Silicon Homebrew paths** under `/opt/homebrew/bin`; other locations are not auto-detected.
- Node.js, npm, Python 3 and `zip` for source builds.

```bash
brew install ffmpeg
```

## Installation

Download the `.iinaplgz` from [Releases](https://github.com/jieyujing/iina-nas-video-review/releases) and use **IINA → Settings → Plugins → Install from File**. Alternatively, build it yourself:

```bash
git clone https://github.com/jieyujing/iina-nas-video-review.git
cd iina-nas-video-review/viewer-fork
npm install
npm test
npm run build
python3 scripts/package_dev.py
(cd release-staging && zip -qr ../../nas-review-file-viewer-0.2.54.iinaplgz Info.json LICENSE THUMBNAILS_MIT_LICENSE.md UPSTREAM.md pref.html dist)
```

## Quick start

1. Mount SMB in Finder, add a folder with the sidebar `+` button, then start Review.
2. Click a video to play; `K` marks KEEP and advances. A verified playback completion can also mark KEEP.
3. Press `D` and carefully verify the target in the native confirmation. Both recursive and non-recursive SMB Reviews can delete the **actually playing Review video**, including one previously marked KEEP. No entire folder is removed. An `/bin/rm` exit code of 0 indicates command success; nonzero exits show the system error; an indeterminate exit becomes `UNKNOWN` and is not blindly retried.
4. Press `0` for Timeline. Prefetch starts on video load; unfinished pages show progress. Switching videos stops obsolete jobs, and JPEGs are only cached locally.
5. Scroll the Review list in either direction to access all queued items. Only around 120 rows are rendered at a time. Manual browsing remains in place during background KEEP/D status updates; clicking a video restores automatic follow. Timed-out window requests can be retried by scrolling.

## Safety and privacy

- KEEP is a Review decision, **not a backup**; no copy or write protection is created.
- The verified original SMB directory is the source of truth on resume: missing media becomes DELETED for queue navigation, without claiming how it was removed.
- Path-based deletion has a race between identity verification and `rm`. Prefer disposable files and NAS snapshots.
- A successful `rm` command and persisted Review progress are tracked separately. A progress failure does not trigger another deletion.
- Only a confirmed `/bin/rm` exit code 0 queues precise plugin JPEG cleanup. Cleanup runs behind in-flight FFmpeg tasks, independently from Review progress; failed jobs retry on next IINA startup. Old unidentifiable cache variants are not guessed or bulk-purged.
- **IINA's native `thumb_cache` is never deleted by this feature**, nor are sidecar files or other videos' caches.
- Checkpoints are stored in local IINA preferences, and Timeline JPEGs in a local cache. Sanitize any logs before sharing.
- **Beta limitations:** Not fully validated across IINA versions, Intel Macs or nondefault FFmpeg locations.

## Development and license

Active source: [`viewer-fork/`](viewer-fork/), with `src/` plugin logic, `ui/` sidebar and `tests/` Node tests. Run `cd viewer-fork && npm test && npm run build`.

**GNU GPL v3** applies to the project, preserving the copyright and license of [qktechies/iina-plugin-file-viewer](https://github.com/qktechies/iina-plugin-file-viewer). The Timeline cache parser references [aminozuur/iina-thumbnails](https://github.com/aminozuur/iina-thumbnails) (MIT); see [`viewer-fork/THUMBNAILS_MIT_LICENSE.md`](viewer-fork/THUMBNAILS_MIT_LICENSE.md) and [`viewer-fork/UPSTREAM.md`](viewer-fork/UPSTREAM.md).

Report reproducible issues through [Issues](https://github.com/jieyujing/iina-nas-video-review/issues), **without actual media filenames or unsanitized diagnostics**.
