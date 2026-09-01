# wrkrs CLI architecture

Status: Approved by the owner on 2026-08-29; first vertical slice implemented; second increment proposed in mvp.md and decisions.md A-021  
Architecture review date: 2026-08-29

## Context

wrkrs is an open-source, CLI-first framework that installs a configurable AI development team into an existing Git repository. A worker is a configured AI agent. Roles define responsibility, specializations define expertise, and worker instances perform the work.

At the start of this architecture phase, the attached workspace contained no Git checkout, application code, or project Markdown files. No matching wrkrs repository or project documents were available through the connected project storage or GitHub account. This proposal is therefore a greenfield architecture derived from the project custom instructions, which remain the source of truth. No existing implementation constraints were found.

## Locked product and safety decisions

The architecture must preserve these already-locked decisions:

- The public command begins with npx wrkrs init.
- Installation targets existing Git repositories. wrkrs does not scaffold application code.
- Claude Code is the first fully supported runtime.
- The same repository configuration must work in local and Claude Code cloud sessions.
- The portable core must permit future Cursor, Codex, and other runtime adapters.
- Claude subagents are the stable default. Experimental Agent Teams cannot be required.
- The default Product Engineering preset contains Product Manager, Product Designer, Software Engineer, and QA Engineer.
- Product Manager is the primary worker. One reusable Software Engineer role may produce multiple worker instances with task-specific specializations.
- GitHub, Linear, and Figma are the first dedicated provider integrations in the complete MVP. Unsupported tools use a generic MCP or manual fallback.
- Repository analysis is read-only until the owner confirms the complete plan.
- Existing Claude files, MCP configuration, hooks, skills, agents, and permissions are preserved by default.
- Ambiguous conflicts block installation. wrkrs never weakens permissions.
- The CLI records exactly what it owns so update and uninstall affect only framework-owned material.
- Secrets remain outside committed wrkrs configuration.
- wrkrs never commits, pushes, merges, deploys, publishes, or releases automatically.
- There is no hosted dashboard, account system, marketplace, proprietary runtime, or broad integration catalog in the MVP.

## Architecture goals

1. Make init transparent: the exact proposed bytes and every preserved or blocked path are known before confirmation.
2. Make writes conservative: no generic deep merge, no silent overwrite, no path traversal, and no write outside the selected Git worktree.
3. Keep the first implementation small enough for one developer to understand end to end.
4. Separate portable domain behavior from runtime-specific and provider-specific behavior.
5. Make plans deterministic and testable without a terminal or real provider account.
6. Make interrupted or failed writes recoverable.
7. Keep repository configuration human-editable and versioned.

## Technical decision summary

| Area | Proposed choice | Why |
| --- | --- | --- |
| Language | TypeScript, compiled to ESM | Direct fit for npx, fast solo iteration, strong ecosystem, and typed adapter contracts |
| Runtime | Node.js 22.12 or newer; CI on Node 22 and 24 | Node 20 is end-of-life; this keeps a reasonable compatibility floor while supporting current LTS releases |
| CLI framework | Commander 15 | Mature, focused, small, and sufficient for init, check, update, and uninstall |
| Prompts | A small PromptPort backed by node:readline/promises | Only confirmation and simple choices are needed initially; avoids a UI dependency |
| Package shape | One published npm package with strict internal modules | Avoids premature multi-package publishing while retaining extractable boundaries |
| Contributor package manager | npm with a committed package-lock.json | Matches npx distribution and is sufficient for one package |
| Build | TypeScript compiler with NodeNext module semantics | No bundler is required for the first package |
| Config | YAML for user-owned configuration; JSON for machine-owned state | YAML is readable and comment-friendly; JSON is deterministic for the ownership manifest |
| Validation | Zod 4 as the TypeScript source of truth, with emitted JSON Schema | One typed runtime schema plus a portable editor/tooling schema |
| Repository root | git rev-parse --show-toplevel | Correct for normal repositories and worktrees; the product already requires Git |
| Runtime packaging | Namespaced project agents and a project skill under .claude | Repository-owned, inspectable, commit-friendly, and available locally and in cloud sessions |
| Merge model | Field-specific structural edits compiled into exact bytes | Preserves unrelated content and blocks ambiguous cases |
| State | .wrkrs/manifest.json with per-entry hashes and management modes | Enables drift detection, conservative updates, and safe uninstall |
| Transactions | Precondition recheck, staged writes, journal, reverse rollback | Gives recoverability across a multi-file installation |
| Tests | Vitest unit, integration, fixture, snapshot, and fault-injection tests | Good TypeScript ergonomics and deterministic CLI/plan testing |

## Options considered

### Implementation language and runtime

| Option | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| TypeScript on Node.js | Native npm and npx distribution, strong CLI/config ecosystem, shared types across modules, easy contributor onboarding | Runtime dependency, dependency supply-chain surface, slower than a native binary for very large scans | Recommended |
| Rust | Strong correctness tools, fast scanning, single native binary | Native release matrix, npm wrapper or downloaded binary, more implementation overhead for a solo MVP | Defer unless performance or binary distribution becomes a measured problem |
| Go | Simple cross-platform binaries and good filesystem support | Same npx wrapper problem, weaker fit for npm-first extensibility and schema tooling | Defer |
| Python | Fast prototyping and mature file libraries | Poor fit for npx, Python environment variability, additional installer story | Reject for the first implementation |

