# wrkrs

Install a structured AI development team into an existing Git repository and run it through the coding agent you already use.

`wrkrs init` analyzes a repository, recommends the Product Engineering roster (Product Manager, Product Designer, Software Engineer, QA Engineer), shows the exact files it would create, and installs them only after confirmation. Claude Code is the first supported runtime; existing Claude configuration is preserved byte for byte.

## Requirements

- Node.js 22.12 or newer (Node.js 24 recommended)
- Git, with the target directory inside a non-bare worktree

## Usage

```text
npx wrkrs init              # analyze, show the plan, confirm, install
npx wrkrs init --dry-run    # show findings, roster, diffs, and plan digest; write nothing
npx wrkrs init --yes        # install without an interactive confirmation
npx wrkrs init --json --dry-run
npx wrkrs check             # read-only installation health check
npx wrkrs check --json
```

Both commands accept `--cwd <directory>`; the Git worktree root is always resolved from there.

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

wrkrs never edits `CLAUDE.md`, Claude settings, hooks, existing agents, skills, commands, or `.mcp.json`. Conflicting namespaced paths, symlinks, and an unrecognized `.wrkrs` directory block installation instead of being overwritten. Installation runs through a journaled transaction with an exclusive lock, precondition rechecks, post-write verification, and hash-guarded rollback.

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
