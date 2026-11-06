# IINA NAS Video Review

**Turn IINA into a lightweight NAS video review workstation.** Browse mounted SMB folders, keep or delete videos, resume review progress, and pre-generate Timeline thumbnails as soon as playback loads.

[简体中文](README.md) · **v0.2.61 local test candidate (unreleased)** · [GPL-3.0](LICENSE) · [Releases](https://github.com/jieyujing/iina-nas-video-review/releases)

> [!WARNING]
> **D permanently removes an SMB file.** The plugin runs `/bin/rm` against a pathname, bypassing Trash. Although it verifies the mount, folder and file before requesting native confirmation by default (which can be explicitly disabled), it is **not an atomic identity-conditional delete** and is subject to TOCTOU races. Test with disposable media and keep NAS snapshots/backups.

## Features

| Feature | Details |
| --- | --- |
| Folder navigation | Bookmark folders, browse files and play directly in IINA |
| Review queue | Natural EOF or deliberate scrubbing to the final seconds of any verified loaded pending Review video records KEEP without marking skipped entries; the active video remains highlighted and centered |
| Full queue browsing | Scroll up/down to load adjacent bounded 120-row windows all the way through the Review queue, without changing playback or KEEP progress |
| Resume | Save KEEP decisions and queue progress locally; verify the original SMB share on restart |
| Hotkeys | Video Review: `K` Keep & Next, `D` delete active video; Directory mode: `D` delete selected child folder; `0` open Timeline |
| Delete confirmation option | Optional persistent Skip delete confirmation switch in Review (off by default); failure dialogs and UNKNOWN safeguards remain in place |
| Live Review counts | Display the remaining non-deleted/non-missing video count plus KEEP/DELETED/MISSING totals; the underlying snapshot indices remain stable for paging and resume |
| Directory mode (v0.2.60) | Choose a subfolder of a verified SMB root, double-click to enter, press D or the delete button to recursively remove the selected directory and all descendants after two separate native confirmations |
| Timeline | Prefetch on video load; default 10 min/sample, configurable 1–60; 35 thumbnails per page, no 40-frame total cap |
| Decode and cache | Serialized FFmpeg jobs, JPEGs stored on the Mac, VideoToolbox preferred for HEVC |
| Post-delete cleanup | A confirmed D removal queues cleanup of that video's plugin JPEGs; failed jobs retry on IINA startup |
| Restart recovery | Reconnecting the original SMB share can use a changed local `st_dev`; reopening the sidebar can retry recovery after the share becomes available |
| Automatic NAS backup | **Enabled by default** for verified SMB Review folders; writes portable state under `.iina-nas-review` after local KEEP, with persistent per-folder pause and safe retry |

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
(cd release-staging && zip -qr ../../nas-review-file-viewer-0.2.61.iinaplgz Info.json LICENSE THUMBNAILS_MIT_LICENSE.md UPSTREAM.md pref.html dist)
```

## Quick start

1. Mount SMB in Finder, add a folder with the sidebar `+` button, then start Review.
2. Click a video to play; `K` marks KEEP and advances. Verified natural EOF or deliberately scrubbing to the last seconds automatically saves KEEP and advances (including while paused). Stop, non-terminal seeking and late EOF from another video do not count.
3. Press `D` to inspect the target in the native confirmation by default; enabling Skip delete confirmation in Review bypasses this prompt. Both recursive and non-recursive SMB Reviews can delete the **actually playing Review video**, including one previously marked KEEP. No folder is removed in video Review mode; Directory mode performs separately confirmed recursive deletion. An `/bin/rm` exit code of 0 indicates command success; nonzero exits show the system error; an indeterminate exit becomes `UNKNOWN` and is not blindly retried.
4. Press `0` for Timeline. Prefetch starts on video load; unfinished pages show progress. Switching videos stops obsolete jobs, and JPEGs are only cached locally.
5. Scroll the Review list in either direction to access all queued items. Only around 120 rows are rendered at a time. Routine KEEP/D status refreshes preserve manual browsing, but an **actual playback change** highlights and centers the newly playing video. Timed-out window requests can be retried by scrolling.
6. **From v0.2.58, NAS folder backups are on by default** for verified SMB Review roots. KEEP/DELETED commit locally first, then mirror into `.iina-nas-review/review-state.v1.json`. Click **Pause NAS backup** to suspend this specific folder; the pause survives restarts and other unpaused folders remain enabled by default. Click **Enable NAS folder backup** to resume. `synced` means the mirror succeeded, `pending` means it can retry, and `conflict` means the plugin refused to overwrite another writer or divergent state.
7. If the local checkpoint is genuinely absent, mount the original SMB folder in Finder, select it in NAS Review and use **Restore Review from NAS backup…**. Import is explicit, validates source and inventory, and never auto-plays or deletes media. Existing local checkpoint bytes (even invalid/stale) are not overwritten.
8. **Directory mode (v0.2.60 local test candidate):** From Folders, enable **Directory mode**, single-click a child folder to select, double-click to enter, then press `D` or click **Permanently delete selected folder…**. Both native confirmations are mandatory, regardless of the video skip-confirmation setting. The plugin rejects deletion of the bookmark or SMB mount root, reported symlinks, a folder containing the active player item, or when an unfinished Review checkpoint exists. Recursive `/bin/rm -r` is pathname-based, non-atomic and irreversible; real SMB deletion is not yet accepted in IINA. Keep NAS backups or snapshots.

## Safety and privacy

- KEEP is a Review decision, **not a backup**; no copy or write protection is created.
- The verified original SMB directory is the source of truth on resume: missing media becomes DELETED for queue navigation, without claiming how it was removed.
- Path-based deletion has a race between identity verification and `rm`. Prefer disposable files and NAS snapshots.
- A successful `rm` command and persisted Review progress are tracked separately. A progress failure does not trigger another deletion.
- v0.2.56 accepts a changed local SMBFS device number on reboot only when the original mounted SMB source, path, directory type/inode and inventory checks pass. It also retries a failed boot-time restore on a fresh sidebar-ready event. Resume does not open media automatically. **Do not discard your checkpoint** after a failed mount; inspect the mount path and retry.
- v0.2.57 introduced folder backup using relative paths, a bounded versioned snapshot with a non-cryptographic integrity check, temporary file verification, a lock directory and same-directory rename. **v0.2.58 enables backup by default for verified SMB Review folders**, with an explicit per-folder pause that persists across restarts. Real SMB atomicity/durability varies by server, and automatic multi-Mac merge is not supported; conflicts fail closed. Leftover locks require manual diagnosis. Metadata backups never authorize media deletion, and only simulated SMB test directories were used during development.
- Only a confirmed `/bin/rm` exit code 0 queues precise plugin JPEG cleanup. Cleanup runs behind in-flight FFmpeg tasks, independently from Review progress; failed jobs retry on next IINA startup. Old unidentifiable cache variants are not guessed or bulk-purged.
- **IINA's native `thumb_cache` is never deleted by this feature**, nor are sidecar files or other videos' caches.
- Checkpoints are stored in local IINA preferences, and Timeline JPEGs in a local cache. Sanitize any logs before sharing.
- **Beta limitations:** Not fully validated across IINA versions, Intel Macs or nondefault FFmpeg locations.

## Development and license

Active source: [`viewer-fork/`](viewer-fork/), with `src/` plugin logic, `ui/` sidebar and `tests/` Node tests. Run `cd viewer-fork && npm test && npm run build`.

**GNU GPL v3** applies to the project, preserving the copyright and license of [qktechies/iina-plugin-file-viewer](https://github.com/qktechies/iina-plugin-file-viewer). The Timeline cache parser references [aminozuur/iina-thumbnails](https://github.com/aminozuur/iina-thumbnails) (MIT); see [`viewer-fork/THUMBNAILS_MIT_LICENSE.md`](viewer-fork/THUMBNAILS_MIT_LICENSE.md) and [`viewer-fork/UPSTREAM.md`](viewer-fork/UPSTREAM.md).

Report reproducible issues through [Issues](https://github.com/jieyujing/iina-nas-video-review/issues), **without actual media filenames or unsanitized diagnostics**.
