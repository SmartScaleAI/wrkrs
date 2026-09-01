# wrkrs MVP

Status: Locked product scope; first vertical slice and second increment approved by the owner and implemented  
Last updated: 2026-08-31

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

Implemented on 2026-08-29, committed as a8e4a5ba567dc06a96868bf941b242a00e30df49 on the review branch review/mvp-vertical-slice, and pushed for independent review. Five review rounds followed on that branch: A-016 as baab7195004463c06ff3bc0aa1b8b765eb34df0b, A-017 as 14c8c4c0890196741a86e7ad045c04bb5ef0e81a, A-018 as 61df451e41d6884082983af1376c5a030a300f7b, A-019 as 0b8b9140328e7678ee85ce5b4c9d50de0e17c10a, and A-020 as 6d186d0d0371af9aeab19915ee0150d414e422d3. Remote main still points at the initial slice commit; no round has been merged.

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

Second review round regression tests (decisions.md A-017):

| Finding | Where |
| --- | --- |
| Separated publication and staging cleanup: staging unlink fails once or permanently, journal fails after publication with staging present, no rolled-back while either name exists, external targets identical | test/unit/writer/publication-lifecycle.test.ts, test/unit/writer/publication.test.ts |
| Atomic publication without a copy fallback: unsupported hard links never invoke copyFile or create the target, controlled environment conflict, tree restored, existing targets never replaced, hard-link path atomic | test/unit/writer/atomic-publication.test.ts |
| Containment bound to I/O: ancestor swapped between scanner reads, after preconditions, before publication, and before rollback; outside tree byte- and mode-identical; outputs redacted; fixtures still install | test/unit/writer/containment-race.test.ts, test/unit/repository/containment.test.ts |
| Journal durability: temp bytes fsynced before rename, live journal replaced only by rename, directory synced after rename, sync failure before and after publication, best-effort reporting, no rolled-back without verification | test/unit/writer/journal-durability.test.ts, test/unit/writer/journal-failures.test.ts |

Third review round regression tests (decisions.md A-018):

| Finding | Where |
| --- | --- |
| Exclusive writes that fail after creation: partial staging cleaned up (both fixtures) or named exactly, lock and journal-temporary contracts, EEXIST entries preserved byte- and mode-for-mode, no rolled-back while a staging name exists | test/unit/writer/exclusive-write.test.ts |
| Containment capability gate: unsupported blocks init --dry-run, apply, and check content reads with a stable sanitized diagnostic; --help and --version still work; supported platforms unchanged | test/unit/writer/containment-capability.test.ts |
| Removal durability ordering for staging cleanup, target and staging rollback, generated directories; EIO after rollback unlink and during bookkeeping cleanup; unsupported sync; serialized best-effort journal | test/unit/writer/removal-durability.test.ts |
| Process-wide binding: nested call rejected promptly, cross-instance serialization, concurrent repositories isolated, closed BoundDirectory refused, working directory restored, segment disappearing or changing during binding | test/unit/platform/binding.test.ts |

Fourth review round regression tests (decisions.md A-019):

| Finding | Where |
| --- | --- |
| Conservative partial-staging retention: exact retained path in both fixtures, external replacement preserved byte- and mode-for-mode, no rolled-back while a staging name exists | test/unit/writer/exclusive-write.test.ts |
| Lock creation tracked separately from its directory sync: EIO after creation in transaction-created and pre-existing .wrkrs, exact-tree restore, unremovable lock with recovery journal | test/unit/writer/bookkeeping.test.ts |
| Durable final lock release on the rollback-incomplete exit: unlink failure, sync failure after removal, faked unlink, unique retained paths | test/unit/writer/bookkeeping.test.ts |
| Successful installs keep .wrkrs with no bookkeeping warning and pass check | test/unit/writer/bookkeeping.test.ts |
| Journal-temp retention cleared after proven cleanup; permanent failure still names the existing temp exactly | test/unit/writer/bookkeeping.test.ts, test/unit/writer/exclusive-write.test.ts |

Fifth review round regression tests (decisions.md A-020):

| Finding | Where |
| --- | --- |
| A failed cleanup sync names every exact pending path (`.wrkrs/.lock`, `.wrkrs/.journal.json`, the journal temporary) and never substitutes `.wrkrs` | test/unit/writer/bookkeeping.test.ts |
| A retried journal temporary loses its stale unlink-failure reason and is reported as durability-unproven, once | test/unit/writer/bookkeeping.test.ts |
| A later successful journal-persist sync clears the reconciled lock entry while the genuinely retained agent stays | test/unit/writer/bookkeeping.test.ts |
| A persistent sync failure keeps the exact `.wrkrs/.lock` entry, a best-effort journal, and honest `wrkrs check` diagnostics | test/unit/writer/bookkeeping.test.ts |

