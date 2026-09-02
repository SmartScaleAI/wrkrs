# wrkrs decision log

Last updated: 2026-09-02

Statuses:

- Locked: established by the project source of truth and not reopened here
- Proposed: recommended by this architecture phase and awaiting owner approval
- Approved: recommended by this architecture phase and approved by the owner on 2026-08-29
- Deferred: intentionally postponed until evidence requires a decision
- Superseded: retained for history but no longer active

## Repository inspection

### R-000: Treat the CLI implementation as greenfield

Status: Approved  
Date: 2026-08-29

The attached workspace is empty and is not a Git repository. No wrkrs application code, architecture.md, mvp.md, decisions.md, project_overview.md, or matching GitHub repository was available through the connected sources.

Consequence:

- The project custom instructions are the only available source of truth for this architecture phase.
- No implementation code or unrelated repository changes exist to preserve.
- The owner must approve initializing this workspace as the new wrkrs repository or attach the intended repository before implementation.

Resolution (2026-08-29): the owner selected the public GitHub repository SmartScaleAI/wrkrs, licensed under MIT, as the implementation repository. The local checkout is a Git repository on main with that repository configured as origin. At the time of that resolution the remote repository existed and was empty and nothing had been committed or pushed.

Update (2026-08-29, later): the first vertical slice was committed as a8e4a5ba567dc06a96868bf941b242a00e30df49 and pushed to the review branch review/mvp-vertical-slice. The remote now also has main at that same commit as its default branch.

## Locked product decisions

### P-001: CLI-first repository installer

Status: Locked

wrkrs is an open-source CLI that installs a structured AI development team into an existing repository. It is not a chat application, hosted agent workspace, proprietary runtime, or application scaffolder.

### P-002: Product terminology

Status: Locked

The product name is lowercase wrkrs. A worker is a configured AI agent. Role, specialization, worker instance, framework preset, repository roster, and task crew retain the definitions in the project instructions.

### P-003: Claude Code first, portable core

Status: Locked

Claude Code is the first fully supported runtime. Repository configuration must work locally and in Claude Code cloud sessions. Core schemas and workflow concepts must remain portable to future runtime adapters.

### P-004: Stable subagents, not experimental Agent Teams

Status: Locked

Claude subagents are the default execution mechanism. Parallel workers may use available parallel capabilities only for clearly independent tasks. Experimental Agent Teams cannot be required.

### P-005: Default Product Engineering roster

Status: Locked

The default roles are Product Manager, Product Designer, Software Engineer, and QA Engineer. Product Manager is primary. One Software Engineer role gains task-specific specializations and may have multiple independent worker instances.

### P-006: Conservative existing-repository contract

Status: Locked

Inspect before write, preserve existing files, show a complete dry-run plan, block ambiguity, never weaken permissions, and never silently overwrite Claude, MCP, hook, skill, agent, or settings configuration.

### P-007: Repository-owned core

Status: Locked

Essential repository configuration and local workflows remain open-source and repository-owned. A future hosted control plane may add cross-repository and organization features but is not required for local operation.

### P-008: Capability-based integrations

Status: Locked

Workflows depend on capabilities rather than GitHub, Linear, Figma, or another vendor directly. The complete MVP has dedicated GitHub, Linear, and Figma providers plus generic MCP and manual fallbacks.

### P-009: Explicit governance gates

Status: Locked

Plans, user-facing designs, major product choices, merges, deployments, publications, releases, secrets, billing, external integrations, signing, entitlements, permissions, CI security, production dependencies, and data migrations require the approvals defined in the project instructions.

### P-010: No automatic repository or release actions

Status: Locked

wrkrs never automatically commits, pushes, merges, deploys, publishes, or releases.

### P-011: Installation health command is wrkrs check

Status: Locked

The read-only installation health command is wrkrs check, with machine-readable output available through wrkrs check --json. It validates the environment, configuration, repository roster, role references, ownership manifest, managed-file drift, Claude Code adapter, conflicts, and interrupted transactions. It never modifies or repairs the repository. Any future repair workflow remains a separate planned and confirmed command.

## Proposed technical decisions

### A-001: TypeScript and maintained Node.js

Status: Approved  
Date: 2026-08-29

Decision:

- Implement in strict TypeScript.
- Compile to ESM JavaScript.
- Set the runtime floor to Node.js 22.12.
- Prefer Node.js 24 for development and test Node 22 plus Node 24 in CI.
- Use TypeScript NodeNext module semantics and explicit output compilation.

Rationale:

- npx is the primary invocation, so Node and npm are the shortest distribution path.
- Node 20 is end-of-life.
- Node 22.12 matches the chosen Commander version's minimum and preserves a broader developer base than a Node 24-only package.

Alternatives rejected for the MVP:

- Rust and Go add native release and npm-wrapper work.
- Python creates environment and distribution mismatch.
- Executing TypeScript source adds runtime loader complexity.

Implementation note (2026-08-29): the slice compiles with TypeScript 5.9.3. TypeScript 7.0 (the native compiler) had been published only weeks before implementation, so the mature 5.9 line was chosen; moving to 7.x is a build-tooling decision for release hardening. @types/node is pinned to the 22 line so the type surface cannot exceed the engine floor.

### A-002: One npm package with internal modules

Status: Approved  
Date: 2026-08-29

Decision:

- Publish one package and one wrkrs bin.
- Use npm and a committed package-lock.json.
- Keep core, repository, config, planner, writer, Claude adapter, providers, check, and CLI as internal modules.
- Do not create a workspace until independent publication or versioning is needed.

Rationale:

- A solo MVP benefits from one build, version, test graph, and release.
- Interfaces and dependency direction provide enough extensibility now.
- Moving a module to a package later is cheaper than maintaining several unused packages today.

### A-003: Commander as the CLI framework

Status: Approved  
Date: 2026-08-29

Decision:

- Use Commander 15 for parsing, subcommands, usage errors, version, and help.
- Keep command handlers thin.
- Implement a PromptPort using node:readline/promises for the small first-slice interaction set.

Rationale:

- Commander is mature and focused.
- oclif would duplicate the runtime/provider extension system.
- Citty and Clipanion do not provide enough first-slice value to offset a smaller or less stable ecosystem.
- A separate prompt library is unnecessary until roster editing needs richer interaction.

### A-004: YAML configuration with Zod and emitted JSON Schema

Status: Approved  
Date: 2026-08-29

Decision:

- Store user configuration in .wrkrs/config.yaml.
- Define schemas in Zod 4 and emit a checked JSON Schema as .wrkrs/schema.json.
- Use the yaml Document API for YAML parsing and future comment-preserving changes.
- Make schemaVersion mandatory and integer-valued.
- Keep the root strict, with explicit provider and extensions escape hatches.

Rationale:

- YAML is easier to edit for rosters and governance than strict JSON or TOML.
- Zod provides one TypeScript/runtime source and first-party JSON Schema output.
- Executable configuration is rejected because repository inspection must not execute code.

### A-005: Git CLI is authoritative for repository location

Status: Approved  
Date: 2026-08-29

Decision:

- Resolve the target with git rev-parse --show-toplevel.
- Reject directories outside a non-bare worktree.
- Execute Git without a shell.
- Use bounded declarative file detectors for project and Claude signals.

Rationale:

- Existing Git repositories are a product requirement.
- Git handles worktrees and gitfiles more correctly than a custom .git ascent.
- Remote provider APIs cannot describe local uncommitted configuration.

### A-006: Direct Claude project files instead of plugin installation

Status: Approved  
Date: 2026-08-29

Decision:

- Generate portable role definitions in .wrkrs/roles.
- Generate namespaced Claude project agents in .claude/agents.
- Generate an explicit .claude/skills/wrkrs/SKILL.md entry point that runs the Product Manager worker.
- Do not modify CLAUDE.md, settings, hooks, permissions, commands, or .mcp.json in the first slice.
- Do not require a Claude plugin or marketplace.

Rationale:

- Project agents and skills are repository-owned, inspectable, version-controlled, and available to local and cloud sessions.
- Claude plugins are useful distribution units but introduce installation state outside the repository.
- Namespaced files minimize collision risk.

### A-007: Immutable semantic plans and field-specific merges

Status: Approved  
Date: 2026-08-29

Decision:

- Compile desired state in memory.
- Compare it with exact repository snapshots to produce an immutable InstallPlan.
- Classify paths as create, structural-merge, reuse, preserve, no-op, or block.
- Include preconditions, exact proposed bytes, hashes, diffs, management mode, reason, and rollback data.
- Forbid generic recursive merge.
- Use adapter/provider-owned merge strategies.

Rationale:

- The plan becomes the common contract for dry-run, apply, update, uninstall, tests, and JSON output.
- Field-specific merges are reviewable and can enforce security semantics.

### A-008: Use document-aware structural editors only when needed

Status: Approved  
Date: 2026-08-29

Decision:

- Use yaml Document for wrkrs-owned YAML.
- Select jsonc-parser for future localized strict-JSON edits, configured to reject comments where the target format is strict.
- Use marked, uniquely namespaced blocks for any future shared Markdown change.
- Do not add jsonc-parser to the first create-only slice.

Rationale:

- Re-serializing an entire shared file creates unnecessary diffs and can erase formatting.
- The first slice proves preservation without taking on unused merge code.

### A-009: Hash-based ownership manifest

Status: Approved  
Date: 2026-08-29

Decision:

- Store .wrkrs/manifest.json after a successful validated apply.
- Record schema version, installation ID, wrkrs version, preset and adapter versions, repository-relative entries, source IDs, management modes, last-applied hashes, and created directories.
- Support managed, seeded, patched, and referenced modes.
- Store no credentials, absolute paths, or full backups in the durable manifest.

Rationale:

- Exact hashes make drift observable.
- Management modes distinguish projections from editable source and external reuse.
- Durable full-file backups would retain unrelated or sensitive content unnecessarily.

### A-010: Journaled transactional writer with conservative rollback

Status: Approved  
Date: 2026-08-29

Decision:

- Acquire an exclusive lock only after confirmation.
- Recheck all operation preconditions.
- Stage content, keep transient backups for modified files, and journal completed operations.
- Apply in deterministic order and validate before success.
- Roll back in reverse.
- Never delete or restore a path during rollback if its current hash proves an external edit happened after wrkrs wrote it.

Rationale:

- A multi-file filesystem update cannot be globally atomic.
- A journal and exact-hash rollback provide the strongest practical recovery without a daemon or database.

### A-011: Conservative update and uninstall semantics

Status: Approved  
Date: 2026-08-29

Decision:

- Reuse the analyzer, planner, diff, and writer for lifecycle commands.
- Update untouched managed files; preserve and block drifted files unless a safe field-specific merge exists.
- Delete only unchanged owned material during uninstall.
- Never delete referenced content.
- Retain a reduced manifest after a partial uninstall.

Rationale:

- Safe behavior is more important than forcing a clean uninstall.
- The manifest must remain useful until all conflicts are resolved.

### A-012: Vitest plus real temporary Git fixture tests

Status: Approved  
Date: 2026-08-29

Decision:

- Use Vitest for unit, integration, snapshot, and fault-injection tests.
- Copy fixtures into temporary directories and initialize real Git worktrees.
- Require a clean repository fixture and an existing-Claude fixture.
- Test the packed npm tarball, not only source imports.
- Run cross-platform CI after the first local slice passes.

Rationale:

- The highest risks are filesystem behavior, byte preservation, path handling, and package contents.
- In-memory mocks alone cannot prove those behaviors.

### A-013: First vertical slice is create-only for shared configuration

Status: Approved  
Date: 2026-08-29

Decision:

- Implement init, dry-run, confirmation, create-only transactional apply, manifest, and check.
- Detect and preserve existing shared Claude configuration.
- Block namespaced collisions.
- Defer update, uninstall, shared-file edits, and provider configuration to later increments.

Rationale:

- This proves the product's central safety promise with real behavior.
- Shared merges can be introduced alongside the first feature that needs them and tested against a concrete format.

### A-014: Minimal first-slice dependency set

Status: Approved  
Date: 2026-08-29

Decision:

Production:

- commander
- zod
- yaml

Development:

- typescript
- @types/node
- vitest
- @vitest/coverage-v8

Rationale:

- Node built-ins cover prompts, filesystem, process execution, hashing, UUIDs, paths, and temporary directories.
- Every additional production dependency increases install and supply-chain surface.

Implementation note (2026-08-29): installed as commander 15.0.0, zod 4.5.4, yaml 2.9.0 (production) and typescript 5.9.3, @types/node 22.x, vitest 4.1.11, @vitest/coverage-v8 4.1.11 (development). prettier 3.9.6 was added as a development-only dependency so the repository has a formatting check; it has no production surface and is excluded from Markdown (approved documents and packaged templates are hand-controlled). No linter dependency was added; module boundaries and cycle freedom are enforced by a unit test over the import graph.

### A-015: Implementation refinements recorded during the first vertical slice

Status: Proposed  
Date: 2026-08-29

These refinements were made while implementing the approved architecture. None changes approved scope or safety behavior; they are recorded for owner review.

Decision:

- The ownership manifest bytes are compiled at plan time. The installation identifier and timestamps come from injectable ports, so the dry run shows exactly the manifest bytes that apply writes, and the plan digest excludes the manifest hash, timestamps, and the installation identifier.
- Create operations are staged as a sibling temporary file in the target directory, renamed into place, re-read, and hash-verified before the journal records them as applied. The create-only slice needs no file backups.
- The .wrkrs directory doubles as the transaction bookkeeping location: .wrkrs/.lock is the exclusive lock and .wrkrs/.journal.json is the journal. When .wrkrs does not exist it is created before the lock and removed again on abort or complete rollback; it is retained, with the journal, when rollback is incomplete.
- Re-running init against a valid existing installation never writes: unchanged owned files are no-ops, customized seeded files are preserved, and any other difference blocks with a pointer to the planned update command.
- check reports managed-file drift as an error, seeded customization as information, and changes to referenced files as warnings. A blocked dry run exits with code 1 so scripts can detect it.
- The Claude project skill frontmatter is name, description, argument-hint, disable-model-invocation: true, context: fork, and agent: wrkrs-product-manager. Agent projections carry only name and description; no tools, permissions, hooks, or model settings are granted.
- Specialization rules in the Product Engineering preset: javascript, typescript, web-frontend, node-backend, apple-platforms, python-backend, go-services, rust, and monorepo-tooling, each requiring a detected signal with evidence.
- Source layout additions beyond the recommended tree: src/init/init.ts (the init application service), src/presets/product-engineering (preset rules and role templates), src/core/ports.ts (port interfaces so the core never imports platform code), src/core/snapshot.ts, src/core/diagnostics.ts, src/core/configuration.ts, src/core/versions.ts, src/core/template.ts, src/core/frontmatter.ts, src/adapters/registry.ts, src/platform/environment.ts, src/platform/package-info.ts, src/check/context.ts, scripts/ (build asset copy, schema generation, tarball smoke test), and schema/ (the committed JSON Schema asset that a unit test keeps identical to the Zod output).

Rationale:

- Exact bytes in the dry run are more honest than a manifest preview whose identifier and timestamps would change at apply time.
- Keeping transaction bookkeeping inside .wrkrs avoids writing anywhere outside the planned installation footprint.
- Treating an existing installation as read-only for init keeps update semantics in the planned update command instead of duplicating them.

### A-016: Review remediation of the first vertical slice

Status: Proposed  
Date: 2026-08-29

An independent review of commit a8e4a5ba567dc06a96868bf941b242a00e30df49 confirmed five findings. The corrections below were implemented as local changes on review/mvp-vertical-slice and are recorded here for owner review. None changes approved scope; each tightens an already-approved safety promise.

Decision:

- Publication is atomic and never replaces. `FileSystemPort.publishFileExclusive(staging, target)` creates the target name with a hard link (`copyFile` with `COPYFILE_EXCL` only where hard links are unsupported) and fails with EEXIST for any existing file, directory, or symlink. The earlier absence check followed by `rename` is gone because `rename` can replace a file created concurrently. A target that appears is reported as `PRECONDITION_TARGET_APPEARED` with its exact path and is never touched.
- Journal persistence is durable and rollback is reconciled. The journal is replaced through a temporary sibling and `rename`, never truncated in place. Journal operations record the staging path and expected hash before publication and move through planned, staged, published, and applied; the in-memory journal is advanced before each persistence attempt. Rollback reconciles staging and target paths against recorded hashes, deletes only hash-matching files, verifies every created path is gone, and reports rolled-back only then; otherwise rollback-incomplete lists every exact retained path and the journal is kept. A file whose bytes no longer match what wrkrs wrote is retained, because it is indistinguishable from an external edit.
- Reads are contained. The scanner, `wrkrs check`, and Claude adapter validation read only through `platform/contained-path.ts`, which normalizes paths, inspects every ancestor with lstat, refuses symlinked ancestors and symlinked targets, and proves the real ancestor stays inside the real root. The `.wrkrs` and `.claude` types are checked before any child is read.
- Parser diagnostics are sanitized. YAML and JSON parser messages are never forwarded; controlled codes with line and column metadata replace them for config, manifest, and journal parsing. Schema violation messages are limited to expected-shape text. Unexpected CLI errors print only the error class.
- Bounded scans cannot misclassify a known target. Every desired generated target and its ancestors are snapshotted exactly after desired-state compilation, together with parent directory listings, and the planner classifies only from those. Incomplete listings block with `SCAN_INCOMPLETE`; case-aliased ancestors or targets block with `PATH_CASE_COLLISION`.
- Journal format change: the journal operation gained `expectedHash` and the `published` status. The journal is transient transaction bookkeeping with no released consumer, so no migration is provided; `check` reports a journal it cannot parse as `TRANSACTION_JOURNAL_UNREADABLE`.

Rationale:

- Each finding described a way an already-promised invariant (no overwrite, provable rollback, no reads outside the worktree, no secret leakage, exact dry run) could be violated under a race, a crash, a symlink, a malformed file, or a large tree. The corrections make the invariants hold by construction and are proven by fault-injection tests.

### A-017: Second review round: bound I/O, separated publication lifecycle, durable journal

Status: Proposed  
Date: 2026-08-30

An independent review of commit baab7195004463c06ff3bc0aa1b8b765eb34df0b confirmed four remaining findings: publication and staging cleanup were one fallible step, publication could silently fall back to a non-atomic copy, containment was checked by pathname and cached rather than bound to each operation, and journal replacement did not sync the containing directory. The corrections below were implemented on review/mvp-vertical-slice and are recorded for owner review. Scope is unchanged.

Decision:

- Port contract. `FileSystemPort` now exposes only `lstat`, `realpath`, and `withinDirectory(root, directory, operation)`; the path-based read, write, rename, unlink, mkdir, rmdir, and `publishFileExclusive` methods were removed so no repository I/O can bypass containment. `withinDirectory` binds the directory and passes a `BoundDirectory` with name-relative `lstat`, `readFile`, `readDirectory`, `writeFileExclusive`, `linkExclusive`, `unlink`, `rename`, `makeDirectory`, `removeDirectory`, and `sync`. Binding failures raise `ContainmentError` (`PATH_ROOT_INVALID`, `PATH_ANCESTOR_MISSING`, `PATH_ANCESTOR_SYMLINK`, `PATH_ANCESTOR_NOT_A_DIRECTORY`, `PATH_ANCESTOR_CHANGED`, `PATH_ENTRY_CHANGED`); an unsupported hard link raises `AtomicPublicationUnsupportedError`.
- Binding mechanism. The Node port walks each segment with lstat, enters it with `process.chdir`, and verifies the entered directory's device and inode against the lstat result; operations then use relative names, with O_NOFOLLOW and a handle-identity check for reads and O_EXCL plus O_NOFOLLOW for creates. Node has no `openat` family, so the process working directory is the only portable descriptor-bound anchor; the port serializes calls, rejects nesting, and restores the previous working directory after every operation. Consequence: contained operations must not run concurrently in one process and cannot run in worker threads (Vitest is pinned to the forks pool).
- Publication lifecycle. planned, staged (staging path and expected hash persisted), published (target name created by hard link; staging path retained in the journal until its removal is verified), applied (target re-read and hash-verified). The in-memory journal reflects publication before the directory sync, the journal persist, and the staging cleanup. Rollback reconciles staging and target names by recorded hash inside their bound parent, treats a missing ancestor as proof of absence, retains anything it cannot prove, and returns rolled-back only when every created name is proven absent.
- No copy fallback. `linkExclusive` maps EPERM, ENOTSUP, EOPNOTSUPP, ENOSYS, EXDEV, and EMLINK to `AtomicPublicationUnsupportedError`; the transaction reports `ENVIRONMENT_ATOMIC_PUBLICATION_UNSUPPORTED` (family ENVIRONMENT) with a controlled message and rolls back. Atomicity is claimed only for hard-link publication on filesystems that support it.
- Durability guarantee. The journal is replaced by write-temp (O_EXCL), fsync, rename, then fsync of the `.wrkrs` directory; publication, directory creation, and rollback removals are followed by an fsync of the containing directory. The journal records `durability: strict` when every sync succeeded and `best-effort` when the platform reported directory syncing unsupported (EISDIR, EPERM, EINVAL, ENOTSUP, EOPNOTSUPP, EBADF, EACCES, ENOSYS), in which case the apply result carries `TRANSACTION_DURABILITY_BEST_EFFORT`; any other sync error is a transaction failure. Strict durability means: once a journal state or a published entry is reported, it survives a power loss on filesystems that require directory fsync. Journal schema change: `durability` is a required field (transient bookkeeping; no migration).
- New stable codes: `ENVIRONMENT_ATOMIC_PUBLICATION_UNSUPPORTED`, `PATH_ANCESTOR_CHANGED`, `TRANSACTION_DURABILITY_BEST_EFFORT`; reader failure codes `PATH_ANCESTOR_CHANGED` and `PATH_ENTRY_CHANGED`. Rolled-back and rollback-incomplete results now carry the stable `conflict` in human and JSON output.
- Verification status. Verified on macOS with Node 22.23.2 and 24.18.1 only. Linux and Windows are unverified. On Windows the working directory is tracked by path rather than by handle, so the chdir binding does not provide descriptor-level protection there; the per-segment lstat and identity checks still apply, and directory fsync is expected to report unsupported. Fallback and crash-recovery behavior beyond the fault-injection tests has not been exercised.