Node.js 24 is the preferred development runtime. The package engine floor is Node.js 22.12 because Commander 15 requires that floor and Node 22 remains an LTS line at the review date. CI should test both Node 22 and Node 24. The package is ESM-only and compiles TypeScript before publication; users do not execute TypeScript source.

### CLI framework

| Option | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| Commander | Long-lived project, clear command model, generated help, small conceptual surface | Interactive UI and application architecture remain our responsibility | Recommended |
| Citty | Lightweight, TypeScript-friendly, nested commands | Smaller and less mature API surface for a safety-sensitive installer | Not selected |
| Clipanion | Strong typing and advanced parser behavior | More framework concepts than the MVP needs; current major line has had release-candidate churn | Not selected |
| oclif | Batteries included, plugin ecosystem, generated command scaffolding | Large framework and runtime plugin model would duplicate wrkrs adapter/provider contracts | Not selected |
| Raw util.parseArgs | Zero dependency | Help, subcommands, errors, and conventions would become custom code | Not selected |

Commander is only the presentation boundary. Command handlers call application services and contain no repository logic.

### Package and workspace structure

| Option | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| One package with internal modules | One build, one version, one publication, easy refactors | Boundaries rely on linting and review rather than package resolution | Recommended for MVP |
| Workspace with core, CLI, and adapter packages | Enforced package boundaries and independent extraction | Multiple package builds, versioning, linking, and release coordination before they create value | Defer |
| oclif-style command/plugin packages | Runtime extensibility out of the box | Couples product extensibility to the CLI framework and expands supply-chain risk | Reject |

The public npm package is named wrkrs and exposes one bin named wrkrs. Internal modules are designed so they can later move into packages without changing their contracts. Extraction is justified only when an adapter needs independent publication, another application embeds the core, or independent versioning becomes necessary.

### Configuration format and schema validation

| Option | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| YAML plus Zod and emitted JSON Schema | Human-editable, supports comments, typed runtime validation, portable schema artifact | YAML has syntax edge cases and needs a document-aware parser | Recommended |
| Strict JSON plus JSON Schema and Ajv | Excellent tooling and deterministic parsing | No comments and less pleasant for role rosters and governance |
| TOML | Readable for flat configuration | Deep roster, adapter, and provider structures become awkward |
| Executable TypeScript or JavaScript config | Maximum expressiveness | Executes repository code, creates a security boundary, and is harder to migrate | Reject |
| TypeBox plus Ajv | Schema-first and portable | More schema machinery than the first implementation needs |

The canonical user file is .wrkrs/config.yaml. Zod validates parsed values and emits .wrkrs/schema.json from the same schema definition. The root schema is strict so misspelled fields fail validation; explicit extensions and adapter/provider configuration objects are the only open-ended locations.

Every durable format has an integer schemaVersion. Readers first identify the version, validate against that version, and then run explicit one-version-at-a-time migrations. check never silently migrates or rewrites configuration.

The yaml Document API is used when wrkrs must update wrkrs-owned YAML because it can retain comments and ordering. Machine-owned .wrkrs/manifest.json is strict, stable-key JSON with a trailing newline.

### Repository detection

| Option | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| Git CLI for root plus bounded file detectors | Correct worktree behavior, minimal dependencies, aligned with an existing-Git requirement | Requires git executable | Recommended |
| Walk upward looking for .git | No child process | Easy to mishandle gitfiles, worktrees, submodules, and bare repositories |
| Pure JavaScript Git implementation | No git executable | Large dependency and unnecessary implementation surface |
| Provider API inspection | Rich remote metadata | Requires network and credentials and does not describe local uncommitted state |

Repository selection begins with git rev-parse --show-toplevel, executed without a shell. A bare repository or a directory outside a worktree is rejected before any target write.

The analyzer then runs small declarative detectors over bounded paths. Initial signals include:

- package.json and JavaScript package manager lockfiles
- tsconfig.json and common web framework dependencies
- pyproject.toml, requirements files, go.mod, Cargo.toml, Package.swift
- Xcode project and workspace markers
- common monorepo markers
- root and project-scoped Claude Code configuration

The scanner skips .git, node_modules, vendor, build outputs, caches, and binary files. It reads only files required by a registered detector and applies size limits. It never runs repository scripts or imports repository code.

Claude detection includes, without modifying:

- CLAUDE.md and CLAUDE.local.md
- .claude/settings.json and .claude/settings.local.json
- .claude/agents, .claude/skills, .claude/commands, hooks, and rules
- .mcp.json server names and transport types
- an existing .wrkrs directory or ownership manifest

Values that may contain secrets are never printed in findings or JSON output.

### Claude Code adapter packaging

| Option | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| Generate project .claude agents and skills | Repository-owned, inspectable, commit-friendly, local/cloud compatible, no separate installation state | Adapter updates must be planned by wrkrs | Recommended |
| Install a Claude Code plugin | Natural bundle for skills, agents, hooks, and MCP | Plugin installation and marketplace state sit outside the repository and add an extra lifecycle |
| Append instructions to CLAUDE.md | Always visible to Claude | High conflict risk and violates the preserve-first contract |
| Use only an MCP server | Strong tool integration | Does not by itself define worker roles and workflows; adds a running process |

The minimal adapter creates:

- .claude/agents/wrkrs-product-manager.md
- .claude/agents/wrkrs-product-designer.md
- .claude/agents/wrkrs-software-engineer.md
- .claude/agents/wrkrs-qa-engineer.md
- .claude/skills/wrkrs/SKILL.md

The project skill is an explicit entry point. It runs in a fork using the wrkrs-product-manager agent, waits for the result, and passes the requested outcome as arguments. It does not pre-approve tools or alter permissions. The Product Manager definition instructs it to use stable Claude subagents, request plan and design approval at the locked gates, and parallelize only independent work.

The adapter does not modify CLAUDE.md, settings files, hooks, or .mcp.json in the first vertical slice. Existing components are listed as preserved. If a target namespaced path already exists:

- Identical compatible content may be proposed as reused, with ownership remaining external unless the owner explicitly adopts it.
- Different content is a blocker.
- A symlink or uninspectable target is a blocker.

The adapter templates live inside the published npm package. Portable role definitions under .wrkrs/roles are canonical; Claude agent files are generated projections.

### Safe structural merging

Generic recursive object merge is forbidden. Each adapter or provider owns a small set of fields and supplies a field-specific merge strategy.

The planner supports these semantic outcomes:

| Outcome | Meaning |
| --- | --- |
| create | A new file will be created with exact proposed bytes |
| structural-merge | Known fields or one managed block in a shared file will change |
| reuse | A compatible existing component will be referenced but not owned |
| preserve | Existing content is relevant but unchanged |
| no-op | Desired state already matches managed state |
| block | Ambiguity or a safety invariant prevents apply |

Every mutating operation contains:

- repository-relative normalized path
- responsible component and reason
- management mode
- expected current state, including absence or SHA-256 hash
- exact proposed bytes and proposed hash
- display diff
- rollback metadata

Shared JSON is parsed strictly when the target format requires strict JSON. The selected editing library is jsonc-parser because it can compute localized edits while retaining surrounding formatting; comments are still rejected for Claude settings because Claude Code defines those files as strict JSON. Multiple edits to one document are applied sequentially to one in-memory version and then reparsed and validated.

YAML edits use the yaml Document API. Markdown is changed only through an unambiguous namespaced managed block with unique start and end markers. wrkrs does not append an unmarked paragraph to an existing Markdown file.

Permission and security-sensitive merge rules are semantic, not syntactic:

- deny rules are never removed
- allow rules are never broadened without explicit approval
- more restrictive existing policy wins
- unknown permission syntax blocks a required permission change
- the first vertical slice performs no permission merge at all

For .mcp.json, a later provider may add only its own namespaced server entry. An identical existing server can be reused after the mapping is shown. A name collision with different configuration blocks. Secrets are represented by environment-variable references and never literal committed values.

### Installation ownership manifest

.wrkrs/manifest.json is the machine-owned record of the last successful installation. It contains no credentials and no absolute paths.

Conceptual shape:

    {
      "schemaVersion": 1,
      "installationId": "uuid",
      "wrkrsVersion": "0.1.0",
      "installedAt": "RFC-3339 timestamp",
      "updatedAt": "RFC-3339 timestamp",
      "preset": {
        "id": "product-engineering",
        "version": 1
      },
      "runtimeAdapters": [
        {
          "id": "claude-code",
          "version": 1
        }
      ],
      "entries": [
        {
          "path": ".claude/agents/wrkrs-product-manager.md",
          "kind": "file",
          "management": "managed",
          "sourceId": "claude-code/agent/product-manager",
          "sourceVersion": 1,
          "lastAppliedHash": "sha256:..."
        }
      ],
      "createdDirectories": [
        ".wrkrs/roles",
        ".claude/skills/wrkrs"
      ]
    }

Management modes:

| Mode | Meaning | Update | Uninstall |
| --- | --- | --- | --- |
| managed | Deterministic projection generated by wrkrs | Replace only when current hash equals last applied hash | Delete only when current hash still matches |
| seeded | Created by wrkrs but intended for user editing | Preserve drift; use an explicit schema migration or reviewed merge | Retain customized content unless explicitly forced |
| patched | wrkrs owns exact fields or a marked block inside a shared file | Change only owned selectors whose current values match the manifest | Remove only unchanged owned selectors or block |
| referenced | Compatible pre-existing component used by wrkrs | Never modify | Never delete |

The manifest itself is implicitly managed and is not included as a self-hashed entry. Hashes are computed over exact bytes. Drift is computed at runtime rather than trusted from a stored flag.

The manifest is written only as part of a validated transaction. A directory is removable only if wrkrs created it and it is empty at removal time.

Schema version 2, proposed with the second increment in decisions.md A-021, adds one required field, `state`, whose value is `installed` or `partial-uninstall`. A version 1 manifest migrates to version 2 by setting `installed`. check reads version 1 and reports it as migratable without migrating it.

### Update and uninstall behavior

Update and uninstall use the same analyzer, desired-state compiler, planner, diff renderer, and transactional writer as init.

Update rules:

1. Validate the current config and manifest versions.
2. Recompute drift for every owned entry.
3. Build desired state using the target wrkrs version.
4. Replace an unchanged managed file.
5. Preserve and block on a changed managed file unless a field-specific merge can prove safety.
6. Migrate seeded configuration only through an explicit schema migration that retains unknown extension data and comments.
7. Add new files normally.
8. Remove obsolete managed files only when their hashes are unchanged.
9. Show the complete update plan and require confirmation.
10. Write the new manifest only after post-apply validation passes.

