# wrkrs MVP

Status: Locked product scope; first vertical slice approved by the owner on 2026-08-29 and implemented  
Last updated: 2026-08-29

## Product statement

wrkrs is an open-source, CLI-first framework that installs a configurable AI development team into an existing software repository.

The core promise is:

> Install a structured AI development team into your repository and run it through the coding agent you already use.

A worker is a configured AI agent. Roles define responsibility, specializations define expertise, and worker instances perform the work.

## Target users

- Solo developers building credible products
- Small software teams that want a repeatable product-engineering workflow
- Existing Git repositories
- Claude Code users in the first release, locally or through cloud sessions

## Locked complete MVP scope

The complete MVP includes:

- npx wrkrs init
- read-only repository analysis before proposed changes
- a complete dry-run plan and diff
- one editable Product Engineering framework preset
- Product Manager, Product Designer, Software Engineer, and QA Engineer roles
- task-specific Software Engineer specializations rather than permanent platform engineer roles
- Claude Code as the first fully supported runtime
- portable runtime and provider contracts
- project-owned configuration that works locally and in Claude Code cloud
- GitHub, Linear, and Figma dedicated providers
- generic MCP and manual fallbacks
- configuration and environment validation through wrkrs check
- safe, customization-aware update and uninstall behavior
- an ownership manifest

## Locked non-goals

The MVP does not include:

- a hosted dashboard or account system
- a proprietary cloud agent runtime
- a marketplace
- a broad integration catalog
- new-application scaffolding
- full runtime support beyond Claude Code
- a dependency on experimental Claude Agent Teams
- automatic commit, push, merge, deployment, publication, or release
- committed secrets

## Delivery strategy

The MVP is delivered as small vertical increments. The first approved implementation must prove the safety-critical installation loop before providers or a larger command catalog are added.

| Increment | Outcome |
| --- | --- |
| 1. Installation vertical slice | Analyze, recommend, dry-run, install namespaced repository files, record ownership, and diagnose |
| 2. Lifecycle safety | Implement customization-aware update and uninstall with the same plan and transaction engine |
| 3. Provider capabilities | Add GitHub, Linear, Figma, generic MCP, and manual capability mappings |
| 4. Release hardening | Cross-platform CI, package verification, migration fixtures, documentation, and npm release readiness |

Only Increment 1 is proposed for implementation immediately after architecture approval.

## First vertical slice

### Goal

Prove that wrkrs can safely install a useful Product Engineering roster into a real existing Git repository without disturbing pre-existing Claude Code configuration.

### User-visible commands

    npx wrkrs init
    npx wrkrs init --dry-run
    npx wrkrs init --yes
    npx wrkrs init --json --dry-run
    npx wrkrs check
    npx wrkrs check --json

An internal or documented --cwd option may be exposed to make nested-directory use and tests explicit. Running from any child directory must still select the Git worktree root.

### init behavior

init must:

1. Reject a directory that is not inside a non-bare Git worktree.
2. Perform no target writes before confirmation.
3. Detect basic project markers and existing Claude Code configuration.
4. Report stable findings without printing secret values.
5. Recommend the four-role Product Engineering roster.
6. Attach detected stack or domain specializations to Software Engineer rather than creating permanent engineer roles.
7. Compile all proposed repository files in memory.
8. List existing Claude files as preserved.
9. display exact content diffs for every proposed new file.
10. Block a conflicting namespaced target instead of overwriting it.
11. Require confirmation, or --yes in non-interactive mode.
12. Recheck plan preconditions immediately before apply.
13. Apply through a transaction.
14. Validate the result and roll back on failure.
15. Record ownership only after the installation validates.
16. Leave Git history and the working tree commit state under the developer's control.

### Generated portable configuration

    .wrkrs/config.yaml
    .wrkrs/schema.json
    .wrkrs/manifest.json
    .wrkrs/roles/product-manager.md
    .wrkrs/roles/product-designer.md
    .wrkrs/roles/software-engineer.md
    .wrkrs/roles/qa-engineer.md

config.yaml contains schema version, preset, runtime, roster, role sources, recommended specializations, governance, providers, and an explicit extensions object.