Rationale:

- Pre-checking a path and then operating on it by name leaves a window a concurrent ancestor swap can exploit; binding the directory and operating by relative name closes that window on POSIX with approved Node built-ins and no native dependency.
- Separating target creation from staging cleanup, and recording publication before any fallible step, makes the journal a truthful record at every instant.
- A non-atomic copy would let another process observe a half-written generated file; failing closed keeps the "exact bytes or nothing" promise.
- Directory fsync is what makes a renamed journal entry durable on filesystems such as ext4; without it the recovery record can vanish after a power loss.

### A-018: Third review round: exclusive-write contract, removal durability, binding coordination, Windows fail-closed

Status: Proposed  
Date: 2026-08-30

An independent review of commit 14c8c4c0890196741a86e7ad045c04bb5ef0e81a confirmed four remaining findings in the A-017 implementation: an exclusive write that failed after creating its entry left an untracked name, containment relied on POSIX working-directory semantics that Windows does not provide, removals were recorded before their directory entries were synced (and sync errors were swallowed), and the process-wide working directory was coordinated per filesystem instance. The corrections below were implemented on review/mvp-vertical-slice and are recorded for owner review; A-017 stands as history. Scope is unchanged.

Decision:

- Exclusive-write contract. `BoundDirectory.writeFileExclusive` distinguishes "nothing created" (`FileSystemError`, including EEXIST for an entry that belongs to someone else) from "created but incomplete" (`ExclusiveWriteError`, a new core error carrying the entry name). The transaction announces a staging name in the journal (`staging` status, a new journal operation state) before the exclusive write; a lock or journal temporary that was created but not completed is removed, proven absent, and synced, or else reported by exact path (a minimal recovery journal is written when the lock cannot be removed before a journal exists). Rollback removes a partial staging file only when its bytes are a prefix of the planned bytes, and never removes an EEXIST entry. `aborted` and `rolled-back` are never returned while an entry created by the failed operation may remain. A journal temporary is removed by bookkeeping cleanup only when this transaction recorded it as retained.
- Removal durability ordering. Every transaction-critical removal proceeds as remove, verify absent, sync the containing directory, then persist the journal state that forgets the name or marks it reverted. Sync I/O errors are never swallowed: in rollback they produce `rollback-incomplete` naming the exact path as "not proven durable" (current absence is not accepted as proof); after an otherwise valid installation they produce `TRANSACTION_BOOKKEEPING_DURABILITY_UNPROVEN` and a `best-effort` result. Unsupported syncs downgrade to `best-effort` with `TRANSACTION_DURABILITY_BEST_EFFORT`, and `persistJournal` rewrites the journal once more when its serialized `durability` would otherwise not match. The applied result now carries `durability`.
- Binding coordination. All Node filesystem instances share one module-global scheduler for `process.chdir`; an `AsyncLocalStorage` binding scope rejects a nested `withinDirectory` call synchronously with `CONTAINMENT_REENTRANT` before queuing; a `BoundDirectory` is callback-scoped (`BOUND_DIRECTORY_CLOSED` afterwards) and re-verifies the working-directory identity before each operation (`CONTAINMENT_LOST`); the binding walk is asynchronous so a segment that disappears or is replaced between inspection and entry produces a controlled `PATH_ANCESTOR_CHANGED`; raw chdir errors are never exposed; the previous working directory is always restored.
- Platform support for this MVP. `FileSystemPort.containment` reports the capability explicitly. macOS and Linux use the POSIX binding (verified on macOS only). On Windows and in worker threads wrkrs fails closed before repository content is located or read: `init` (including `--dry-run`) returns `ENVIRONMENT_CONTAINMENT_UNSUPPORTED`, `check` reports it after environment and Git worktree detection, `applyPlan` aborts with it, and `--help`/`--version` still work. No pathname-precheck fallback exists. Full Windows contained I/O is deferred to the cross-platform increment; Windows is not claimed as supported or verified.
- New stable codes: `ENVIRONMENT_CONTAINMENT_UNSUPPORTED`, `PRECONDITION_STAGING_NAME_TAKEN`, `TRANSACTION_BOOKKEEPING_DURABILITY_UNPROVEN`; new containment error codes `CONTAINMENT_UNSUPPORTED`, `CONTAINMENT_REENTRANT`, `CONTAINMENT_LOST`, `BOUND_DIRECTORY_CLOSED`; reader failure code `CONTAINMENT_UNAVAILABLE`. Journal schema change: operation status `staging` (transient bookkeeping; no migration).
- Verification status. Verified on macOS with Node 22.23.2 and 24.18.1 only. Linux is expected to behave identically but is unverified; Windows is unsupported by design for this MVP. Crash recovery beyond the fault-injection tests has not been exercised.

Rationale:

- An O_EXCL create that later fails still owns a name; only a journal that knew the name in advance can reconcile it, and only a prefix comparison can prove a partial file is wrkrs's own.
- A deletion is not durable until its directory entry is synced; recording "reverted" earlier would let a power loss resurrect the file behind a journal that claims otherwise.
- The working directory is a process-wide resource, so its coordination must be process-wide, and a nested request must be refused rather than queued behind the caller that would never release it.
- Failing closed on Windows is the only honest option without native `openat`-style primitives; the reviewer required stopping or failing closed rather than shipping an unverified invariant.

### A-019: Fourth review round: conservative partial-staging retention and bookkeeping honesty

Status: Proposed  
Date: 2026-08-30

