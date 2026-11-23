## Agent skills

### Issue tracker

Issues for this repo live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Build and release requirement

Any change that adds a feature or fixes a bug must be packaged as an IINA plugin and released before the task is considered complete.

After the implementation and tests pass:

1. Build the plugin from `viewer-fork/` using the repository's documented build and packaging workflow.
2. Verify the generated `.iinaplgz` artifact and its packaged contents.
3. Create or update the corresponding GitHub Release and attach the plugin artifact.
4. Report the release tag, artifact name, and verification result in the handoff.

Source-only changes are not complete unless the user explicitly asks to defer packaging or release.