Role files are canonical portable role definitions. They describe responsibilities, behavior, boundaries, collaboration, approval gates, and expected handoffs. They do not claim workers are people.

### Generated Claude Code adapter

    .claude/agents/wrkrs-product-manager.md
    .claude/agents/wrkrs-product-designer.md
    .claude/agents/wrkrs-software-engineer.md
    .claude/agents/wrkrs-qa-engineer.md
    .claude/skills/wrkrs/SKILL.md

The skill invokes the Product Manager worker and passes the user's requested outcome. It uses stable Claude subagents, not experimental Agent Teams. It grants no new permission and makes no settings, hooks, CLAUDE.md, or MCP change in this slice.

### Basic project detection

The first detector set must recognize enough signals to prove specialization:

- Node.js or TypeScript from package.json and tsconfig.json
- common web frontend signals such as React or Next.js dependencies
- Swift or Apple platform signals from Package.swift and Xcode markers
- backend signals from common server dependencies or language manifests
- monorepo signals from root workspace configuration
- unknown or mixed repositories without failing

Detection is evidence-based. A missing signal results in no specialization, not a guessed one.

### Basic Claude detection

The analyzer reports the presence and validity needed for planning:

- CLAUDE.md
- CLAUDE.local.md
- .claude/settings.json
- .claude/settings.local.json
- existing .claude/agents
- existing .claude/skills
- existing .claude/commands
- hooks referenced by settings
- .mcp.json server names and transport types
- existing .wrkrs state

The first slice preserves all of these unless the path is one of the new namespaced targets. An invalid unrelated file is a warning when no change is required. A required conflicting target is a blocker.

## First vertical slice acceptance tests

### Repository and scan

1. Starting in a nested directory resolves the actual Git worktree root.
2. Starting outside a Git worktree exits with an error and creates no file or directory.
3. The clean fixture's project markers produce deterministic findings.
4. The existing-Claude fixture reports every relevant existing component as preserved.
5. Scanner output never contains fixture secret sentinel values.

### Roster

6. Both fixtures recommend exactly Product Manager, Product Designer, Software Engineer, and QA Engineer.
7. Product Manager is marked primary.
8. Detected stack expertise appears as Software Engineer specializations.
9. No permanent macOS, web, mobile, or backend engineer role is introduced.
10. Every specialization includes machine-readable evidence.

### Dry run and conflict safety

11. init --dry-run creates no target bytes; a complete before/after tree hash is identical.
12. The semantic plan lists every generated file, every preserved Claude file, ownership mode, reason, expected state, proposed hash, and plan digest.
13. Human output contains an exact create diff for every generated file.
14. JSON output contains no ANSI escape sequences, timestamps that destabilize the digest, or absolute-path-dependent operation identifiers.
15. A pre-existing namespaced Claude file with different content produces a blocker and no writes.
16. A pre-existing symlink at a managed path produces a blocker and no writes.
17. An existing .wrkrs directory without a valid manifest produces a blocker.
18. A non-interactive init without --yes refuses to apply.

### Apply and preservation

19. init --yes in the clean fixture creates the exact portable and Claude adapter files.
20. init --yes in the existing-Claude fixture leaves all pre-existing file bytes and modes unchanged.
21. No CLAUDE.md, settings file, hook, command, existing agent, existing skill, or .mcp.json entry is changed.
22. Every generated file is UTF-8, has a final newline, and uses a non-executable mode.
23. The manifest contains only repository-relative paths and no credentials or fixture secret values.
24. Every managed or seeded manifest hash equals the exact applied file bytes.
25. Re-running init against a compatible existing installation is a no-op or clearly directs the user to the future update command; it never duplicates content.

### Transaction and rollback

26. A changed precondition between planning and apply aborts before the first mutation.
27. An injected failure after at least one created file causes reverse rollback.
28. Successful rollback restores the exact pre-apply tree.
29. If a file is externally changed after wrkrs writes it, rollback does not delete or overwrite that external change and reports recovery instructions.
30. A stale transaction is reported by check.

### check

