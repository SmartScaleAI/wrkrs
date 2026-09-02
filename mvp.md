# wrkrs MVP

Status: Locked product scope; first, second, and third increments approved and implemented; Increment 4 (release hardening) in progress  
Last updated: 2026-09-02

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

The skill invokes the Product Manager worker, waits for that worker (`background: false`), and passes the user's requested outcome. It uses stable Claude subagents, not experimental Agent Teams. It grants no new permission and makes no settings, hooks, CLAUDE.md, or MCP change in this slice.

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

## Third increment: adaptive execution and capability bindings

Status: Plan approved by the owner on 2026-09-01 (decisions.md A-022, A-023, A-024). Increments 3A and 3B are implemented.  
Date proposed: 2026-09-01

### Goal

Make the installed team proportional to the task it is given, and let a worker reach the systems the repository already talks to — without wrkrs installing, authenticating, or brokering anything.

### Strict boundaries

This increment does not add: `.mcp.json` modification, provider account authentication, token storage, credential fields in configuration, arbitrary CLI execution, a broad provider catalog, dynamic third-party code loading, the `patched` ownership mode, a hosted service or UI, a marketplace, a proprietary runtime, new-application scaffolding, external ticket or design mutation, status synchronization, durable run state, automated resumption, a second project-management database, or any permanent frontend, backend, architecture, or data-science role.

No new production dependency. `jsonc-parser` is not added: nothing here performs a shared strict-JSON edit. The owner's approval to adopt it stands for the increment that first does.

### Capability vocabulary

The vocabulary distinguishes reading context from mutating a remote system, because a binding may honestly supply one and not the other. Selecting Figma must never imply the configured server can create a design.

| Capability | Kind | Meaning |
| --- | --- | --- |
| `source-control-context` | read | Branches, commits, diffs, and repository metadata beyond the local worktree |
| `pull-request-context` | read | Pull or merge requests, their state, and review threads |
| `pull-request-comment` | mutation | Adding a comment or review note to a pull request |
| `work-item-context` | read | Tickets, issues, acceptance criteria, and status |
| `work-item-update` | mutation | Changing a work item's fields or status |
| `design-file-context` | read | Design files, frames, and specifications |
| `design-comment-context` | read | Comments and feedback attached to a design |
| `design-update` | mutation | Creating or changing a design artifact |

The three mutation identifiers remain in the vocabulary so a binding can honestly say it supplies read context and not remote mutation. They are reserved and non-bindable in Increment 3: they must not be declared by a registered provider, offered during setup, projected into role or adapter files, or used as a `connections` key. The schema rejects a connection keyed by a reserved mutation capability with the stable diagnostic `CONNECTION_CAPABILITY_RESERVED`. Remote ticket, pull-request, and design mutation remain deferred.

This replaces the placeholder vocabulary shipped with the first slice (`source-control`, `pull-requests`, `work-items`, `design-files`, `design-comments`, `tool-context`). No migration is required: no provider was ever registered and no capability identifier has ever been written to disk. `tool-context` is not carried forward; the generic existing-MCP binding names its capabilities explicitly instead of claiming a catch-all.

`manual` is deliberately a binding kind rather than a capability. A capability describes what a worker needs; a binding describes how that need is met. Modelling "manual context" as a capability would mean a worker asks for manual-ness, which is never true — it asks for work items and is told a person will supply them.

### Configuration shape

Three shapes were considered.

**A. Keyed by capability (recommended)**

    connections:
      source-control-context:
        provider: github
        kind: cli
        executable: gh
      work-item-context:
        provider: linear
        kind: mcp-server
        server: linear
        scope: project
      design-file-context:
        provider: manual
        kind: manual
        note: Ask the owner for the current Figma link

One primary route per capability is a property of the file: a second route cannot be written, and YAML duplicate-key rejection (already enabled) makes a repeated capability a parse error rather than a semantic conflict wrkrs has to detect and rank. It reads as "who supplies this", which is the question setup asks.

The value is a strict discriminated union on `kind`, defined in full in architecture.md. Because the key is the capability, a binding never carries a capability list — including the generic existing-MCP route, which is one entry per capability rather than one entry claiming several.

The cost is repetition: a provider covering three capabilities is named three times, and renaming a server means editing each entry. For a roster this size that is a few lines.

**B. Keyed by provider** — closest to the current `providers: {}` record.

    providers:
      linear:
        kind: mcp-server
        server: linear
        capabilities: [work-item-context]

One entry per tool and no repetition, but two providers can both claim `work-item-context`, so ambiguity becomes a validation error wrkrs must detect, explain, and rank — exactly the automatic fan-out or hidden failover the owner ruled out. Preventing it needs a second primary-route map, at which point the file carries the same information twice.

**C. A list of bindings** — ordered entries, each naming a capability and a provider. Supports future failover, which is not wanted, makes duplicates easy to write, and is the worst of the three for targeted structural edits later.

**Recommendation: shape A.** It makes the locked rule structural instead of enforced after the fact, and it is the shape the setup questions produce directly.

The adaptive policy adds one more section:

    execution:
      profile: adaptive

