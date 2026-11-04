# Upstream attribution and redistribution

## File Viewer (GPL-3.0)

- Original project: https://github.com/qktechies/iina-plugin-file-viewer
- Starting revision: `a9c0dd459a20e8f5fdf8a6f10ab3dca5640475a2`
- License: **GNU GPL version 3**, preserved verbatim as `LICENSE`.
- Original authorship and notices remain attributed to the upstream project.
  The inherited package metadata once used ISC, but the upstream repository
  distributes the full GPLv3 license; this fork publishes under GPL-3.0.

The current project substantially extends that source with SMB Review
queues, restart recovery, explicit per-file deletion, local ffmpeg Timeline
generation and background prefetch. It is a beta, not an upstream release.

## IINA Thumbnails (MIT)

- Reference: https://github.com/aminozuur/iina-thumbnails
- Original author: Amin Eftegarie.
- Cache-v2 parsing ideas were adapted under the MIT license, preserved at
  `THUMBNAILS_MIT_LICENSE.md`. Both license files are packaged.

## Permanent deletion risk

The plugin invokes pathname-based `/bin/rm` on confirmed SMB Review
items after explicit confirmation. It is **not atomic identity-conditional
deletion**. The target can change between the final identity check and
unlink. Use expendable files and independent NAS backups or snapshots.