Uninstall rules:

1. Build an uninstall plan solely from a validated manifest and current bytes.
2. Remove unchanged managed files.
3. Remove owned fields or blocks only when their installed values or markers remain unambiguous.
4. Never delete referenced content.
5. Preserve customized seeded or managed files and report them.
6. Remove created directories only when empty.
7. If conflicts remain, retain a reduced manifest in partial-uninstall state so a later retry is safe.
8. A force option, if added, must list exact affected paths, create recoverable backups, and require explicit confirmation.

No update or uninstall command was part of the first vertical slice; their safety semantics were fixed before init wrote its first manifest. The second increment implements them under exactly those rules. mvp.md carries the command surface, the desired-state sources, and acceptance tests 42 through 73; decisions.md A-021 records the choices implementation forces.

Implementing them extends the writer with three operations beside exclusive create:

| Operation | Apply | Rollback |
| --- | --- | --- |
| replace-file | Stage new content, back up prior bytes and mode inside .wrkrs, publish by rename | Restore the backup |
| remove-file | Back up bytes and mode, then unlink | Restore the backup |
| remove-directory | Remove a manifest-created directory, only when empty, deepest first | Recreate it |

Exclusive creation keeps its no-replace contract unchanged: it still refuses to replace an existing target. Replacement and removal are separate, explicitly planned operations that may target only a path the manifest already owns and whose current hash matched at precondition recheck. Creation is safe because the path is unoccupied; replacement is safe because the manifest proves wrkrs wrote the exact bytes still present.

### Testing strategy

| Layer | Purpose |
| --- | --- |
| Unit | Schema versions, detectors, roster rules, path safety, hashes, merge policies, manifest drift, diagnostics |
| Planner | Golden semantic plans and exact diff snapshots from repository snapshots |
| Writer | Apply, precondition failure, lock contention, injected failure, rollback, and external-change-during-rollback behavior |
| Adapter | Exact portable roles and Claude projection validation |
| Integration | Invoke the compiled CLI in temporary Git repositories |
| Fixture | Clean repository and repository with existing Claude configuration |
| Cross-platform | Ubuntu, macOS, and Windows path and process behavior |

Tests copy a fixture into a temporary directory and initialize a real Git worktree there. Fixtures do not contain nested .git directories. Dry-run tests hash the entire target tree before and after and require byte-for-byte equality.

Machine-readable output is asserted semantically. Human output may use snapshots after paths, timestamps, and terminal capabilities are normalized. Fault injection occurs through filesystem and clock ports rather than unreliable operating-system tricks.

## Recommended source layout

The first repository is one package:

    architecture.md
    decisions.md
    mvp.md
    package.json
    package-lock.json
    tsconfig.json
    vitest.config.ts
    src/
      cli/
        index.ts
        commands/
          init.ts
          check.ts
        output/
          human-reporter.ts
          json-reporter.ts
        prompt.ts
      core/
        result.ts
        errors.ts
        findings.ts
        roster.ts
        capabilities.ts
        plan.ts
        ownership.ts
        runtime-adapter.ts
        provider.ts
      config/
        schema.ts
        json-schema.ts
        load.ts
        serialize.ts
        migrations/
      repository/
        locate.ts
        analyze.ts
        snapshot.ts
        detectors/
          project.ts
          claude-code.ts
          wrkrs.ts
      planner/
        init-plan.ts
        operations.ts
        conflicts.ts
        diff.ts
        digest.ts
      writer/
        transaction.ts
        preconditions.ts
        journal.ts
        rollback.ts
      adapters/
        claude-code/
          adapter.ts
          analyze.ts
          compile.ts
          validate.ts
          templates/
            agents/
            skills/
      providers/
        registry.ts
      check/
        check.ts
        checks/
      platform/
        filesystem.ts
        git.ts
        process.ts
        hash.ts
        paths.ts
        clock.ts
        ids.ts
    test/
      unit/
      integration/
      fixtures/
        clean-repository/
        existing-claude-repository/

### Dependency direction

- core imports no CLI framework, filesystem implementation, Claude-specific code, or provider-specific code.
- config depends on core data types and Zod.
- repository produces a RepositorySnapshot and does not choose installation changes.
- runtime adapters and providers consume core contracts and return desired components or diagnostics.
- planner compares a snapshot with desired state and returns an immutable InstallPlan.
- writer consumes only a validated plan and filesystem ports. It does not know Claude semantics.
- check composes independent validations and returns structured diagnostics.
- cli is the composition root and presentation layer.

Circular dependencies are build errors. Runtime and provider registries are explicit maps assembled by the composition root; there is no dynamic code loading in the MVP.

## Core domain contracts