`adaptive` lets the Product Manager triage each request. Naming `fast`, `standard`, or `full` sets a floor the Product Manager may raise and must never lower.

### Configuration migration

Two explicit one-version-at-a-time migrations, matching the discipline A-004 fixed for configuration and A-021 first exercised for the ownership manifest. (An earlier draft of this section cited A-020, which is the bookkeeping removal ledger and unrelated.)

- **schemaVersion 1 to 2** (Increment 3A): adds `execution`, defaulting `profile` to `adaptive`. Total and lossless.
- **schemaVersion 2 to 3** (Increment 3B): replaces `providers` with `connections`. Every installation in existence carries `providers: {}` because no provider was ever registered, so the migration maps an empty record to an empty record. A non-empty `providers` map can only come from hand editing; it is a blocking diagnostic. Every key is accounted for. Diagnostics never print hostile keys raw: output uses bounded, escaped, length-capped renderings, and control characters, ANSI, newlines, and overlong values never reach human or JSON output raw. Nothing is silently dropped.

`wrkrs check` reports an older configuration as migratable and never rewrites it; `wrkrs update` performs the migration, exactly as it already does for the ownership manifest.

A configuration migration must preserve what the owner wrote. `.wrkrs/config.yaml` is seeded and hand-editable, and today `serializeConfig` rebuilds it from the parsed object with a fixed header, which would discard comments, key order, and any formatting the owner chose. A migration therefore applies a **minimal edit through the yaml Document API** — add the `execution` mapping, rename `providers` to `connections` — preserving comments, ordering, and untouched sections including `extensions`. A-004 already requires the Document API for exactly this; the first slice never needed it because it only ever created the file.

This is a real implementation requirement, not a restatement: it changes how the migration path writes configuration, while the ordinary non-migrating update keeps the existing regenerate-and-compare behavior, including the A-021 rule that adopts an owner edit which round-trips through the generator.

A non-empty legacy `providers` map can only come from hand editing. It blocks the migration, every key is accounted for, and no key is dropped, rewritten, or silently migrated into `connections`: wrkrs cannot know which capability a hand-written provider entry was meant to satisfy. Diagnostics use bounded, escaped, length-capped renderings of those keys. Control characters, ANSI, newlines, and overlong values never reach human or JSON output raw.

The alternative — one combined bump to version 2 carrying both sections — is simpler to ship but couples two independent increments and leaves `connections: {}` inert in a released format. Two bumps are recommended.

### Setup and non-interactive behavior

Setup questions author configuration. They create no hidden state: everything an answer produces is visible in `.wrkrs/config.yaml` and in the plan before confirmation.

Questions are asked only when stdin is a terminal and neither `--yes` nor `--json` is present. `--dry-run` does not suppress them: a dry run must show the plan the real run would produce, and it still writes nothing.

| Invocation | Behavior |
| --- | --- |
| `wrkrs init` (terminal) | Asks the capability questions, shows the full mapping in the plan, then confirms |
| `wrkrs init --dry-run` (terminal) | Asks, shows the same plan and mapping, writes nothing |
| `wrkrs init --yes` | Asks nothing. Configures no binding. Reports each unbound capability and how to bind it |
| `wrkrs init --json` | Asks nothing, same as `--yes`. Applying with `--json` still requires `--yes` |
| Any non-terminal stdin | Asks nothing, same as `--yes` |
| `wrkrs update` | Never asks. Bindings change by editing configuration and running update |

No answer is ever guessed or defaulted to a vendor. The default for every question is "skip", which is also the deterministic non-interactive answer, so a non-interactive run is exactly an interactive run where every question was skipped.

Each question offers only choices derived from the registered provider definitions and from what the scan actually verified — the exact MCP server names read from `.mcp.json` — plus the manual fallback and skip. Dedicated GitHub, Linear, and Figma MCP choices appear only when a verified server name contains a matching token (`github`/`gh`, `linear`, `figma`); unmatched names remain available through the generic existing-MCP provider. There is no opaque "Other" free-text option. A connection wrkrs cannot see is reachable through the generic existing-MCP binding by naming the server on that capability's question, or through the manual fallback. Reserved mutation capabilities are never asked or offered.

The canonical question set is one question per Increment 3 read capability. Question IDs are capability-derived. Human interactive setup and machine discovery emit the same set, in this order:

1. What supplies `source-control-context`?
2. What supplies `pull-request-context`?
3. What supplies `work-item-context`?
4. What supplies `design-file-context`?
5. What supplies `design-comment-context`?

Each choice encodes the full binding: provider, binding kind, scope, and server or executable identity. A follow-up "which server, and which capabilities" question is unnecessary because that information is already in the choice. A dedicated Linear choice and a generic MCP choice that reference the same server are distinct choices with distinct IDs.

The complete capability-to-connection mapping appears in the plan, with its verification state, before any confirmation.

Because `wrkrs update` never prompts, an installation created with `--yes` is bound by hand. The generated configuration carries commented guidance listing the available binding kinds and the server names the scan found, so the edit is a few lines with the candidates already in front of the owner. A later `wrkrs update --interactive` is the obvious extension and is deliberately not in this increment.

