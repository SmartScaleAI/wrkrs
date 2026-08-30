# wrkrs decision log

Last updated: 2026-08-29

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

## Deferred decisions

### D-001: Exact provider authentication and capability mappings

Status: Deferred

Resolve when the GitHub, Linear, and Figma increment begins. Secrets must remain outside committed config. Existing compatible MCP or CLI configuration should be reused only after showing the mapping.

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

Define npm provenance, signing, release workflow, and changelog policy during release hardening. Publication and release always require explicit approval.

### D-006: Hosted control plane

Status: Deferred

Cross-repository oversight, mobile approvals, audit history, cost tracking, organization policy, private registries, and enterprise support remain possible future paid capabilities. None may become a dependency of the open-source local core.

## Approval record

Architecture approval: Approved by the owner on 2026-08-29  
Vertical slice approval: Approved by the owner on 2026-08-29  
Production dependency approval: Approved by the owner on 2026-08-29 (commander, zod, yaml)  
Implementation repository selection: Approved by the owner on 2026-08-29 (github.com/SmartScaleAI/wrkrs, public, MIT)

Implementation status: the first vertical slice was implemented on 2026-08-29, committed as a8e4a5ba567dc06a96868bf941b242a00e30df49 on review/mvp-vertical-slice, and pushed to origin for independent review; the remote's default branch main also points at that commit. The first review remediation (A-016) was committed as baab7195004463c06ff3bc0aa1b8b765eb34df0b on review/mvp-vertical-slice and pushed. The second review round (A-017) follows it on the same branch. No pull request, npm publication, deployment, merge, or release has occurred.