Deliberately deferred, unchanged from the approved scope: update, uninstall, shared-file structural edits, providers, and cross-platform CI. Verified on macOS with Node 22.23.2 and 24.18.1. Linux is unverified; Windows fails closed by design in this MVP and is not supported until the cross-platform increment.

## Second increment: lifecycle safety

Status: Approved by the owner on 2026-08-31 and implemented  
Date proposed: 2026-08-31

### Goal

Prove that wrkrs can change and remove its own installation as safely as it created it. Every replacement and every removal runs through the same analyzer, planner, diff renderer, and journaled transaction that init uses, and no customized or unrecognized byte is ever destroyed.

### User-visible commands

    npx wrkrs update
    npx wrkrs update --dry-run
    npx wrkrs update --yes
    npx wrkrs update --json --dry-run
    npx wrkrs uninstall
    npx wrkrs uninstall --dry-run
    npx wrkrs uninstall --yes
    npx wrkrs uninstall --json --dry-run

Both commands accept `--cwd` and resolve the Git worktree root exactly as init and check do. Exit codes are unchanged: 0 success with warnings allowed, 1 error or blocked plan, 2 invalid usage.

### Desired state for update

Update recomputes desired state from two owned inputs only:

1. the packaged wrkrs version, which supplies role templates, adapter projections, the JSON Schema, and the configuration serializer
2. the repository's own `.wrkrs/config.yaml`, which supplies the roster, role sources, specializations, governance, and extensions

Repository detection runs read-only during update, but only as an evidence source. It supplies the machine-readable evidence rendered into the Software Engineer role for specializations that config already declares. Detection never adds a role, removes a role, adds a specialization, or removes one. A specialization declared in config with no current evidence is rendered without evidence and reported as an informational finding; it is never dropped.

Changing the recommended roster from a rescanned repository remains an init-time decision and is deliberately out of scope for this increment.

### update behavior

update must:

1. Reject a directory that is not inside a non-bare Git worktree.
2. Require a valid existing installation: config and manifest present, parsed, and at supported schema versions. Otherwise block and direct the user to `wrkrs init`.
3. Refuse to run while another wrkrs transaction holds the lock or an interrupted journal is present.
4. Perform no target writes before confirmation.
5. Recompute the current hash of every owned entry and classify drift before planning.
6. Replace a managed file whose current hash equals its last applied hash and whose desired content differs.
7. Report a no-op for a managed file already byte-identical to its desired content.
8. Preserve a drifted managed file, naming the exact path and reason, and never overwrite it.
9. Preserve a customized seeded file, report it, and never overwrite it.
10. Replace an undrifted seeded file only when the packaged template changed.
11. Create a file that the desired state adds and the manifest does not own.
12. Remove a managed file that the manifest owns, the desired state no longer contains, and whose hash is unchanged; preserve and report it when drifted.
13. Never modify or delete a referenced entry.
14. Never touch a path that is neither in the manifest nor in the desired state.
15. Display an exact diff for every create, every replace, and every removal.
16. Require confirmation, or `--yes` in non-interactive mode.
17. Recheck plan preconditions, including every expected hash, immediately before apply.
18. Apply through a transaction that restores exact prior bytes and modes on rollback.
19. Write the updated manifest only after post-apply validation passes.
20. Leave Git history and the working tree commit state under the developer's control.

Drift is preserved per file rather than aborting the run. A drifted managed file is reported as preserved, the remaining operations still apply, and `wrkrs check` continues to report the drift afterwards. The rejected alternative was blocking the whole run until the user reverts the edit; it makes update unusable in exactly the repositories that customized the most, and it hides the fact that every other file is already reconcilable. The consequence is accepted explicitly: an update can leave a stale projection beside a changed role file, and that state is detectable, reported at the moment it happens, and reported again by check.

### uninstall behavior

uninstall must:

1. Reject a directory that is not inside a non-bare Git worktree.
2. Build the plan solely from a validated manifest and current bytes. Packaged templates are never consulted.
3. Refuse to run while another wrkrs transaction holds the lock or an interrupted journal is present.
4. Perform no target deletions before confirmation.
5. Remove a managed entry whose current hash still equals its last applied hash.
6. Preserve and report a drifted managed entry.
7. Remove a seeded entry whose current hash is unchanged.
8. Preserve and report a customized seeded entry.
9. Never delete a referenced entry.
10. Remove only directories the manifest records as created, only when empty at removal time, deepest first.
11. Remove the manifest and the `.wrkrs` directory when nothing owned remains.
12. Retain a reduced manifest in partial-uninstall state, listing only the preserved entries, when anything remains.
13. Display the exact path and reason for every removal and every preservation.
14. Require confirmation, or `--yes` in non-interactive mode.
15. Recheck preconditions immediately before apply.
16. Restore every removed byte and mode on rollback.
17. Leave every unrelated file untouched, including CLAUDE.md, settings, hooks, commands, pre-existing agents and skills, and .mcp.json.