### Machine-driven setup protocol

A GUI, an agent, or any other non-human caller needs the same setup questions without a CLI process sitting idle while a person thinks. This increment adds the protocol, not a GUI and not a runtime adapter. Human terminal prompts are unchanged.

Two distinct digests are required:

- `questionSetDigest` identifies the canonical discovered questions and choices.
- The plan digest identifies the exact semantic installation plan generated from accepted answers.

The protocol is three separate invocations, none of which ever blocks:

**1. Discover.** `wrkrs init --json --questions` emits the question set and `questionSetDigest`, prompts zero times, writes nothing, and exits.

    {
      "schemaVersion": 1,
      "command": "init",
      "mode": "questions",
      "questionSetDigest": "sha256:...",
      "questions": [
        {
          "id": "capability.work-item-context",
          "capability": "work-item-context",
          "prompt": "What supplies work items?",
          "default": "skip",
          "choices": [
            { "id": "skip", "kind": "skip" },
            { "id": "manual", "provider": "manual", "kind": "manual" },
            {
              "id": "provider:linear:kind:mcp-server:scope:project:server:linear",
              "provider": "linear",
              "kind": "mcp-server",
              "server": "linear",
              "scope": "project",
              "verification": "verified-project"
            },
            {
              "id": "provider:mcp:kind:mcp-server:scope:project:server:linear",
              "provider": "mcp",
              "kind": "mcp-server",
              "server": "linear",
              "scope": "project",
              "verification": "verified-project"
            }
          ]
        }
      ]
    }

Question identifiers are stable and capability-derived, not ordinal, so a caller can answer them in any order and across wrkrs versions. Choice identifiers are deterministic and unique across provider, binding kind, scope, and server or executable identity. A dedicated Linear choice and a generic MCP choice referencing the same server never share an ID. Every choice comes from the registered providers and from server names the scan verified; there is no free-text choice; a server name that failed identifier validation is not offered; reserved mutation capabilities are not offered at all.

**2. Answer and preview.** `wrkrs init --json --dry-run --answers <file>` reads a strict versioned document through the dedicated input-document port, recomputes and validates the question set, rejects a stale `questionSetDigest`, produces the semantic plan and plan digest, and exits. Nothing is written.

    {
      "schemaVersion": 1,
      "questionSetDigest": "sha256:...",
      "answers": {
        "capability.work-item-context": "provider:linear:kind:mcp-server:scope:project:server:linear"
      }
    }

Validation is strict: an unknown question id, an unknown choice id, a duplicate, a missing `schemaVersion`, a missing or stale `questionSetDigest`, or any unknown key is a stable error and no plan is produced. A stale `questionSetDigest` is `QUESTION_SET_DIGEST_MISMATCH`. An unanswered question is `skip`, which binds nothing — the same deterministic default as every other non-interactive path.

**3. Apply against an approved plan digest.** `wrkrs init --json --yes --answers <file> --expect-digest <plan-digest>` recomputes the questions and the plan and applies only when both the answers document and the expected plan digest remain valid.

A stale `questionSetDigest` is `QUESTION_SET_DIGEST_MISMATCH`, exit 1, nothing written. A plan-digest mismatch is `PLAN_DIGEST_MISMATCH`, exit 1, nothing written. `--expect-digest` names the plan digest from step 2, never `questionSetDigest`. `questionSetDigest` is compared across question discovery and later validation. The plan digest is compared only between preview and apply. Changing an answer changes the plan digest. Changing the available question choices changes `questionSetDigest`. `--expect-digest` is optional for a human at a terminal and is how a machine caller closes the loop.

`--yes` without `--answers` is unchanged: no questions, no bindings, no guessed vendor. `--questions` and `--answers` never prompt regardless of whether stdin is a terminal.

### Answers-document input

The `--answers` file is an explicitly supplied input document, not repository content. It is not read through the hardened repository filesystem port. A dedicated input-document port owns this boundary:

- Absolute paths and paths relative to the invocation working directory are allowed, including GUI-created temporary files outside the repository.
- Open read-only. wrkrs never writes to the answers file.
- The final path must be a regular file. Do not follow a final symlink.
- Verify file identity with the opened handle against what lstat reported.
- Enforce a conservative size limit of 64 KiB.
- Require valid UTF-8 and strict JSON. Reject duplicate keys.
- Never echo raw answer contents or parser-provided source excerpts.
- Emit only controlled, sanitized diagnostics. Secret-shaped values and control characters in the file never reach human or JSON output raw.

### Provider registry and portable contracts

The canonical contract is `ProviderDefinition` in architecture.md, together
with the binding schema, the provider-to-capability matrix, and the
verification states defined beside it. It is defined once there and referenced
here rather than restated, so the two documents cannot drift.

What this increment adds around that contract:

- an explicit registry map assembled by the composition root, with no dynamic loading
- five registered providers: `github`, `linear`, `figma`, `mcp`, `manual`
- a provider exists only when it can describe a capability it genuinely supplies; no placeholder is registered