The exact field names may be refined during implementation, but these boundaries are part of the proposed architecture.

    interface RepositorySnapshot {
      root: AbsolutePath
      git: GitSnapshot
      projectSignals: ProjectSignal[]
      claude: ClaudeSnapshot
      wrkrs: WrkrsSnapshot
      files: ReadonlyMap<RelativePath, FileSnapshot>
      findings: Finding[]
    }

    interface RosterRecommendation {
      presetId: "product-engineering"
      primaryRoleId: "product-manager"
      roles: RecommendedRole[]
      evidence: RecommendationEvidence[]
    }

    interface RuntimeAdapter {
      id: string
      analyze(snapshot: RepositorySnapshot): AdapterAnalysis
      compile(input: AdapterCompileInput): DesiredComponent[]
      validate(context: AdapterValidationContext): Diagnostic[]
    }

    interface ProviderAdapter {
      id: string
      capabilities: CapabilityId[]
      probe(context: ProviderProbeContext): ProviderProbe
      planConfiguration(input: ProviderPlanInput): DesiredComponent[]
      diagnose(context: ProviderCheckContext): Diagnostic[]
    }

    interface InstallPlan {
      schemaVersion: 1
      command: "init"
      repositoryRoot: AbsolutePath
      findings: Finding[]
      roster: RosterRecommendation
      operations: PlanOperation[]
      blockers: Conflict[]
      digest: string
    }

Workflows request capabilities rather than provider names. Initial capability families include source control and pull requests, work items, design files and comments, and generic tool context. GitHub, Linear, and Figma later satisfy those capabilities. A manual provider can emit instructions or links without credentials. A generic MCP provider maps existing server names to capabilities only after the mapping is shown.

## Repository-owned installed layout

The first vertical slice proposes this target layout:

    .wrkrs/
      config.yaml
      schema.json
      manifest.json
      roles/
        product-manager.md
        product-designer.md
        software-engineer.md
        qa-engineer.md
    .claude/
      agents/
        wrkrs-product-manager.md
        wrkrs-product-designer.md
        wrkrs-software-engineer.md
        wrkrs-qa-engineer.md
      skills/
        wrkrs/
          SKILL.md

Portable role files are seeded and editable. Claude files are managed projections. The schema is managed. config.yaml is seeded. manifest.json is machine-owned.

Conceptual config:

    schemaVersion: 1
    preset:
      id: product-engineering
      version: 1
    runtime:
      primary: claude-code
    roster:
      primaryRole: product-manager
      roles:
        - id: product-manager
          source: .wrkrs/roles/product-manager.md
        - id: product-designer
          source: .wrkrs/roles/product-designer.md
        - id: software-engineer
          source: .wrkrs/roles/software-engineer.md
          specializations:
            - web-frontend
        - id: qa-engineer
          source: .wrkrs/roles/qa-engineer.md
    governance:
      requirePlanApproval: true
      requireDesignApproval: true
      requireOwnerTestForUserFacingOrNativeWork: true
      requireExplicitReleaseApproval: true
    providers: {}
    extensions: {}

The detected stack changes specializations and evidence, not the four default role identities. A repository may edit the resulting roster after installation.

## Complete init flow

### 0. Parse and preflight

- Parse flags and select human or JSON output.
- Verify the running Node version.
- Resolve the Git worktree root from the requested working directory.
- Reject a bare repository, unsupported platform condition, invalid path, or missing Git.
- Create no target file or directory.

### 1. Read-only scan

- Read bounded project markers.
- Inspect Git status without requiring a clean tree.
- Inspect Claude and existing wrkrs paths.
- Parse only known configuration formats with size and path limits.
- Record file bytes and hashes required for planning.
- Redact values that may contain secrets.

### 2. Findings

- Emit stable finding codes with severity, evidence, and affected path.
- Distinguish information, warnings, and blockers.
- List existing Claude files and components that will be preserved.

### 3. Roster recommendation

- Start with the Product Engineering preset.
- Keep the four locked roles.
- Recommend Software Engineer specializations from detected stack signals.
- Explain the evidence for every specialization.
- Do not create permanent platform-specific engineer roles.

### 4. Roster review

- In an interactive terminal, show the recommendation and allow accepting the first-slice default.
- The complete MVP may add edit prompts; direct config editing remains supported.
- In non-interactive mode, use the deterministic recommendation unless a config input is supplied.

### 5. Desired-state compilation

- Compile portable config, role definitions, schema, manifest intent, and Claude adapter projections in memory.
- Ask provider and runtime registries for components through contracts.
- Do not write temporary data inside the target repository.

### 6. Plan

- Compare desired components with exact current bytes.
- Classify every relevant path as create, structural-merge, reuse, preserve, no-op, or block.
- Validate path containment, symlinks, case collisions, existing ownership, schema versions, and component collisions.
- Render exact proposed bytes and unified display diffs.
- Compute a deterministic digest over the semantic plan, excluding timestamps and absolute-path noise.

### 7. Dry-run presentation

Display, in this order:

1. selected repository
2. project and Claude findings
3. recommended repository roster and evidence
4. created, merged, reused, preserved, and blocked paths
5. exact diffs for every mutation
6. ownership modes
7. warnings and blockers
8. plan digest

The dry run performs zero writes beneath the target root. The --dry-run flag exits here. --json returns the same semantic plan without terminal styling.

### 8. Confirmation

- Block if any blocker exists.
- Prompt with the exact mutation count and plan digest in an interactive terminal.
- Cancellation exits successfully with no writes.
- Non-interactive apply requires --yes; otherwise it fails with no writes.
- No confirmation implies approval for merge, commit, push, deployment, publication, or release.

### 9. Apply preconditions

- Acquire an exclusive installation lock after confirmation.
- Re-read every operation target.
- Verify absence or expected hashes, type, mode, and symlink state.
- If anything changed, release the lock, discard the plan, and require a new dry run.

### 10. Transactional apply