31. check passes after a clean installation.
32. check validates config, role references, manifest paths and hashes, adapter frontmatter, and transaction state.
33. Removing an owned file produces a stable error diagnostic.
34. Editing a seeded role produces a customization diagnostic without overwriting it.
35. Editing a managed Claude projection produces a drift warning or error with the exact path.
36. Absence of a local Claude executable is a warning, not an installation error, because Claude Code cloud remains a valid runtime.
37. check --json returns stable codes, severities, paths, summaries, and remediation without terminal styling.

### Cross-platform and packaging

38. Unit and integration tests pass on the supported Node floor and preferred LTS version.
39. Path normalization tests cover POSIX, Windows separators, case collisions, reserved paths, parent traversal, and symlinks.
40. The packed npm tarball contains compiled JavaScript, templates, schema assets, license, and the single wrkrs bin.
41. A smoke test installs the tarball into an isolated temporary project and runs wrkrs --help, init --dry-run, init --yes, and check.

## Test fixtures

### clean-repository

Purpose: prove normal greenfield installation into an existing application repository.

Minimum contents:

- package.json with a known TypeScript/web signal
- tsconfig.json
- one small source file
- no CLAUDE.md
- no .claude directory
- no .mcp.json
- no .wrkrs directory

The integration test copies the fixture and runs git init before invoking wrkrs.

### existing-claude-repository

Purpose: prove preservation and coexistence.

Minimum contents:

- package.json or another project marker
- CLAUDE.md with a unique sentinel
- .claude/settings.json with representative permissions
- .claude/settings.local.json or an equivalent local-only fixture file
- .claude/agents/custom-reviewer.md
- .claude/skills/custom-skill/SKILL.md
- .claude/commands/custom-command.md
- a representative hook reference and script
- .mcp.json with a fake server and secret sentinel value used only to prove redaction
- no wrkrs-namespaced Claude path
- no .wrkrs directory

The fixture contains no real credential. Tests snapshot original bytes and modes and compare them after installation.

Additional focused unit fixtures may cover collisions, invalid JSON, symlinks, unsupported schema versions, and interrupted transactions.

## Implementation plan after approval

### Step 1: package and quality gates

- Initialize one private development package that will publish as wrkrs.
- Configure ESM, strict TypeScript, Node engine, npm scripts, and Vitest.
- Add a single bin and verify a packed-tarball smoke command.
- Add deterministic clock, ID, filesystem, process, and Git ports.

### Step 2: core domain and schemas

- Implement findings, roster, desired components, plan operations, conflicts, ownership modes, diagnostics, and result types.
- Implement config and manifest Zod schemas.
- Generate and drift-test the public JSON Schema.
- Implement stable hashing and canonical plan digest.

### Step 3: repository analyzer

- Resolve and validate Git root.
- Add bounded project detectors.
- Add Claude Code and existing-wrkrs detectors.
- Add redaction, file-size limits, path normalization, and symlink inspection.

### Step 4: preset and Claude adapter

- Implement the Product Engineering preset and specialization rules.
- Author portable role templates.
- Compile namespaced Claude agent projections.
- Compile the explicit wrkrs project skill.
- Validate generated frontmatter and role references.

### Step 5: plan and dry run

- Compare desired state to repository snapshots.
- Classify create, preserve, reuse, no-op, and block outcomes.
- Render exact create diffs and JSON plans.
- Compute plan digest.
- Add interactive confirmation and non-interactive safeguards.

### Step 6: transaction and ownership

- Implement exclusive lock, journal, precondition recheck, staged content, deterministic apply, validation, and reverse rollback.
- Write manifest as part of the transaction.
- Add fault-injection tests.

### Step 7: check

- Implement environment, config, ownership, drift, adapter, and transaction diagnostics.
- Add human and JSON reporters with stable exit codes.

### Step 8: fixture integration and package verification

- Complete clean and existing-Claude fixtures.
- Run the compiled CLI in temporary real Git worktrees.
- Add no-write, preservation, rollback, redaction, and tarball smoke assertions.
- Verify all acceptance tests and document any deliberately deferred test.

## Proposed dependencies for the first slice

Production dependencies requiring approval:

- commander: command parsing and generated help
- zod: runtime schemas and TypeScript inference
- yaml: YAML parsing, document-aware serialization, and future comment-preserving migrations

Development dependencies:

- typescript
- @types/node
- vitest
- @vitest/coverage-v8

No prompt, color, glob, diff, Git, UUID, hash, or process-execution package is required initially. Node built-ins cover those needs. jsonc-parser is the selected future dependency when the first shared strict-JSON structural edit is implemented; it is not needed for the create-only vertical slice.

## Vertical slice exit criteria

The slice is complete only when:

- all applicable acceptance tests pass
- the packed tarball smoke test passes
- clean and existing-Claude fixture dry runs are reviewed
- existing Claude files remain byte-identical
- rollback is proven through injected failure
- check identifies both a healthy install and deliberate drift
- no placeholder command or fake provider behavior is presented as implemented
- architecture.md, mvp.md, and decisions.md reflect any implementation changes
- no commit, push, npm publication, or release occurs without explicit approval

## Approval gate

Substantial implementation must not begin until the owner approves:

1. the architecture in architecture.md
2. the first vertical slice and acceptance tests in this document
3. the proposed production dependencies
4. whether this empty workspace should be initialized as the new wrkrs repository or a different repository should be attached

All four items were approved by the owner on 2026-08-29. The implementation repository is github.com/SmartScaleAI/wrkrs (public, MIT); see decisions.md for the approval record.

## First vertical slice implementation status

Implemented on 2026-08-29, committed as a8e4a5ba567dc06a96868bf941b242a00e30df49 on the review branch review/mvp-vertical-slice, and pushed for independent review. The review remediation recorded in decisions.md A-016 is held as local changes on that branch pending owner review.

Acceptance test coverage:

| Tests | Status | Where |
| --- | --- | --- |
| 1-2 | Verified | test/unit/repository/analyze.test.ts, test/integration/cli.test.ts |
| 3-5 | Verified | test/unit/repository/analyze.test.ts, test/unit/planner/init-plan.test.ts, test/integration/cli.test.ts |
| 6-10 | Verified | test/unit/core/roster.test.ts, test/unit/planner/init-plan.test.ts |
| 11-18 | Verified | test/unit/planner/init-plan.test.ts, test/unit/cli/program.test.ts, test/integration/cli.test.ts |
| 19-25 | Verified | test/unit/writer/transaction.test.ts, test/unit/planner/init-plan.test.ts, test/integration/cli.test.ts |
| 26-30 | Verified | test/unit/writer/transaction.test.ts, test/unit/check/check.test.ts |
| 31-37 | Verified | test/unit/check/check.test.ts, test/integration/cli.test.ts |
| 38 | Verified locally on macOS with Node 22.23.2 and Node 24.18.1; Ubuntu and Windows runs are part of Increment 4 cross-platform CI | npm test on both runtimes |
| 39 | Verified | test/unit/platform/paths.test.ts, test/unit/planner/init-plan.test.ts |
| 40-41 | Verified | scripts/smoke.mjs via npm run smoke |

Review remediation regression tests (decisions.md A-016):

| Finding | Where |
| --- | --- |
| Atomic no-replace publication, including a target created immediately before publication | test/unit/writer/publication.test.ts |
| Journal persistence failures before publication, after publication, after verification, during rollback, in both fixtures; exact retained-file reporting | test/unit/writer/journal-failures.test.ts |
| Read containment for symlinked .wrkrs, .claude, role sources, and final paths, with proof that outside content is never read or printed | test/unit/repository/containment.test.ts, test/integration/cli.test.ts |
| Sanitized parser diagnostics for malformed config, manifest, and journal documents across parse, check, dry-run, human, JSON, and unexpected-error paths | test/unit/config/redaction.test.ts, test/integration/cli.test.ts, test/fixtures/malformed-documents |
| Exact targets under bounded scans: more than 5,000 earlier entries, more than 500 components, a namespaced target and a case-only collision past the boundary, an incomplete listing | test/unit/planner/bounded-scan.test.ts |

Deliberately deferred, unchanged from the approved scope: update, uninstall, shared-file structural edits, providers, and cross-platform CI.