`planConfiguration` is removed from the contract rather than left unimplemented. Providers may return probes, diagnostics, validation results, and sanitized guidance. They never return a `DesiredComponent`, never access the writer, and never reach the transaction. The runtime adapter compiles provider guidance into files wrkrs already owns. The writer, the transaction, and the ownership modes are untouched.

`probe` reads only the `RepositorySnapshot` the analyzer already produced and the PATH lookup the environment port already performs. No provider executes a command, opens a socket, or reads a credential.

### Claude Code adapter compilation

Bindings compile into the files wrkrs already owns and nowhere else:

- Each agent projection gains a Connections section listing every bound capability, its provider, its binding kind, the exact server name where one applies, and its verification state.
- The `/wrkrs` skill gains a one-line summary of what the team can and cannot reach.
- A `declared-unverified` binding is labeled as such in the projection, so a worker never assumes the connection is present.
- An unbound Increment 3 read capability is stated as unbound, with the manual fallback if one is configured. Reserved mutation capabilities are never listed as unbound, offered, or projected.

The adapter never emits an MCP server definition, never writes an `mcpServers` block, never adds `allowed-tools` or any other permission, and never touches `.claude/settings.json`, hooks, `CLAUDE.md`, or `.mcp.json`. A server is referenced by name only.

### check behavior for bindings

| Code | Severity | When |
| --- | --- | --- |
| `CONNECTION_OK` | info | `verified-project`, `verified-environment`, or `manual` |
| `CONNECTION_UNVERIFIED` | warning | `declared-unverified`: a user-, local-, or cloud-scoped server repository files cannot confirm |
| `CONNECTION_SERVER_MISSING` | error | `absent` where the binding declared `scope: project` |
| `CONNECTION_CLI_UNAVAILABLE` | warning | `absent` for a `cli` binding: the executable is not on PATH here |
| `CONNECTION_PROVIDER_UNKNOWN` | error | Binding names a provider this wrkrs version does not register |
| `CONNECTION_CAPABILITY_UNSUPPORTED` | error | Provider cannot supply the capability it is bound to, per the provider matrix |
| `CONNECTION_CAPABILITY_RESERVED` | error | A `connections` key is a reserved mutation capability (`pull-request-comment`, `work-item-update`, or `design-update`) |
| `CONNECTION_BINDING_INVALID` | error | The binding violates the discriminated schema: wrong kind fields, unknown key, or a capability list |
| `CONNECTION_IDENTIFIER_REJECTED` | error | A server name, executable, or note failed identifier validation and was not compiled into any file |
| `CONNECTION_SERVER_PROVIDER_MISMATCH` | error | A dedicated provider is bound to an MCP server whose name does not identify that provider |
| `CONNECTION_CAPABILITY_UNBOUND` | info | An Increment 3 read capability has no binding |

Reserved mutation capabilities are never reported as unbound. There is no ambiguity diagnostic: the capability-keyed shape cannot express two routes for one capability, and a repeated key is already a parse error.

`CONNECTION_UNVERIFIED` and `CONNECTION_CLI_UNAVAILABLE` are warnings rather than errors because an environment-owned connection legitimately differs between a local machine and a Claude Code cloud session. `CONNECTION_SERVER_MISSING` is an error because `scope: project` asserts a fact about `.mcp.json` that wrkrs checked and found false. A `verified-environment` binding is reported as environment-scoped, never as a portable repository fact.

Every diagnostic is sanitized the way the existing ones are: stable code, exact path, controlled message, no raw provider output, no network call, no execution. A rejected identifier is reported with a bounded, escaped, length-capped rendering of the offending value, never the raw bytes.

### Update and uninstall

Nothing new is required. Bindings live in `.wrkrs/config.yaml`, which is seeded and owner-editable; the projections that reference them are managed. Changing a binding is an ordinary `wrkrs update`: unchanged projections are replaced, drifted ones are preserved and reported, and the existing ownership rules apply unchanged. Uninstall removes only wrkrs-owned files. `.mcp.json` is never an operation target in any plan, which is what makes its preservation provable rather than promised.

### Adaptive Product Manager routing

Triage is bounded and evaluates three criteria independently. Severity and ticket priority are never used as a proxy.

| Criterion | Question |
| --- | --- |
| Work size | How much code, how many systems, how much coordination? |
| Risk | What happens if this is wrong, and how hard is it to roll back? |
| Ambiguity | What product or technical decisions are still open? |

Profiles:

**Fast** — appropriate only when every condition holds: acceptance criteria are clear; the change is localized and reversible; no novel product or UX decision is required; nothing touches migration, production dependencies, permissions, authentication, security, billing, or an external integration; and focused verification can prove the result. Workflow: very short plan through the existing approval gate, no Product Designer unless a genuine product decision appears, one Software Engineer, focused engineering verification, no separate QA worker unless risk or unexpected behavior surfaces, and a Product Manager check against the acceptance criteria.

**Standard** — moderate multi-file or multi-module work, contained regression risk, or reuse of existing patterns. Workflow: concise plan, optional design, one engineer by default, parallel engineering only for clearly independent work, QA validates affected behavior and the acceptance criteria.