An independent review of commit 61df451e41d6884082983af1376c5a030a300f7b confirmed five remaining findings in the A-018 implementation. The corrections below were implemented on review/mvp-vertical-slice and are recorded for owner review; A-018 stands as history (its prefix-based ownership claim is superseded here). Scope is unchanged.

Decision:

- No content-based ownership proof. Rollback no longer deletes an incomplete staging entry whose bytes are a prefix of the planned bytes: a prefix — including an empty file — does not prove the current directory entry is still the one wrkrs created, and Node offers no identity-conditional unlink. The conservative MVP behavior is to retain the entry, return rollback-incomplete, and report its exact repository-relative path; an externally replaced or edited entry is preserved byte-for-byte and mode-for-mode. Fully written files keep the exact-hash removal policy. Consequence: a partial staging write now ends in rollback-incomplete rather than rolled-back, and the affected tests were updated to expect the stricter result.
- Lock creation tracked separately from its directory sync. A FileSystemError is treated as "nothing created" only when the exclusive create itself failed before creation; a directory-sync failure after a successful create reconciles the lock through the created-entry cleanup path (remove, verify, sync, or report `.wrkrs/.lock` exactly with recovery bookkeeping). A genuinely pre-existing EEXIST lock is preserved unchanged. `aborted` is never returned while a lock created by this transaction remains.
- Durable final lock release. The rollback-incomplete exit releases the lock through the same removal contract as everything else — unlink, verify absence, sync, then forget — before the final journal write, so the persisted durability and the retained list match the filesystem. Unlink, containment, inspection, and sync failures are reported (`.wrkrs/.lock` exactly; "not proven durable" when only the sync failed), and the live rollback-incomplete journal remains the recovery record.
- The installed .wrkrs directory is not bookkeeping. A successful commit removes only the lock, the journal temporary, and the live journal; `.wrkrs` and its repository-owned contents (config, schema, roles, manifest) stay, no `TRANSACTION_BOOKKEEPING_RETAINED` warning is emitted for them, and output never tells users to remove the installation directory. A transaction-created `.wrkrs` is removed only on abort or rollback.
- Journal-temp retention reflects proven state. A temporary retained by an earlier failed cleanup is retried during bookkeeping release and removed from the retention map only after unlink, absence verification, and a successful directory sync; a transient fail-once error therefore no longer produces rollback-incomplete naming a nonexistent temp, a permanent failure still names the existing one exactly, and retained lists carry no duplicates.

Rationale:

- Content equality can be forged by any process; only the exact-hash policy on fully written, fsynced files plus O_EXCL creation semantics gives a defensible deletion proof, and where no proof exists the honest answer is retention.
- A warning that tells the user to delete the freshly installed configuration directory is worse than no warning; bookkeeping and installed content must never share a cleanup path.
- Retained-path reports are only useful if they describe the filesystem as it is, which requires clearing state after proven cleanup and applying the durable removal contract on every exit.

### A-020: Fifth review round: one bookkeeping removal ledger with reconciled durability

Status: Proposed  
Date: 2026-08-30

An independent review of commit 0b8b9140328e7678ee85ce5b4c9d50de0e17c10a confirmed two remaining findings in the A-019 implementation. The corrections below were implemented on review/mvp-vertical-slice and are recorded for owner review; A-019 stands as history, and every behavior it introduced (in particular the conservative partial-staging policy) is preserved. Scope is unchanged.

Decision:

- One authoritative ledger for bookkeeping removals. Every bookkeeping name inside `.wrkrs` — the lock, the live journal, and journal temporaries — is tracked in a single in-memory ledger used by every cleanup path, replacing the per-path ad hoc handling. A name is unknown (never created, or its removal proven), pending (unlinked and verified absent, awaiting the directory sync that proves it), or retained (could not be removed, still present, or could not be inspected). The removal order is unchanged: unlink, verify absence, record the exact path as pending, sync the containing directory, and only then clear it.
- Exact-path attribution for sync failures. A real `.wrkrs` directory-sync error no longer collapses onto `.wrkrs`. Each pending path is reported by name — `.wrkrs/.lock`, `.wrkrs/.journal.json`, `.wrkrs/.journal.json.<id>.tmp` — with the durability-unproven reason; `.wrkrs` itself is named only when the directory could not be bound, inspected, or removed. A name whose unlink succeeded never keeps an outdated "could not be removed" reason, and retained paths are unique. A sync that reports `unsupported` keeps the existing best-effort policy and is never confused with an I/O error.
- Durability reconciliation. Every completed `.wrkrs` directory sync, including the one `persistJournal` performs on the final rollback-incomplete write, proves the pending removals in that directory and clears them, so a transient sync failure no longer leaves a stale `.wrkrs/.lock` entry. Unlink failures, inspection failures, and names that still exist are never cleared by a later sync, and `.wrkrs` (whose durability depends on its parent) is likewise never cleared by a `.wrkrs` sync. When any removal is still unproven as the final journal is written, that journal records `best-effort` durability, so the serialized durability and the returned retained paths cannot contradict each other. The live journal remains the recovery record whenever rollback stays incomplete.

Rationale:

- A retained path is only actionable if it names the file the user must look at; `.wrkrs` as a stand-in both hid which removal was unproven and implied the whole directory was at fault.
- Durability is a property of the directory entry, not of the moment it was first attempted: a later fsync of the same directory flushes the earlier deletion, so refusing to reconcile reported a failure that provably no longer existed.
- Keeping the pending set and the persisted journal on one clock — conservative when unproven, cleared when proven — is what makes the two records consistent without either over-claiming or inventing a second cleanup path.

### A-021: Lifecycle safety through owned replacement and removal

Status: Approved by the owner on 2026-08-31; implemented  
Date: 2026-08-31

The second increment implements the update and uninstall semantics that A-011 fixed before init wrote its first manifest. The behavior contract in architecture.md is unchanged; this record captures the five choices that implementing it forces.

Decision:

- Update derives desired state from the packaged wrkrs version and the repository's own `.wrkrs/config.yaml`, never from a rescanned roster. Detection still runs read-only during update, but only to supply the machine-readable evidence for specializations config already declares. A declared specialization with no current evidence is rendered without evidence and reported, never dropped.
- Update preserves a drifted managed file per file and continues with the rest of the plan, rather than blocking the whole run. The drift is reported at the moment it is detected and again by `wrkrs check`.
- The manifest advances to schema version 2 with a required `state` field of `installed` or `partial-uninstall`, migrated from version 1 by setting `installed`. `wrkrs check` reads version 1 and reports it as migratable without migrating it.
- The journal widens its `command` and `kind` enumerations in place without a version bump, because every version 1 journal remains valid under the wider enumerations.
- The transactional writer gains `replace-file`, `remove-file`, and `remove-directory` beside exclusive create. Each backs up prior bytes and mode inside `.wrkrs` before mutating and restores them on rollback. Replacement and removal may only target a path the manifest already owns whose current hash matched at precondition recheck.

Rationale:

- Config is the seeded, user-editable input the product promises; an update that cannot apply an edit to it leaves the roster unchangeable without a reinstall. Letting detection change the roster during update would silently rewrite a decision the owner made at init.
- Blocking a whole update on one customized file punishes exactly the repositories that adopted the framework most, and it conceals that every other file is reconcilable. The accepted cost is that an update can leave a stale projection beside a changed role file; that state is reported twice and is never silent.
- Partial-uninstall state must be recorded, not inferred: without it, `check` would call a half-removed installation healthy and a later update would reinstall what the user asked to remove. An optional field inside version 1 would require reading absence as `installed`, which is the guessing the version discipline exists to prevent. Building the first real migration now, while nothing is published, is cheaper than after.
- Keeping exclusive create no-replace preserves the invariant five review rounds hardened. Replacement is safe for a different reason than creation is: not because the path is unoccupied, but because the manifest proves wrkrs wrote the exact bytes that are still there.

Deliberately not decided here: `--force` uninstall and field-specific merges for drifted managed files. Both need a recoverable-backup or merge mechanism that no current behavior requires, and D-003 already holds the merge question.

Implementation added one decision the design did not anticipate: an update adopts an edit to a seeded file that round-trips through the generator, recording the current hash as last applied. Editing `.wrkrs/config.yaml` is the intended workflow for a seeded file; without adoption that edit would be reported as a customization forever and every later uninstall would end partial. An edit that does not round-trip is still preserved and reported, unchanged.

### A-022: Providers are capability bindings to connections the environment already owns

Status: Direction approved by the owner on 2026-09-01; resolves D-001  
Date: 2026-09-01

Supersession: A-024 supersedes only the internal naming and contract-shape detail below that retained `ProviderAdapter`. The canonical Increment 3 contract is `ProviderDefinition` in architecture.md. Every other decision in this record stands. The original text below is preserved as history.

A provider in wrkrs binds a capability a worker needs to a connection this environment already has. It is not an installer, an authenticator, or a package manager.

Decision:

- A provider never installs an MCP server, authenticates a provider account, requests or stores a token, writes a literal credential, manages a provider package, or modifies `.mcp.json`. It declares which capabilities it can supply, validates a binding the owner wrote, and contributes instruction text to wrkrs-owned files.
- `.mcp.json` stays strictly read-only. The analyzer already inspects it for project-scoped server names and transport types and never for content; that is the only access Increment 3 has. The rule in architecture.md permitting a future provider to add its own namespaced server entry is preserved as a possible later opt-in, and is explicitly not part of Increment 3.
- Because no shared strict-JSON edit is implemented, `jsonc-parser` is not added. The owner's approval to adopt it stands and applies to the first real shared strict-JSON edit, whenever that increment is proposed.
- The `patched` ownership mode is not implemented to exercise the abstraction. It stays declared in the manifest contract and unused until a change actually owns selectors inside a shared file.
- User-facing language is "connection" and "capability binding". The internal `ProviderAdapter` naming is retained; renaming it would churn the contract without changing behavior.
- Authentication stays external. An MCP server or an approved CLI owns its own credentials. wrkrs never asks for a secret, never adds a credential field to committed configuration, never prints raw provider or CLI output, never contacts a provider during planning or a dry run, and never claims a connection is authenticated when it cannot prove it.
- A binding records how much wrkrs can actually verify: a project-scoped server proven present in `.mcp.json`, a server name the owner supplied for a user-, local-, or cloud-scoped connection that repository files cannot confirm, a named connection that is missing, or a manual fallback with no tool access at all. The same repository configuration stays usable locally and in Claude Code cloud sessions, and reports honestly that environment-owned connections may differ between them.

Rationale:

- The product promise is a team installed into a repository, not a broker holding credentials. Every capability that would require wrkrs to hold or route a secret is a capability the environment already provides better.
- Reading `.mcp.json` and never writing it keeps the strongest guarantee the first two increments earned — wrkrs touches only what it owns — intact through the increment that would most easily erode it.
- Verification states must be distinguishable because the honest answer is frequently "the owner says this exists and repository files cannot confirm it". Collapsing that into either "configured" or "broken" would make wrkrs either overclaim or refuse legitimate cloud and user-scoped setups.

D-001 is resolved by this record; its original text is preserved below as history. A-024 later supersedes only the internal `ProviderAdapter` naming/contract detail above; nothing else in this record is superseded.

### A-023: Adaptive execution policy

Status: Direction approved by the owner on 2026-09-01  
Date: 2026-09-01

The four default roles stay installed and available, but not every role runs for every task. The Product Manager performs a bounded triage and selects the smallest workflow that safely satisfies the request.

Decision:

- Triage evaluates three criteria independently: work size (affected code, systems, coordination), risk (consequence if wrong, and difficulty of rollback), and ambiguity (unresolved product or technical decisions). Issue severity and ticket priority are never used as a proxy for complexity.
- The routing decision is expressed as an execution profile with independent controls rather than one opaque complexity score: planning (`minimal` | `standard` | `detailed`), design (`none` | `reuse-existing` | `new`), engineering (`single` | `parallel`), verification (`targeted` | `affected-suite` | `comprehensive`), and reasoning (`fast` | `balanced` | `deep`).
- Three named profiles are defined — Fast, Standard, and Full — each with explicit selection rules. A set of high-risk triggers mandates escalation and can never be routed through an unrestricted fast path.
- Design is a workflow category, not automatically the Product Designer's work. User flows, interaction, visual design, and prototypes go to the Product Designer; architecture, APIs, schemas, and data models go to a Software Engineer instance with the relevant specialization. A task may need both, or neither. No permanent architect, frontend, backend, or data-science role is added.
- The owner may request a faster or more thorough workflow. The Product Manager may always escalate rigor when it discovers risk, and never de-escalate below a floor the owner set. A request for speed removes unnecessary stages; it never bypasses the governance gates covering planning approval, security and permissions, secrets, billing, production dependencies, data migrations, external integrations, merges, deployments, publications, and releases.
- Every profile keeps a quality floor: clear success criteria, no unrelated scope expansion, verification evidence proportional to risk, a final diff review, explicit assumptions and blockers, and no automatic merge, deployment, publication, or release. Role content explicitly prohibits adjacent refactoring, speculative improvement, unnecessary research, and documentation the task did not ask for.
- The routing decision is prompt-guided behavior compiled into role and projection content. The CLI can enforce that the content is present, well formed, and consistent with configuration; it cannot enforce what a worker decides at run time. Documentation and tests must not claim otherwise.

Rationale:

- Running every role for every task spends the owner's time on coordination that the task did not need, which is the failure the policy exists to correct.
- Independent controls stay legible and adjustable. A single score would hide the case the owner named: a small change that still needs comprehensive verification, and a large mechanical change that needs none of the product design.
- Separating enforceable from prompt-guided behavior is the only honest way to ship routing through a language model. Claiming deterministic enforcement would be false, and shipping it silently would make the tests meaningless.

### A-024: Independent review remediation of the Increment 3 plan

Status: Approved by the owner on 2026-09-01  
Date: 2026-09-02

An independent review of the Increment 3 planning documents found areas where the plan was internally inconsistent, unenforceable as written, or misaligned with the product direction. A later pass on the same archive found remaining issues, which this record also corrects. A-022 and A-023 stand as approved. This record supersedes only the internal naming and contract-shape detail in A-022 that retained `ProviderAdapter`; A-022's original text is preserved as history. Every other A-022 and A-023 decision stands.