- Create a transaction identifier and journal.
- Stage proposed content on the same filesystem.
- Back up only files that a plan will modify.
- Apply operations in deterministic path order.
- Record each completed operation and exact applied hash.
- Write the candidate manifest near the end of the same transaction.
- Never invoke repository lifecycle scripts.

### 11. Validation

- Reparse config and manifest.
- Validate every generated role and Claude agent frontmatter.
- Verify all owned paths and hashes.
- Run the same validations exposed by wrkrs check.
- Treat a check error as transaction failure.

### 12. Commit or rollback

- On success, mark the transaction committed, remove transient backups and lock, and report installed paths.
- On failure, reverse completed operations.
- Delete a newly created file only if its current hash still equals the applied hash.
- Restore a modified file only if no external edit occurred after apply.
- Retain recovery data and report exact paths if complete rollback cannot be proven.

### 13. Completion

- Print a concise summary, any warnings, and the next command.
- Suggest invoking the wrkrs project skill from Claude Code.
- Do not run Claude Code, commit generated files, or contact providers automatically.

## Conflict taxonomy

| Code family | Example | Result |
| --- | --- | --- |
| PATH | Absolute path, parent traversal, symlink outside root, case collision | Block |
| OWNERSHIP | .wrkrs exists without a valid manifest; manifest belongs to incompatible schema | Block |
| COMPONENT | Namespaced Claude path contains different content | Block |
| FORMAT | Required shared JSON/YAML is invalid or unsupported | Block only when that file must change; otherwise preserve with warning |
| SECURITY | A requested merge would broaden permissions or write a literal secret | Block |
| PRECONDITION | Target changed between plan and apply | Abort and require replan |
| CUSTOMIZATION | Managed file drifted since last apply | Preserve and block update of that file |
| ENVIRONMENT | Claude executable not local but repository files are otherwise valid | Warning, because cloud use remains possible |
| GIT | Worktree is dirty | Warning; never overwrite unrelated changes |

## Transaction and path invariants

- All installed paths are normalized POSIX-style repository-relative paths in plans and manifests.
- Absolute paths, empty paths, parent traversal, NUL bytes, and platform device names are rejected.
- Every path segment is inspected with lstat before write.
- The real target parent must remain within the real repository root.
- Planned paths are checked for case-folded collisions for cross-platform safety.
- Child processes are executed without a shell and receive argument arrays.
- Target modes are explicit; generated files are not executable.
- Generated text uses UTF-8 and a final newline.
- Timestamps and IDs come from injectable ports so tests are deterministic.

## check contract

wrkrs check is a read-only installation health check. It emits stable diagnostic codes and human or JSON output.

Initial checks:

- supported Node version
- Git executable and valid worktree
- config presence, parse, schema version, and semantic references
- role source presence and identifiers
- manifest parse, schema, path containment, and duplicate ownership
- owned-file presence and drift
- stale or incomplete transactions
- Claude adapter agent and skill frontmatter
- conflicting namespaced Claude components
- optional local Claude executable detection

Exit codes:

- 0: no errors; warnings may exist
- 1: one or more errors
- 2: invalid command usage

A later --strict mode may treat warnings as an error for CI. check makes no network call and never repairs without a separate explicit command and plan.

## First vertical slice boundary

The first implementation includes:

- init, --dry-run, --yes, --json, and an injectable working directory
- Git root resolution and bounded project/Claude detection
- deterministic four-role recommendation with detected Software Engineer specializations
- exact create-only plan plus preserve/reuse/block classifications
- repository-owned .wrkrs config, schema, roles, and manifest
- minimal namespaced Claude agents and project skill
- transactional create operations and rollback
- check
- clean and existing-Claude fixtures

It intentionally does not implement shared-file structural edits, provider authentication, dedicated GitHub/Linear/Figma configuration, update, uninstall, dynamic plugin loading, or remote services. The abstractions for those features are exercised only where the vertical slice needs them; no unused framework scaffolding should be added.

## First vertical slice implementation notes

Implemented on 2026-08-29 after owner approval. The implementation follows the architecture above; the refinements below are recorded in decisions.md as A-015 and do not change approved scope or safety behavior.