**Full** — required for major ambiguity or any high-risk trigger: new user-facing workflows; authentication, authorization, permissions, security, or billing; production data migrations; major architecture change; new production dependencies; multiple external systems; difficult rollback; or broad regression risk. Workflow: detailed approved plan, appropriate product and technical design, specialized engineer instances where useful, comprehensive QA and owner validation, and every existing release and external-action gate.

Output contract, reported before work begins:

    Execution profile: Fast
    Planning: minimal
    Product design: none
    Technical design: none
    Engineering: one worker
    Verification: targeted
    Reason: Localized, reversible change with clear acceptance criteria and no high-risk triggers.

The owner may request a faster or more thorough workflow. The Product Manager may always escalate and never de-escalates below a floor the owner set. A speed request removes stages, never a gate: planning approval, security and permissions, secrets, billing, production dependencies, data migrations, external integrations, merges, deployments, publications, and releases stand in every profile.

### What is enforceable and what is not

| Behavior | Enforcement |
| --- | --- |
| Triage criteria, profile rules, high-risk triggers, and prohibitions are present in the role definitions and projections | Enforceable: template and snapshot tests |
| `execution.profile` validates, defaults, rejects unknown values, and reaches the projections | Enforceable: schema and adapter tests |
| Binding shape, provider identity, capability support, reserved mutation rejection, and verification state | Enforceable: schema, validator, and check tests |
| `.mcp.json`, settings, hooks, and permissions are untouched | Enforceable: byte- and mode-identity assertions |
| Repository-derived identifiers are validated, and a rejected one reaches no generated file | Enforceable: validator and hostile-fixture tests |
| Migrations preserve comments, ordering, and owner edits | Enforceable: migration round-trip tests |
| Machine-mode discovery with `questionSetDigest`, answer validation, plan-digest match, and zero prompts | Enforceable: protocol integration tests |
| `--answers` file I/O: dedicated port, regular file, no final symlink, size limit, UTF-8, strict JSON, duplicate-key rejection, sanitized diagnostics, never written | Enforceable: input-document tests |
| The stage-log block, its canonical vocabulary, retries as a separate metric, its self-reported label, and its not-measured line exist in the template | Enforceable: template tests |
| The profile a worker actually selects for a given request | Prompt-guided only |
| Whether a worker truly skips the designer, stays in scope, or reports honestly | Prompt-guided only |
| Whether the stage log a worker fills in is accurate | Prompt-guided only |

The CLI enforces everything above the divide. It cannot enforce anything below it, and nothing in the documentation, the diagnostics, or the tests may claim it does. A manual Claude Code evaluation is the only way to observe runtime routing, and it is named as a manual check rather than automated.

### Workflow cost measurement

The only evidence available is the owner's report that one apparently simple feature took roughly 37 minutes. The repository was searched for a corresponding transcript, report, timing record, or fixture: **none exists**. No timing breakdown is asserted here and no cause is claimed.

Diagnosing that run would need a per-stage record with start and end timestamps and per-worker tool-call counts, distinguishing Product Manager investigation and planning, design, engineering, test execution, QA, retries, coordination, and final reporting.

Three options, none free:

1. **Self-reported stage log** — the Product Manager lists the stages it ran and what each produced, in its final report. Needs no runtime support and ships with the templates. It is model-reported, not measured, and must be labeled as such wherever it appears.
2. **Session transcript analysis** — a later read-only command parses the runtime's own session transcripts. Genuinely measured, but depends on a transcript location and format wrkrs does not control, and is runtime-specific.
3. **Runtime hooks emitting timestamps** — accurate and cheap to read, but wrkrs writing hooks contradicts the locked rule that it never changes settings or hooks, so it would need separate explicit approval.

Decision for this increment: **option 1 ships in 3A**, with a bounded output block so it can be tested rather than merely described. Options 2 and 3 are deferred and named, not built.

The stage log is compiled into the Product Manager definition as a fixed final block:

    Stage log (self-reported by the Product Manager; not measured)
      triage:           run
      planning:         run
      product design:   skipped - no user-facing decision
      technical design: skipped - existing pattern reused
      engineering:      run
      verification:     run
      qa:               skipped - profile Fast, no risk discovered
      reporting:        run
    Retries: 0
    Elapsed time: not measured by wrkrs

Canonical stages are triage, planning, product design, technical design, engineering, verification, QA, and reporting. Each appears exactly once as `run` or `skipped`; a skipped stage carries a short reason. `retries` is a separate numeric metric, not a workflow stage. The header states that it is self-reported. The elapsed-time line is fixed text: `Elapsed time: not measured by wrkrs`. wrkrs does not measure elapsed time and no worker may substitute an estimate for it. If a future increment obtains real per-stage timing from the runtime, that line becomes the only place it appears. No timing is invented and no cause is claimed for the previously reported thirty-seven-minute run.

This is prompt-guided output. The enforceable half is that the template defines the block, the stage vocabulary, the self-reported label, the retries metric, and the not-measured line; whether a worker fills it in honestly is not something the CLI can verify.

### First Increment 3 vertical slice

Split into two sequenced slices, smallest first:

**3A — adaptive execution refinement.** Role definitions and projections carry the triage, profiles, output contract, gates, prohibitions, and the bounded self-reported stage log using the canonical stage vocabulary, with `retries` as a separate numeric metric. Configuration schema version 2 adds `execution.profile`, with the first comment-preserving configuration migration. No new command, no provider work. This is the smaller and lower-risk half, it addresses the cost the owner actually reported, and it can ship alone.

**3B — capability bindings.** Capability vocabulary with reserved non-bindable mutation identifiers; `connections` configuration at schema version 3 with the second migration; provider registry with GitHub, Linear, Figma, generic existing-MCP, and manual, each limited to Increment 3 read capabilities; read-only verification against `.mcp.json`; identifier validation for untrusted repository-derived values; human setup questions and the two-digest machine-driven setup protocol; safe answers-document input; adapter compilation of sanitized provider guidance; and check diagnostics.

If either fallback proves too large for 3B, the schema direction is preserved and the exact deferral recorded; no placeholder provider is registered and no provider claims behavior it does not implement.

### Third increment acceptance tests

Type key: U unit, S template or snapshot, I integration, M manual Claude Code evaluation (not automated).

Numbering continues from the second increment, which ended at 73. Increment 3 acceptance tests are contiguous from 74 through 143 with no duplicates or gaps: 74–105 existing Increment 3 tests, 106–109 stage log, 110–119 configuration migration, 120–127 untrusted identifiers, 128–139 machine protocol and safe answers input, 140–143 packaging and regression.

#### Adaptive execution (3A)

| # | Test | Type |
| --- | --- | --- |
| 74 | The Product Manager definition contains work size, risk, and ambiguity as three independently evaluated criteria, and states that severity and priority are not proxies for complexity | S |
| 75 | Fast, Standard, and Full each carry explicit selection rules | S |
| 76 | Every high-risk trigger appears in the mandatory-escalation list, and the Fast rules exclude every one of them | U |
| 77 | Role definitions state that participation is per-profile, not automatic, for the Designer and the QA Engineer | S |
| 78 | Technical design routes to a Software Engineer specialization; no new permanent role identifier appears in the preset or any projection | U |
| 79 | The Fast profile's output block is present and bounded to the routing report | S |
| 80 | Every profile requires verification evidence and a final acceptance check against the criteria | S |
| 81 | The definitions state that the owner may raise rigor and that a speed request cannot bypass any mandatory gate | S |
| 82 | The definitions prohibit unrelated refactoring, speculative improvement, unnecessary research, and unrequested documentation | S |
| 83 | `execution.profile` accepts `adaptive`, `fast`, `standard`, and `full`, rejects anything else, defaults to `adaptive`, and appears in the compiled agent projections | U |
| 84 | No generated content claims measured timing; any stage report is labeled self-reported, and unmeasured timing is reported as unavailable | U |
| 85 | Runtime routing behaves per profile for a representative fast, standard, and full request | M |

#### Capability bindings (3B)

| # | Test | Type |
| --- | --- | --- |
| 86 | Every registered provider declares only Increment 3 read capabilities from the vocabulary, and declares no capability it cannot describe. Generic MCP and manual declare those same read capabilities, not every vocabulary entry. No registered provider declares a reserved mutation capability | U |
| 87 | One capability cannot route to two providers: the shape forbids it and a duplicated capability key is a parse error | U |
| 88 | An existing project MCP server name is mapped and referenced without changing `.mcp.json` | I |
| 89 | `.mcp.json` is byte- and mode-identical after init, update, check, and uninstall in the existing-Claude fixture | I |
| 90 | The schema defines no credential-bearing field: every binding shape is a closed discriminated union, and any unknown key — token-shaped or not — fails validation. wrkrs never requests, generates, or knowingly emits a credential; no prompt, template, or diagnostic asks for one | U |
| 91 | A bound server name appears only in wrkrs-owned files; no generated file contains an MCP server definition, an `mcpServers` key, or a command or URL for a server; no other file changes | I |
| 92 | The schema rejects a `connections` key that is a reserved mutation capability (`pull-request-comment`, `work-item-update`, `design-update`) with `CONNECTION_CAPABILITY_RESERVED`. Those identifiers are never offered in setup, declared by a registered provider, or compiled into a projection | U |
| 93 | No permission is broadened: settings, hooks, and `CLAUDE.md` are untouched and no projection adds a tool grant | I |
| 94 | A user-, local-, or cloud-scoped server is representable and reported `declared-unverified`; a `cli` found on PATH is reported `verified-environment` and never as a portable repository fact | U |
| 95 | Missing, unknown-provider, and unsupported-capability bindings each produce a stable sanitized diagnostic with the exact path | U |
| 96 | The manual fallback compiles instructions with no server reference | U |
| 97 | A generic existing-MCP binding satisfies exactly the capability its map key names; a `capabilities` list inside any binding is a schema violation reported as `CONNECTION_BINDING_INVALID` | U |
| 98 | Changing a binding replaces only the unchanged wrkrs-owned projections | U |
| 99 | A customized seeded or drifted managed file follows the existing preserve-and-report rules when bindings change | U |
| 100 | JSON plan and check output is deterministic and ANSI-free and carries no raw provider output | I |
| 101 | `--yes`, `--json`, and a non-terminal stdin never prompt and configure no binding | I |
| 102 | Setup offers only registered providers and server names verified from `.mcp.json`, plus manual and skip; there is no free-text option; reserved mutation capabilities are never offered | U |
| 103 | No test requires a network account, a real credential, or provider execution | U |
| 104 | `jsonc-parser` is absent from the dependency set | U |
| 105 | The clean and existing-Claude fixtures remain preserved through every command | I |