A `--force` option is deliberately out of scope. Nothing in this increment deletes customized content, so the recoverable-backup mechanism that architecture.md requires of any force option is not built yet.

### Format changes

Manifest schema version 2 adds one required field:

    "state": "installed" | "partial-uninstall"

A version 1 manifest is migrated to version 2 by setting `state` to `installed`. The migration is explicit and one-way, as A-008 requires; `wrkrs check` reads a version 1 manifest and reports it as migratable without migrating it. The alternative, an optional field inside version 1, was rejected because absence would have to be inferred as `installed`, which is exactly the guessing the schema-version discipline exists to prevent, and because the first real migration is cheaper to build and test now than after publication.

The journal schema extends two enumerations in place, without a version bump, because every version 1 journal remains valid under the wider enumerations:

- `command` becomes `init | update | uninstall`
- `kind` becomes `create-file | create-directory | replace-file | remove-file | remove-directory`

### Writer extensions

The transactional writer gains three operations beside the existing exclusive create:

- `replace-file`: stage the new content, back up the prior bytes and mode inside `.wrkrs`, publish by rename, and restore the backup on rollback.
- `remove-file`: back up the bytes and mode, unlink, and restore the backup on rollback.
- `remove-directory`: remove only a directory the manifest records as created, only when empty, deepest first, and recreate it on rollback.

The no-replace invariant that A-017 and A-018 established for init is preserved exactly. Exclusive creation still refuses to replace an existing target. Replacement and removal are distinct, explicitly planned operations that may only target a path the manifest already owns and whose current hash matched at precondition recheck, so an unknown or unowned entry is still never overwritten or deleted by any code path.

### Second increment acceptance tests

#### Preconditions and refusal

42. update outside a Git worktree exits with an error and writes nothing.
43. update without an installation blocks, names `wrkrs init`, and writes nothing.
44. update or uninstall against an unsupported config or manifest schema version blocks and writes nothing.
45. update and uninstall refuse to run while a lock or an interrupted journal is present.
46. A non-interactive update or uninstall without `--yes` refuses to apply.
47. update --dry-run and uninstall --dry-run create, change, and remove no bytes; a complete before/after tree hash is identical.

#### Update planning

48. An installation that is already current plans no operation and reports a no-op.
49. Adding a specialization to config.yaml replans exactly the Software Engineer role file and its Claude projection, and nothing else.
50. Removing a role from config.yaml plans removal of exactly that role file and its projection, and nothing else.
51. A drifted managed projection is preserved and reported by exact path, and every other operation still applies.
52. An undrifted managed projection is replaced with exactly the desired bytes and its new hash is recorded.
53. A customized seeded role file is preserved and reported, and its bytes are unchanged.
54. update writes no path that is neither in the manifest nor in the desired state.
55. The update plan JSON contains no ANSI escape sequences, and its digest is stable across repositories and absolute paths.
56. A specialization declared in config with no current evidence is rendered without evidence and reported, not dropped.

#### Uninstall

57. uninstall in a clean installation removes exactly the owned files and created directories, leaving the repository byte-identical to its pre-init state.
58. uninstall in the existing-Claude fixture leaves every pre-existing file byte- and mode-identical.
59. A drifted managed file is preserved by uninstall and reported.
60. A customized seeded file is preserved by uninstall and reported.
61. When anything is preserved, a reduced manifest in partial-uninstall state remains, listing only the retained entries.
62. Re-running uninstall after a partial uninstall is safe and removes anything that has since become removable.
63. A directory wrkrs created that is not empty is left in place and reported.
64. A directory wrkrs did not create is never removed.

#### Transaction, rollback, and check

65. An injected failure during update rolls back and restores every replaced and removed file to its exact prior bytes and mode.
66. An injected failure during uninstall restores every removed file to its exact prior bytes and mode.
67. A precondition change between planning and apply aborts before the first mutation, for both commands.
68. A file externally changed after wrkrs replaced or removed it is not clobbered by rollback, and the recovery report names the exact path.
69. check reports a partial-uninstall manifest with a stable diagnostic instead of a healthy installation.
70. check reads a version 1 manifest and reports it as migratable without migrating it.
71. check passes after a successful update.

#### Packaging

72. The tarball smoke test also exercises update --dry-run, update --yes, uninstall --dry-run, and uninstall --yes.
73. Unit and integration tests pass on the supported Node floor and the preferred LTS version.

### Second increment test fixtures

The two committed repository fixtures are reused unchanged. Lifecycle fixtures are built by the tests from a real validated install rather than committed, so no fixture can drift from what init actually produces:

- installed-repository: the clean fixture after a validated `init --yes`
- customized-installation: an installation with one drifted managed projection and one customized seeded role
- partial-uninstall-installation: the residue left by an uninstall that preserved at least one entry
- a committed version 1 manifest fixture for the migration and check tests

### Second increment implementation plan

1. Extend the plan model with replace and remove outcomes, removal diffs, and their conflict families.
2. Extend the journal enumerations and add manifest schema version 2 with its explicit version 1 migration.
3. Extend the transactional writer with backup staging, replace, remove, directory removal, and restore-on-rollback.
4. Build the update desired-state compiler from config, preset, and detection evidence.
5. Implement the update command, its human and JSON reporters, and its confirmation surface.
6. Implement the uninstall command, its reporters, and the reduced-manifest write.
7. Add check diagnostics for partial-uninstall state and a migratable manifest.
8. Add the lifecycle fixtures, acceptance tests 42 through 73, and the extended tarball smoke assertions.

### Second increment dependencies

No new production dependency. jsonc-parser remains unnecessary because this increment performs no shared strict-JSON structural edit: everything update and uninstall touch is a wrkrs-owned whole file.

### Second increment exit criteria

The increment is complete only when:

- acceptance tests 42 through 73 pass
- the packed tarball smoke test covers update and uninstall
- rollback is proven by injected failure for both replacement and removal
- existing Claude files remain byte-identical after update and after uninstall
- no test destroys a customized byte
- architecture.md, mvp.md, and decisions.md reflect any implementation change
- no commit, push, npm publication, or release occurs without explicit approval

### Second increment approval gate

Implementation must not begin until the owner approves:

1. the update desired-state sources, in particular detection as an evidence-only input
2. the per-file drift policy for update, rather than blocking the whole run
3. manifest schema version 2 with an explicit version 1 migration
4. the deferral of `--force` and of field-specific merges
5. acceptance tests 42 through 73

## Second increment implementation status

Implemented on 2026-08-31 on the review branch review/mvp-vertical-slice, following the approved scope above. All 32 acceptance tests pass alongside the 41 from the first slice.

Acceptance test coverage:

| Tests | Status | Where |
| --- | --- | --- |
| 42-47 | Verified | test/unit/lifecycle/update.test.ts, test/unit/lifecycle/uninstall.test.ts, test/integration/cli.test.ts |
| 48-56 | Verified | test/unit/lifecycle/update.test.ts, test/integration/cli.test.ts |
| 57-64 | Verified | test/unit/lifecycle/uninstall.test.ts, test/unit/planner/lifecycle-plan.test.ts |
| 65-68 | Verified | test/unit/lifecycle/rollback.test.ts |
| 69-71 | Verified | test/unit/check/lifecycle-check.test.ts |
| 72 | Verified | scripts/smoke.mjs via npm run smoke |
| 73 | Verified locally on macOS with Node 22.23.2 and Node 24.18.1; Ubuntu and Windows runs remain part of Increment 4 cross-platform CI | npm test and npm run smoke on both runtimes |

Implementation notes recorded during the increment:

- The writer's `replace-file`, `remove-file`, and `remove-directory` operations were added beside exclusive create, which keeps its no-replace contract unchanged. A replacement or removal first hard-links the existing entry to a sibling backup name, so the original inode survives until the transaction validates; rollback restores it with a single atomic rename inside the bound parent directory.
- Backups are released after the commit point, not per operation. An earlier operation must stay reversible while a later one runs, so every backup lives until the whole transaction has validated. A backup that cannot be released afterwards is reported by exact path as `TRANSACTION_BACKUP_RETAINED` and never changes the committed result.
- Directory removals run after the commit, once every backup and bookkeeping file inside them is gone. A directory that still holds entries is left in place and reported as `DIRECTORY_RETAINED`; leaving an empty directory behind is not a safety failure, and forcing it would be.
- Uninstall does not read `.wrkrs/config.yaml`. It plans from the validated manifest and current bytes alone, which is also what makes acceptance test 62 work: a partial uninstall has already removed configuration, and the retry that finishes the job must still run.
- `wrkrs check` reads the manifest before the configuration, because the installation state decides how a missing configuration is judged. After a partial uninstall the absence of config.yaml is reported as `CONFIG_REMOVED_BY_UNINSTALL`, not as an error.
- An update adopts an edit to a seeded file that round-trips through the generator: when the file already holds exactly what wrkrs would write, that hash is recorded as last applied. Without this, editing `.wrkrs/config.yaml` — the intended workflow — would mark it customized forever and force every later uninstall to end partial.

Deliberately deferred, unchanged from the approved scope: `--force` uninstall, field-specific merges for drifted managed files (decisions.md D-003), providers, and cross-platform CI. Verified on macOS with Node 22.23.2 and 24.18.1. Linux is unverified; Windows fails closed by design and is not supported until the cross-platform increment.