Source layout as implemented, in addition to the recommended tree:

    schema/
      wrkrs-config.schema.json        committed JSON Schema; a unit test keeps it identical to the Zod output
    scripts/
      copy-assets.mjs                 copies packaged Markdown templates into dist
      generate-schema.mjs             renders schema/ from the compiled Zod definition
      smoke.mjs                       packs the tarball and exercises the compiled CLI
    src/
      core/
        ports.ts                      port interfaces (filesystem, process, clock, ids, prompt, environment)
        snapshot.ts                   RepositorySnapshot contract
        diagnostics.ts                check diagnostics
        configuration.ts              WrkrsConfig contract type-checked against the Zod schema
        versions.ts, template.ts, frontmatter.ts
      init/
        init.ts                       init application service (prepare and apply); handlers stay thin
      presets/
        product-engineering/
          index.ts                    preset roles and specialization rules
          roles/*.md                  portable role templates shipped in the package
      adapters/registry.ts            explicit runtime adapter registry
      platform/environment.ts         Node version, PATH lookup for the optional Claude executable
      platform/package-info.ts        package version for --version and the manifest
      platform/contained-path.ts      RepositoryReader: contained, symlink-refusing read boundary
      check/context.ts, check/checks/*.ts
    test/
      helpers/                        temp Git repositories, tree hashing, fault-injecting filesystem, read recorder, compiled CLI runner
      setup/build.ts                  builds dist once so integration tests run the compiled CLI
      fixtures/malformed-documents/   malformed config, manifest, and journal with short redaction sentinels

Behavioral notes:

- The dry run shows the exact manifest bytes that apply writes because the installation identifier and timestamps come from injectable ports at plan time; the plan digest excludes them.
- Transaction bookkeeping lives in .wrkrs: .wrkrs/.lock is the exclusive lock and .wrkrs/.journal.json the journal. There are no file backups because the slice is create-only.
- init against a valid existing installation never writes: unchanged owned files are no-ops, customized seeded files are preserved, and any other difference blocks and points to the planned update command.
- check reports managed drift as an error, seeded customization as information, and changes to referenced files as warnings. A blocked dry run exits with code 1.
- Module boundaries and cycle freedom are enforced by a unit test over the import graph rather than a linter.

Safety behavior confirmed by the 2026-08-29 review remediation (decisions.md A-016) and hardened by the second review round (decisions.md A-017):

- Atomic no-replace publication. A create operation is fully staged as a sibling temporary file (O_EXCL, no follow) and its bytes are fsynced; the target name is then created through `BoundDirectory.linkExclusive`, a hard link that fails with EEXIST when any entry exists at the target, whether file, directory, or symlink, and never replaces anything. There is no copy fallback: when the filesystem cannot create hard links the transaction fails closed with `ENVIRONMENT_ATOMIC_PUBLICATION_UNSUPPORTED` and rolls back. Target creation and staging cleanup are separate lifecycle steps: planned, staging (staging path announced before the exclusive write), staged (content written and synced, expected hash recorded), published (target name exists; the staging path is kept in the journal until its removal is proven), applied (target re-read and hash-verified). A target that appears between planning and publication is never overwritten or removed; the transaction fails with `PRECONDITION_TARGET_APPEARED` naming the exact path and rolls everything else back.
- Durable journal state and hash-guarded reconciliation. Every journal update is written to a temporary sibling, fsynced, renamed over the live journal, and followed by an fsync of the containing directory; the live journal is never truncated or rewritten in place. The same directory sync follows target publication, directory creation, and rollback removals. The guarantee is recorded per transaction: `durability: strict` when every such sync succeeded, `best-effort` when the platform reported directory syncing as unsupported (then `TRANSACTION_DURABILITY_BEST_EFFORT` is emitted); a directory-sync I/O error is a transaction failure. The in-memory journal advances before each persistence attempt and before each fallible cleanup, so neither a journal failure nor a staging-cleanup failure can hide a name wrkrs created. Rollback reconciles both staging and target paths against the recorded hashes, deletes only files whose current hash proves wrkrs wrote them unchanged, verifies that every created path is provably absent, and returns rolled-back only when that holds; otherwise it returns rollback-incomplete with every exact retained path (files, not only their parent directories) and keeps the journal.
- Containment bound to I/O. All repository I/O goes through `FileSystemPort.withinDirectory(root, directory, operation)`: the Node port walks each segment with lstat (refusing symlinks and non-directories), enters it with chdir, and confirms the entered directory's identity (device and inode) against what lstat reported, then hands the operation name-relative methods (`lstat`, `readFile` with O_NOFOLLOW plus a handle-identity check, `readDirectory`, `writeFileExclusive`, `linkExclusive`, `unlink`, `rename`, `makeDirectory`, `removeDirectory`, `sync`). On POSIX the working directory is held by inode, so an ancestor replaced after binding cannot redirect the operation; a swap detected during binding fails closed with `ContainmentError` (`PATH_ANCESTOR_SYMLINK`, `PATH_ANCESTOR_NOT_A_DIRECTORY`, `PATH_ANCESTOR_CHANGED`, `PATH_ENTRY_CHANGED`) before any read, write, or removal, and raw chdir errors never reach output. No verified-directory cache exists; every operation re-binds. The scanner, `wrkrs check`, Claude adapter validation, precondition rechecks, staging, publication, verification, and rollback all use this boundary, and no path-based repository read or write remains in the port. Violations surface as the `SCAN_PATH_UNSAFE` finding, the `*_PATH_UNSAFE` diagnostics, and the `PATH_ANCESTOR_CHANGED` conflict without exposing external content.
- Binding coordination (decisions.md A-018). Because the working directory is process-wide, all Node filesystem instances share one module-global scheduler, and a logical binding scope (AsyncLocalStorage) rejects a nested `withinDirectory` call synchronously with `CONTAINMENT_REENTRANT` before it is queued, so it cannot deadlock. A `BoundDirectory` is valid only inside the callback that produced it: after the callback settles every method fails with `BOUND_DIRECTORY_CLOSED`, and each method first re-verifies that the working directory still has the bound identity (`CONTAINMENT_LOST` otherwise). The previous working directory is restored after every operation, including failures. Tests run in forked Vitest workers because worker threads cannot change directory.
- Platform support (decisions.md A-018). The binding mechanism is supported on macOS and Linux (verified on macOS). `FileSystemPort.containment` exposes the capability explicitly; on Windows, and in worker threads, it reports unsupported and wrkrs fails closed: `init` (including `--dry-run`) stops before locating or scanning repository content with `ENVIRONMENT_CONTAINMENT_UNSUPPORTED`, `check` performs environment and Git worktree detection only and reports the same code, `applyPlan` aborts with it, and `--help` and `--version` keep working. There is no pathname-precheck fallback. Full Windows contained I/O is deferred to the cross-platform increment.
- Exclusive-write failure contract (decisions.md A-018, tightened by A-019). `BoundDirectory.writeFileExclusive` raises `FileSystemError` when nothing was created (EEXIST means the entry belongs to someone else and is never touched) and `ExclusiveWriteError` when the O_EXCL entry exists but the write, sync, or close failed. The transaction announces every name it may create before creating it: a file operation moves to `staging` (staging path persisted) before the exclusive write, and a lock or journal temporary that was created but not completed is removed, proven absent, and synced, or reported by exact path with a recovery journal. An incomplete staging entry is never deleted: no portable primitive can prove the current directory entry is still the file wrkrs created rather than an external replacement, so it is retained, reported by exact path, and the result is rollback-incomplete. Lock creation is tracked separately from the directory sync that follows it, so a sync failure after a successful create reconciles the lock instead of pretending nothing was created. `aborted` and `rolled-back` are never returned while an entry created by the failed operation may remain.
- Removal durability ordering (decisions.md A-018, completed by A-019 and A-020). Every transaction-critical removal (staging cleanup, rollback of targets, staging files, and generated directories, lock release on every exit path, journal temporary, and live-journal cleanup) proceeds as: remove the name, verify it is absent, sync the containing directory, and only then persist journal state that forgets the name or marks it reverted. A real directory-sync error is never swallowed: during rollback it yields `rollback-incomplete` with the exact path marked "not proven durable" (a current absence check is not treated as proof of durable deletion); after an otherwise valid installation it yields the `TRANSACTION_BOOKKEEPING_DURABILITY_UNPROVEN` warning and the result reports `best-effort` durability. An unsupported directory sync downgrades the transaction to `best-effort` honestly, and the journal is re-persisted so its serialized `durability` matches the effective value. A successful commit removes only transient bookkeeping (lock, journal temporary, live journal); the installed `.wrkrs` directory and its repository-owned contents stay, and a transaction-created `.wrkrs` is removed only on abort or rollback. A journal temporary retained by an earlier failed cleanup is retried during bookkeeping release and dropped from the retained report only once its removal is proven.
- Bookkeeping removal ledger (decisions.md A-020). One authoritative in-memory ledger holds the state of every bookkeeping name inside `.wrkrs` (the lock, the live journal, and journal temporaries), and every cleanup path — the lock-acquisition failure, the journal-write failure, the precondition recheck, the successful commit, and the final rollback-incomplete exit — records through it instead of an ad hoc cleanup. Each exact path is unknown (never created, or proven removed), pending (unlinked and verified absent, awaiting the directory sync that proves it), or retained (could not be removed, still present, or could not be inspected). A directory-sync failure is never collapsed onto `.wrkrs`: every exact path awaiting that sync is reported individually as "not proven durable" — `.wrkrs/.lock`, `.wrkrs/.journal.json`, and `.wrkrs/.journal.json.<id>.tmp` — while `.wrkrs` itself is named only when the directory could not be bound, inspected, or removed. A name that was unlinked keeps no stale "could not be removed" reason. Every completed `.wrkrs` directory sync, including the one `persistJournal` performs, reconciles the pending set, so a later successful sync clears a durability-unproven entry while unlink failures, inspection failures, and names that still exist stay retained. When any removal is still unproven at the moment the final journal is written, the journal records `best-effort` durability, so the serialized durability and the reported paths never contradict each other; the live journal remains the recovery record whenever rollback stays incomplete. `.wrkrs` durability depends on its parent directory, so its own removal is never cleared by a `.wrkrs` sync.
- Sanitized parser diagnostics. YAML and JSON parser messages are replaced by controlled codes (`YAML_<code>`, `JSON_SYNTAX_ERROR`) with line and column metadata only; schema violation messages are limited to expected-shape text and never echo unrecognized keys or values; unexpected CLI errors print only the error class (stack frames on request), so no output path can quote repository content.
- Exact target handling under bounded scans. After desired-state compilation, `snapshotTargets` captures the exact lstat, hash, mode, symlink state, and ancestor state of every generated target, plus a listing of each existing parent directory, independently of the bounded generic index. The planner classifies only from those snapshots, proves case-folded collision safety from the listings (including an existing ancestor or target that is reachable only under a differently cased name), and blocks with `SCAN_INCOMPLETE` when a listing exceeds its bound instead of emitting a create it cannot prove safe.

## Current primary references

These links anchor choices that may change and were verified on the architecture review date:

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [npm package bin behavior](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/)
- [Commander releases](https://github.com/tj/commander.js/releases)
- [TypeScript NodeNext guidance](https://www.typescriptlang.org/docs/handbook/modules/theory.html)
- [Git worktree root detection](https://git-scm.com/docs/git-rev-parse)
- [Claude Code project directory](https://code.claude.com/docs/en/claude-directory)
- [Claude Code custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code extension choices](https://code.claude.com/docs/en/features-overview)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Zod JSON Schema](https://zod.dev/json-schema)
- [yaml document API](https://eemeli.org/yaml/)
- [jsonc-parser](https://github.com/microsoft/node-jsonc-parser)
- [Vitest guide](https://vitest.dev/guide/)