#### Workflow-cost stage log (3A)

| # | Test | Type |
| --- | --- | --- |
| 106 | The Product Manager definition contains the stage-log block with every canonical stage exactly once: triage, planning, product design, technical design, engineering, verification, QA, and reporting. `retries` appears only as a separate numeric metric, not as a workflow stage | S |
| 107 | The block is labeled self-reported and names the Product Manager as its source | S |
| 108 | The elapsed-time line is exactly `Elapsed time: not measured by wrkrs`; no template, projection, or diagnostic contains a duration, a rate, an estimate, or a claimed cause for any reported workflow duration | U |
| 109 | Each stage is marked `run` or `skipped`, and a skipped stage carries a short reason | S |

#### Configuration migration (3A and 3B)

| # | Test | Type |
| --- | --- | --- |
| 110 | A version 1 configuration migrates to version 2, adding `execution.profile: adaptive` and changing nothing else | U |
| 111 | A version 2 configuration migrates to version 3, replacing an empty `providers` record with an empty `connections` map | U |
| 112 | A version 1 configuration migrates to version 3 through both steps in order, never skipping a version | U |
| 113 | `check` reports a version 1 and a version 2 configuration as migratable, names the command that migrates it, and rewrites no byte: the file hash and the whole-tree hash are unchanged | U, I |
| 114 | A migration preserves owner comments, key order, blank lines, and `extensions` content exactly; only the migrated keys differ | U |
| 115 | A migration preserves an owner edit elsewhere in the file, including a roster or governance change made by hand | U |
| 116 | A non-empty legacy `providers` map blocks the migration. Every key is accounted for. Diagnostics use bounded, escaped, length-capped renderings. Nothing is dropped, rewritten, or migrated into `connections` | U |
| 117 | A hostile legacy `providers` key containing control characters, ANSI, newlines, or an overlong value never reaches human or JSON output raw; the migration still blocks and every key is still accounted for | U |
| 118 | `update --dry-run` on an unmigrated configuration shows the migration diff and writes nothing | I |
| 119 | `update --yes` applies the migration and the resulting configuration passes `check` at the new version; a post-apply validation failure during a migrating update rolls back to the exact prior configuration bytes, comments and ordering included | U, I |

#### Repository-derived identifiers are untrusted (3B)

| # | Test | Type |
| --- | --- | --- |
| 120 | Provider identifiers, MCP server names, executable names, scope values, and notes each validate against a bounded character class and length | U |
| 121 | A server name containing a control character, an ANSI escape sequence, a newline, or a carriage return is rejected and never compiled into any generated file | U |
| 122 | A server name containing Markdown structural characters — backticks, fences, brackets, heading or list markers — cannot alter the structure of a generated projection | U, S |
| 123 | A prompt-injection-shaped server name, for example one reading as an instruction to an agent, appears in no generated instruction text; the binding is rejected and reported instead | U, S |
| 124 | A server name that would break YAML round-tripping is rejected rather than quoted into configuration | U |
| 125 | A hostile `.mcp.json` fixture leaves human output free of escape sequences and JSON output free of ANSI and of raw bytes from the file | I |
| 126 | A rejected identifier produces `CONNECTION_IDENTIFIER_REJECTED` naming the exact path, with the value rendered bounded, escaped, and length-capped | U |
| 127 | An executable value containing a path separator, an argument, or shell metacharacters is rejected; wrkrs performs a PATH lookup only and executes nothing | U |

#### Machine-driven setup protocol and safe answers input (3B)

| # | Test | Type |
| --- | --- | --- |
| 128 | `init --json --questions` emits the question set and `questionSetDigest`, capability-derived question IDs, and deterministic choice IDs unique across provider, binding kind, scope, and server or executable identity; it offers only registered providers and verified server names plus manual and skip; it never offers a reserved mutation capability; it exits without prompting and writes nothing | I |
| 129 | An answers document with an unknown question id, an unknown choice id, a duplicate answer, a missing `schemaVersion`, a missing `questionSetDigest`, or an unknown key is rejected with a stable sanitized error and produces no plan | U |
| 130 | An unanswered question is treated as `skip` and binds nothing | U |
| 131 | `init --json --dry-run --answers` recomputes and validates the question set, rejects a stale `questionSetDigest` with `QUESTION_SET_DIGEST_MISMATCH`, produces the semantic plan and plan digest, and writes nothing | I |
| 132 | `questionSetDigest` is identical between `--questions` discovery and later validation of the same repository and provider set; changing the available question choices changes `questionSetDigest` | U |
| 133 | `init --json --yes --answers --expect-digest` applies only when the answers document, including `questionSetDigest`, remains valid and the expected plan digest matches the recomputed plan | I |
| 134 | A plan-digest mismatch produces `PLAN_DIGEST_MISMATCH`, exit 1, and no write | I |
| 135 | The plan digest is compared only between preview and apply; changing an answer changes the plan digest; `questionSetDigest` is not used as the plan digest | U |
| 136 | A dedicated Linear choice and a generic MCP choice referencing the same server have distinct choice IDs | U |
| 137 | `--answers` accepts an absolute path and a path relative to the invocation working directory, including a regular file outside the repository; it uses the dedicated input-document port, not the repository filesystem port; the file is opened read-only and never written | I |
| 138 | `--answers` rejects a final symlink, a non-regular file, a file over 64 KiB, malformed UTF-8, malformed JSON, and duplicate JSON keys, each with a stable sanitized diagnostic and no plan | U |
| 139 | Every machine-mode invocation emits pure JSON with no ANSI and issues zero prompts, whether or not stdin is a terminal; diagnostics never echo raw answer contents, parser source excerpts, secret-shaped values, or control characters | I |

