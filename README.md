# wrkrs

Install a structured AI development team into an existing Git repository and run it through the coding agent you already use.

`wrkrs init` analyzes a repository, recommends the Product Engineering roster (Product Manager, Product Designer, Software Engineer, QA Engineer), shows the exact files it would create, and installs them only after confirmation. `wrkrs update` reconciles that installation with a new wrkrs version and with your edits to `.wrkrs/config.yaml`, and `wrkrs uninstall` removes it again. Claude Code is the first supported runtime; existing Claude configuration is preserved byte for byte, and anything you changed is preserved and reported rather than overwritten or deleted.

## Requirements

- Node.js 22.12 or newer (Node.js 24 recommended)
- Git, with the target directory inside a non-bare worktree
- macOS or Linux. Windows fails closed: wrkrs binds directories by identity to guarantee it never writes outside the repository, and Windows tracks the working directory by path. Windows support arrives with the cross-platform increment.

## Usage

```text
npx wrkrs init              # analyze, show the plan, confirm, install
npx wrkrs init --dry-run    # show findings, roster, diffs, and plan digest; write nothing
npx wrkrs init --yes        # install without an interactive confirmation
npx wrkrs update            # reconcile the installation with this version and your config
npx wrkrs uninstall         # remove what wrkrs installed and still recognizes
npx wrkrs check             # read-only installation health check
```

`init`, `update`, and `uninstall` all accept `--dry-run`, `--yes`, and `--json`; `check` accepts `--json`. Every command accepts `--cwd <directory>`; the Git worktree root is always resolved from there.

Exit codes: `0` success (warnings allowed), `1` error or blocked plan, `2` invalid usage.

## What gets installed

```text
.wrkrs/config.yaml                  seeded   editable roster, specializations, governance
.wrkrs/schema.json                  managed  JSON Schema for config.yaml
.wrkrs/manifest.json                managed  ownership record with content hashes
.wrkrs/roles/*.md                   seeded   portable role definitions (canonical)
.claude/agents/wrkrs-*.md           managed  Claude Code subagent projections
.claude/skills/wrkrs/SKILL.md       managed  explicit `/wrkrs <outcome>` entry point
```

wrkrs never edits `CLAUDE.md`, Claude settings, hooks, existing agents, skills, commands, or `.mcp.json`. Conflicting namespaced paths, symlinks, and an unrecognized `.wrkrs` directory block installation instead of being overwritten. Every command runs through a journaled transaction with an exclusive lock, precondition rechecks, post-write verification, and hash-guarded rollback.

## Changing and removing an installation

`.wrkrs/config.yaml` is yours to edit. `wrkrs update` rebuilds the generated files from it and from the packaged wrkrs version, shows an exact diff for every change, and applies it only after confirmation. Repository detection still runs, but only to supply evidence for specializations your configuration already declares; it never changes the roster on its own.

Anything you edited is preserved, not overwritten:

- a changed generated file is left exactly as it is and reported; the rest of the update still applies
- a customized role file is preserved and reported
- `wrkrs uninstall` removes only files whose bytes still match what wrkrs last wrote, deletes only directories it created and only while they are empty, and never touches a pre-existing file
- when an uninstall preserves anything, it leaves a reduced manifest in `partial-uninstall` state so a later retry is safe; `wrkrs check` reports that state

Neither command commits, pushes, or releases anything.

## Development

```text
npm install
npm run typecheck
npm test
npm run coverage
npm run format:check
npm run build
npm run smoke        # pack the tarball and exercise the compiled CLI
npm run verify       # all of the above
```

See `architecture.md`, `mvp.md`, and `decisions.md` for the approved design and scope.

## License

MIT