Decision:

- **One canonical binding contract.** `ProviderDefinition` is the single canonical contract, defined in architecture.md and referenced from mvp.md rather than restated. A-024 supersedes only the internal naming/contract detail in A-022 that retained `ProviderAdapter`. The earlier `ProviderAdapter` shape returned `DesiredComponent[]` from `planConfiguration`. Providers no longer produce files, so that method is removed rather than left unimplemented. Providers may return probes, diagnostics, validation results, and sanitized guidance. They never return a `DesiredComponent`, never access the writer, and never reach the transaction. The runtime adapter compiles provider guidance into files wrkrs already owns.
- **The binding value is a strict discriminated union on `kind`.** `mcp-server` requires `server` and `scope`; `cli` requires a bare `executable` name that wrkrs looks up on PATH and never executes; `manual` requires neither. Unknown keys are rejected and no field holds, references, or names a credential. Which provider may supply which capability through which kind is an explicit matrix, so `github`, `linear`, `figma`, `mcp`, and `manual` are each implementable as written.
- **Generic MCP and manual support only Increment 3 read capabilities.** They do not implicitly support every vocabulary entry. The reserved mutation identifiers `pull-request-comment`, `work-item-update`, and `design-update` remain in the vocabulary but are not bindable, projectable, offered during setup, or declared by a registered provider. A `connections` key that is a reserved mutation capability is rejected with `CONNECTION_CAPABILITY_RESERVED`. Generic MCP follows the capability-keyed shape: one map entry satisfies exactly one capability, so a binding never carries a capability list. The earlier acceptance test requiring an explicit non-empty capability list described a shape the configuration cannot express and is corrected to assert the opposite: a capability list inside a binding is a schema violation.
- **Verification gains an environment-scoped state.** A CLI found on PATH now is `verified-environment`, which is honest about being true on this machine and unknown in a Claude Code cloud session, and is never recorded as a portable repository fact. `unavailable` becomes `absent`, a fact rather than a judgment, with severity assigned per kind and scope: a missing project-scoped server is an error because configuration asserted a repository fact that is false, while a missing CLI is a warning because the environment legitimately differs.
- **Repository-derived identifiers are untrusted input.** MCP server names are read from a file wrkrs did not write, in a repository that may be hostile, and are compiled into Markdown an agent reads and a terminal a person reads. Every such identifier is validated against a bounded character class and length before use, and the policy is reject-then-render: a value that cannot be proven safe never reaches a generated file, and is reported as a finding with the value replaced by a bounded escaped rendering. Control characters, escape sequences, newlines, Markdown structural characters, and YAML-breaking input are rejected, not escaped after the fact. The same rendering rule applies to a non-empty legacy `providers` map: migration still blocks and every key is accounted for, but diagnostics never print hostile keys raw.
- **The credential claim becomes enforceable.** "Configuration contains no credential value" cannot be tested, because wrkrs cannot recognize an arbitrary secret a person pasted into a note. The testable claim replaces it: the schema defines no credential-bearing field, and wrkrs never requests, generates, or knowingly emits a credential.
- **Machine-driven setup is a non-blocking protocol, not a GUI.** Two distinct digests are required. `questionSetDigest` identifies the canonical discovered questions and choices; the plan digest identifies the exact semantic installation plan generated from accepted answers. Discovery is `wrkrs init --json --questions`, which emits the question set and `questionSetDigest`, prompts zero times, and writes nothing. The answers document contains `schemaVersion`, `questionSetDigest`, and strict answers keyed by stable capability-derived question IDs. Preview is `wrkrs init --json --dry-run --answers <file>`, which recomputes and validates the question set, rejects a stale `questionSetDigest`, produces the semantic plan and plan digest, and writes nothing. Apply is `wrkrs init --json --yes --answers <file> --expect-digest <plan-digest>`, which recomputes the questions and plan and applies only when both remain valid. Choice IDs are deterministic and unique across provider, binding kind, scope, and server or executable identity. No CLI process ever waits on a human, no GUI and no runtime adapter is built, and `--yes` without answers stays deterministic and binds nothing.
- **`--answers` uses a dedicated input-document port.** The answers file is an invocation input, not repository content, so it must not bypass or reuse the hardened repository filesystem port. Absolute paths and paths relative to the invocation working directory are allowed, including files outside the repository. The port opens read-only, requires a regular file, does not follow a final symlink, verifies identity with the opened handle, enforces a 64 KiB limit, requires valid UTF-8 and strict JSON, rejects duplicate keys, never writes the file, and emits only controlled sanitized diagnostics — never raw answer contents or parser source excerpts.
- **Configuration migrations must preserve what the owner wrote.** A migration that re-serializes `.wrkrs/config.yaml` would destroy comments and key order. Migrations apply a minimal edit through the yaml Document API, as A-004 required and A-021 first exercised for the ownership manifest. The earlier draft cited A-020 for this discipline, which is the bookkeeping ledger and unrelated; the correct references are A-004 and A-021.
- **The north-star is realigned.** A wrkrs task has a stable identity whether or not an external ticket exists; an external ticket is an optional linked representation. A conversation is a temporary interface, and durable task context eventually records requirements, approved plan versions, decisions, design references, agent assignments, branches, status, and verification evidence. A working worker stays pinned to the plan version approved when it started, and continued discussion produces a draft revision. Storage and synchronization are unresolved and recorded as deferred decisions, not approved implementation choices.
- **Workflow-cost reporting ships bounded and testable, or not at all.** The self-reported stage log ships in Increment 3A with a fixed output block. Canonical stages are triage, planning, product design, technical design, engineering, verification, QA, and reporting. Each appears exactly once as `run` or `skipped`; skipped stages require a short reason. `retries` is a separate numeric metric, not a workflow stage. The block is labeled model-reported. The elapsed-time line is `Elapsed time: not measured by wrkrs`. No timing is invented and no cause is claimed for the previously reported thirty-seven-minute run.
- **Acceptance-test numbering is contiguous.** Increment 3 tests occupy 74–143 with no duplicates, gaps, or stale prose describing an older numbering: 74–105 existing Increment 3 tests, 106–109 stage log, 110–119 configuration migration, 120–127 untrusted identifiers, 128–139 machine protocol and safe answers input, 140–143 packaging and regression.

Rationale:

- A contract stated twice in two shapes is a contract the implementation will pick between arbitrarily. One canonical definition with references to it is the only version that survives contact with code.
- A capability list inside a capability-keyed map is a contradiction that would have been discovered during implementation, when the schema and the acceptance test disagreed. Treating generic MCP or manual as supporting every vocabulary entry would have made reserved mutation capabilities bindable, which Increment 3 forbids.
- The verification vocabulary existed to be honest about what wrkrs can prove. Without an environment-scoped state it would have had to either call a CLI on PATH a repository fact, which is false in cloud, or call it unverified, which is false locally.
- Treating an MCP server name as trusted would let a hostile repository write instructions into the file an agent reads. That is the one place in this increment where untrusted data crosses into a privileged context, and it is worth the bounded validation. The same rendering rule is required for hostile legacy `providers` keys, or a hand-edited config could inject control characters into diagnostics.
- One digest cannot identify both the question set and the installation plan. A caller that approved answers against yesterday's questions, or a plan against yesterday's answers, must be rejected independently. `questionSetDigest` is compared across discovery and later validation; the plan digest is compared only between preview and apply.
- Reading `--answers` through the repository filesystem port would refuse GUI temporary files outside the worktree. A dedicated read-only input-document port keeps that path from weakening repository containment.
- Keeping a CLI process alive while a person answers questions in a GUI would make the CLI a session server. The discovery, answer, digest sequence gets the same result with no waiting process and a provable link between what was approved and what is applied.

Scope is unchanged: Increment 3 stays split into 3A and 3B, and this record adds no durable task state, no runtime adapter, no MCP installation, no provider authentication, no remote mutation, and no hosted control plane. The owner approved this record on 2026-09-01. Increments 3A and 3B are implemented.

### A-025: Waiting skill, dedicated MCP name matching, installed-team contract

Status: Implemented on 2026-09-02  
Date: 2026-09-02

Three post-MVP defects in the installed Claude Code team.

Decision:

- **`/wrkrs` waits.** The project skill is an explicit entry point that must not return until the Product Manager finishes. The generated skill frontmatter includes `background: false` next to `context: fork` and `agent: wrkrs-product-manager`. `wrkrs check` rejects any other `background` value with `CLAUDE_SKILL_FRONTMATTER_INVALID`.
- **Dedicated providers do not bind arbitrary MCP servers.** GitHub, Linear, and Figma may bind an MCP server only when the server name, split on non-alphanumeric characters, contains a matching token (`github`/`gh`, `linear`, `figma`). Setup does not offer a dedicated-provider choice for an unmatched name. A hand-edited mismatch is `CONNECTION_SERVER_PROVIDER_MISMATCH` (error), does not resolve, and does not emit `CONNECTION_OK`. The generic `mcp` provider remains the escape hatch for every permitted server name, including names that also match a dedicated provider. Diagnostics never echo the untrusted server name.
- **Installed-team smoke is an artifact contract, not a live Claude session.** After `init --yes`, tests and the packed-tarball smoke assert the skill wait fields, the four namespaced agent files with matching `name` frontmatter, and a passing `wrkrs check`. If a `claude` executable is on PATH, only `claude --version` may run. Absence of Claude Code never fails CI. wrkrs never starts an authenticated or paid Claude session as a test.

Rationale:

- A background skill returns control before the team has done any work, which makes `/wrkrs` look installed and idle at the same time.
- Offering every `.mcp.json` server as GitHub, Linear, and Figma treated a tracker named `fake-tracker` as those products. Name-token matching is the strongest check available without contacting a network or reading server config that may contain secrets. Generic `mcp` keeps unsupported tools reachable.
- A live Claude Code invocation needs credentials, network, and a paid session this repository's CI must not assume. The files Claude would read are the contract wrkrs can prove.

## Deferred decisions

### D-001: Exact provider authentication and capability mappings

Status: Resolved on 2026-09-01 by A-022

Original text, preserved as history:

> Resolve when the GitHub, Linear, and Figma increment begins. Secrets must remain outside committed config. Existing compatible MCP or CLI configuration should be reused only after showing the mapping.

Resolution: there is no provider authentication to specify. Providers bind capabilities to connections the environment already owns, secrets never enter committed configuration because wrkrs never handles one, and an existing compatible MCP server or CLI is reused only after the mapping is shown in the plan. See A-022.

### D-002: Multi-package workspace extraction

Status: Deferred

Revisit when an adapter or provider needs independent publication, another application embeds core, or separate versioning is required.

### D-003: Automated three-way merge for customized generated files

Status: Deferred

The safe default is preserve and block. Add three-way merge only if real update workflows show that the benefit exceeds conflict and state complexity.

### D-004: Runtime adapter discovery beyond the built-in registry

Status: Deferred

The MVP uses an explicit built-in registry. A plugin marketplace and arbitrary dynamic package loading are non-goals.

### D-005: Release automation and signing

Status: Deferred

Define npm provenance, signing, release workflow, and changelog policy during release hardening. Increment 4 adds CI, migration fixtures, README/CHANGELOG, and keeps `private: true`. Publication and release always require explicit approval.

### D-006: Hosted control plane

Status: Deferred

Cross-repository oversight, mobile approvals, audit history, cost tracking, organization policy, private registries, and enterprise support remain possible future paid capabilities. None may become a dependency of the open-source local core.

### D-007: Durable task context storage

Status: Deferred

A wrkrs task has a stable identity independent of any external ticket, and durable task context eventually records requirements, approved plan versions, decisions, design references, agent assignments, branches, status, and verification evidence. Where that lives is unresolved: committed repository files, a local cache outside the repository, or the linked task platform each trade portability, reviewability, and merge behavior differently. Nothing is approved. Resolve when durable task context is proposed as its own increment; a hosted database and a second project-management system remain excluded.

### D-008: Task synchronization and live orchestration

Status: Deferred

How durable task context synchronizes with an optional external ticket, how workers are dispatched and observed while running, and how an interrupted run resumes are all unresolved. Plan-version pinning is the proposed semantic in A-024; the mechanism that enforces it is not designed. Automatic ticket creation, ticket mutation, and status transitions stay excluded until this is resolved.

### D-009: Additional runtime adapters

Status: Deferred

Cursor, Codex, and other runtimes remain possible through the existing runtime adapter contract. None is scheduled, and Increment 3 adds no adapter. Resolve when a second runtime is proposed with its own increment.

## Approval record

Architecture approval: Approved by the owner on 2026-08-29  
Vertical slice approval: Approved by the owner on 2026-08-29  
Production dependency approval: Approved by the owner on 2026-08-29 (commander, zod, yaml)  
Implementation repository selection: Approved by the owner on 2026-08-29 (github.com/SmartScaleAI/wrkrs, public, MIT)  
Increment 3 plan approval: Approved by the owner on 2026-09-01 (A-022, A-023, A-024); Increments 3A and 3B implemented  
Increment 4: release hardening in progress (CI, migration fixtures, documentation); npm publication not approved

Implementation status: the first vertical slice was implemented on 2026-08-29, committed as a8e4a5ba567dc06a96868bf941b242a00e30df49 on review/mvp-vertical-slice, and pushed to origin for independent review; the remote's default branch main also points at that commit. The first review remediation (A-016) was committed as baab7195004463c06ff3bc0aa1b8b765eb34df0b on review/mvp-vertical-slice and pushed; the second (A-017) as 14c8c4c0890196741a86e7ad045c04bb5ef0e81a; the third (A-018) as 61df451e41d6884082983af1376c5a030a300f7b; the fourth (A-019) as 0b8b9140328e7678ee85ce5b4c9d50de0e17c10a; the fifth (A-020) follows on the same branch. No pull request, npm publication, deployment, merge, or release has occurred.