#### Packaging and regression

| # | Test | Type |
| --- | --- | --- |
| 140 | Acceptance tests 1 through 73 continue to pass | U, I |
| 141 | The packed tarball still carries exactly the required assets and the single `wrkrs` bin; a provider template ships only when a provider actually has one | I |
| 142 | No registered provider claims behavior it does not implement | U |
| 143 | The documented Node engine floor and platform support are unchanged | U |

### Third increment deferrals

Recorded deliberately, with no placeholder behavior standing in for any of them: `.mcp.json` writes and the `patched` ownership mode; `jsonc-parser`; provider account authentication and token storage; a `wrkrs provider` command; `wrkrs update --interactive` and the machine protocol on `update`, which lands on `init` only; a GUI or any runtime adapter that consumes the machine protocol; a broad provider catalog including Jira as a dedicated provider; mutation capabilities being exercised by any behavior; external ticket, status, and design mutation; durable task context storage and synchronization (D-007, D-008); live orchestration and automated resumption (D-008); additional runtime adapters including Cursor (D-009); hosted state of any kind; and measured per-stage timing through transcripts or hooks. Cross-platform CI is Increment 4.

## Fourth increment: release hardening

Status: Implemented locally on 2026-09-02. GitHub Actions has not yet run on origin. Publication to npm is not part of this increment.  
Date proposed: 2026-09-02

### Goal

Make wrkrs verifiable on the platforms it claims to support, keep schema migrations pinned to committed fixtures, and leave the package ready to publish without publishing it.

### Scope

- GitHub Actions `verify` on Ubuntu and macOS for Node 22.12.0 (engine floor) and Node 24 (preferred).
- A Windows job that only proves fail-closed behavior: `--help` and `--version` work; `init` reports `ENVIRONMENT_CONTAINMENT_UNSUPPORTED` and writes nothing. Full Windows contained I/O stays deferred.
- Committed configuration migration fixtures for schema versions 1 and 2, including a blocked non-empty `providers` map.
- README coverage of `connections`, execution profiles, and the machine-driven init protocol.
- CHANGELOG and package metadata for an eventual release. `private` stays true. No provenance, signing, or `npm publish`.

### Fourth increment acceptance tests

Numbering continues from 143.

| # | Test | Type |
| --- | --- | --- |
| 144 | The verify workflow runs Ubuntu and macOS on Node 22.12.0 and Node 24, with contents:read only | U |
| 145 | Windows CI runs `--help`, `--version`, and fail-closed init; it does not run the POSIX verify suite | U |
| 146 | Committed version 1 and version 2 configuration fixtures migrate with comments preserved | U |
| 147 | The committed non-empty `providers` fixture blocks migration | U |
| 148 | README documents `connections` and `init --questions` / `--answers` / `--expect-digest` | U |
| 149 | The package remains private, MIT-licensed, engine `>=22.12`, with the single `wrkrs` bin | U |
| 150 | Acceptance tests 1 through 143 continue to pass | U, I |

### Follow-up: waiting skill, dedicated MCP matching, installed-team contract

| # | Test | Type |
| --- | --- | --- |
| 151 | The wrkrs skill frontmatter includes `background: false` with `context: fork` and `agent: wrkrs-product-manager`; `check` rejects any other `background` value | U, I |
| 152 | Dedicated GitHub, Linear, and Figma providers are offered and validated only for MCP server names that contain a matching token (`github`/`gh`, `linear`, `figma`); unmatched names remain available through generic `mcp`; a hand-edited mismatch is `CONNECTION_SERVER_PROVIDER_MISMATCH` and is not `CONNECTION_OK` | U, I |
| 153 | After `init --yes`, the installed team contract holds: four namespaced agents exist with matching `name` fields, the skill waits and delegates to `wrkrs-product-manager`, and `wrkrs check` passes. Presence of a `claude` executable is recorded via `--version` only and never fails CI | I |

### Fourth increment deferrals

npm provenance, signing, trusted publishing, and the actual npm publication (decisions.md D-005). Full Windows contained I/O. Changing the Node engine floor or adding a second runtime.

