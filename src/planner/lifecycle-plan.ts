import { serializeManifest } from '../config/serialize.js'
import { createFinding, sortFindings, type Finding } from '../core/findings.js'
import {
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  WRKRS_DIRECTORY,
  type ManifestEntry,
  type OwnershipManifest,
} from '../core/ownership.js'
import type {
  Conflict,
  DesiredComponent,
  InstallPlan,
  PlanOperation,
  PlanCommand,
} from '../core/plan.js'
import type { ClockPort, IdPort } from '../core/ports.js'
import type { RosterRecommendation } from '../core/roster.js'
import type { FileSnapshot, RepositorySnapshot } from '../core/snapshot.js'
import { formatTimestamp } from '../platform/clock.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories, normalizeRelativePath } from '../platform/paths.js'
import { conflict, sortConflicts } from './conflicts.js'
import { computePlanDigest, MANIFEST_SOURCE_ID } from './digest.js'
import { containmentConflict } from './init-plan.js'
import {
  blockedOperation,
  createOperation,
  passiveOperation,
  removeOperation,
  replaceOperation,
  sortOperations,
  type OperationSource,
} from './operations.js'

const CORE_COMPONENT = 'wrkrs'

/** Exact current bytes of every path a lifecycle plan may touch, keyed by repository-relative path. */
export type ContentIndex = ReadonlyMap<string, string>

export interface LifecyclePlanInput {
  readonly snapshot: RepositorySnapshot
  readonly manifest: OwnershipManifest
  readonly contents: ContentIndex
  readonly findings: readonly Finding[]
  readonly wrkrsVersion: string
  readonly clock: ClockPort
  readonly ids: IdPort
}

export interface UpdatePlanInput extends LifecyclePlanInput {
  readonly roster: RosterRecommendation
  readonly desired: readonly DesiredComponent[]
  readonly runtimeAdapters: readonly { readonly id: string; readonly version: number }[]
}

export interface UninstallPlanInput extends LifecyclePlanInput {
  readonly roster: RosterRecommendation
}

function sourceOf(component: DesiredComponent): OperationSource {
  return {
    path: component.path,
    component: component.component,
    reason: component.reason,
    management: component.management,
    sourceId: component.sourceId,
    sourceVersion: component.sourceVersion,
  }
}

function entrySource(entry: ManifestEntry, reason: string): OperationSource {
  return {
    path: entry.path,
    component: entry.sourceId.includes('/')
      ? (entry.sourceId.split('/')[0] as string)
      : CORE_COMPONENT,
    reason,
    management: entry.management,
    sourceId: entry.sourceId,
    sourceVersion: entry.sourceVersion,
  }
}

/**
 * Shared path safety for a lifecycle target: normalized form, a captured
 * snapshot, and a containment proof. Returns the blocking conflict or null.
 */
function pathConflict(path: string, snapshot: RepositorySnapshot): Conflict | null {
  const normalized = normalizeRelativePath(path)
  if (!normalized.ok || normalized.value !== path) {
    return conflict(
      'PATH',
      normalized.ok ? 'PATH_NOT_NORMALIZED' : normalized.error.code,
      path,
      normalized.ok
        ? 'Path is not in normalized repository-relative form'
        : normalized.error.message,
      'Correct the path in .wrkrs/config.yaml or the ownership manifest',
    )
  }
  const target = snapshot.targets.get(path)
  if (!target) {
    return conflict(
      'PRECONDITION',
      'SCAN_TARGET_UNVERIFIED',
      path,
      'The exact state of this path was not captured before planning',
      'Run the command again with --dry-run; if it persists, report it with the plan digest',
    )
  }
  return containmentConflict(path, target)
}

/** Blocks when an owned or desired path exists but is not an inspectable regular file. */
function fileStateConflict(path: string, file: FileSnapshot): Conflict | null {
  if (file.kind === 'symlink') {
    return conflict(
      'PATH',
      'PATH_TARGET_SYMLINK',
      path,
      'The path is a symlink',
      'Remove the symlink or move it aside; wrkrs never writes through symlinks',
    )
  }
  if (file.kind !== 'file') {
    return conflict(
      'PATH',
      'PATH_TARGET_NOT_A_FILE',
      path,
      `The path exists and is a ${file.kind}`,
      'Restore the regular file wrkrs installed, or move the conflicting path aside',
    )
  }
  if (!file.hash) {
    return conflict(
      'FORMAT',
      'FORMAT_UNINSPECTABLE_TARGET',
      path,
      'The file is too large to inspect safely',
      'Move the file aside before running the command again',
    )
  }
  return null
}

/**
 * Classifies one desired component against the installation. Drift is
 * preserved per file: a customized or drifted entry is reported and left
 * exactly as it is while the rest of the plan still applies.
 */
function classifyDesiredForUpdate(
  component: DesiredComponent,
  snapshot: RepositorySnapshot,
  entry: ManifestEntry | undefined,
  contents: ContentIndex,
): PlanOperation {
  const source = sourceOf(component)
  const blocked = pathConflict(component.path, snapshot)
  if (blocked) return blockedOperation(source, undefined, blocked)

  const file = snapshot.targets.get(component.path)?.file ?? undefined
  const proposedHash = sha256(new TextEncoder().encode(component.content))

  if (!file) {
    return createOperation(
      {
        ...source,
        reason: entry
          ? `${component.reason} (restored: the owned file was missing)`
          : component.reason,
      },
      component.content,
    )
  }

  const stateConflict = fileStateConflict(component.path, file)
  if (stateConflict) return blockedOperation(source, file, stateConflict)

  if (!entry) {
    // A namespaced target this installation does not own must never be
    // overwritten, whatever it contains.
    return blockedOperation(
      source,
      file,
      conflict(
        'OWNERSHIP',
        'OWNERSHIP_UNOWNED_TARGET',
        component.path,
        'A file exists at this path but the ownership manifest does not record it',
        'Move the file aside and run `wrkrs update` again, or reinstall with `wrkrs init`',
      ),
    )
  }

  if (entry.management === 'referenced') {
    return passiveOperation(
      {
        ...source,
        management: 'referenced',
        reason: 'Pre-existing file referenced by wrkrs; never modified',
      },
      'preserve',
      file,
    )
  }

  if (file.hash === proposedHash) {
    return passiveOperation({ ...source, reason: 'Already current' }, 'no-op', file)
  }

  if (component.schemaMigration) {
    return replaceOperation(source, file, contents.get(component.path) ?? '', component.content)
  }

  if (file.hash !== entry.lastAppliedHash) {
    return passiveOperation(
      {
        ...source,
        reason:
          entry.management === 'seeded'
            ? 'Customized after installation; the customization is preserved'
            : 'Changed since wrkrs last applied it; the change is preserved and this file is not updated',
      },
      'preserve',
      file,
    )
  }

  return replaceOperation(source, file, contents.get(component.path) ?? '', component.content)
}

/**
 * Builds the update plan: desired state from the packaged version and the
 * repository's own configuration, reconciled against the ownership manifest.
 */
export function buildUpdatePlan(input: UpdatePlanInput): InstallPlan {
  const { snapshot, manifest, contents } = input
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry] as const))
  const desiredPaths = new Set(input.desired.map((component) => component.path))

  const operations: PlanOperation[] = [...input.desired]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((component) =>
      classifyDesiredForUpdate(component, snapshot, entries.get(component.path), contents),
    )

  const retained = new Map<string, ManifestEntry>()
  for (const operation of operations) {
    const entry = entries.get(operation.path)
    switch (operation.outcome) {
      case 'create':
      case 'replace':
        retained.set(operation.path, {
          path: operation.path,
          kind: 'file',
          management: (operation.management ?? 'managed') as ManifestEntry['management'],
          sourceId: operation.sourceId as string,
          sourceVersion: operation.sourceVersion ?? 1,
          lastAppliedHash: operation.proposedHash as string,
        })
        break
      case 'no-op':
        // The file already holds exactly what wrkrs would write, so that is
        // what it last applied. Recording it adopts an edit to a seeded file
        // that round-trips through the generator, instead of reporting it as
        // drift forever and forcing every later uninstall to go partial.
        if (entry) {
          retained.set(
            operation.path,
            operation.expected.kind === 'file'
              ? { ...entry, lastAppliedHash: operation.expected.hash }
              : entry,
          )
        }
        break
      default:
        // Preserved and blocked paths keep exactly the ownership record they
        // had, so drift stays measurable against what wrkrs last applied.
        if (entry) retained.set(operation.path, entry)
        break
    }
  }

  // Owned entries the desired state no longer contains.
  for (const entry of manifest.entries) {
    if (desiredPaths.has(entry.path)) continue
    const source = entrySource(entry, 'No longer part of the configured installation')
    if (entry.management === 'referenced') {
      retained.set(entry.path, entry)
      operations.push(
        passiveOperation(
          { ...source, reason: 'Pre-existing file referenced by wrkrs; never removed' },
          'preserve',
          snapshot.targets.get(entry.path)?.file ?? undefined,
        ),
      )
      continue
    }
    const blocked = pathConflict(entry.path, snapshot)
    if (blocked) {
      retained.set(entry.path, entry)
      operations.push(blockedOperation(source, undefined, blocked))
      continue
    }
    const file = snapshot.targets.get(entry.path)?.file ?? undefined
    if (!file) {
      operations.push(
        passiveOperation(
          { ...source, reason: 'Already absent; the ownership record is dropped' },
          'no-op',
          undefined,
        ),
      )
      continue
    }
    const stateConflict = fileStateConflict(entry.path, file)
    if (stateConflict) {
      retained.set(entry.path, entry)
      operations.push(blockedOperation(source, file, stateConflict))
      continue
    }
    if (file.hash !== entry.lastAppliedHash) {
      retained.set(entry.path, entry)
      operations.push(
        passiveOperation(
          { ...source, reason: 'Changed since wrkrs last applied it; the change is preserved' },
          'preserve',
          file,
        ),
      )
      continue
    }
    operations.push(removeOperation(source, file, contents.get(entry.path) ?? ''))
  }

  const createdDirectorySet = new Set<string>()
  for (const operation of operations) {
    if (operation.outcome !== 'create') continue
    const target = snapshot.targets.get(operation.path)
    const existing = new Set(
      (target?.ancestors ?? [])
        .filter((ancestor) => ancestor.kind !== null)
        .map((ancestor) => ancestor.path),
    )
    for (const ancestor of ancestorDirectories(operation.path)) {
      if (!existing.has(ancestor)) createdDirectorySet.add(ancestor)
    }
  }
  const createdDirectories = [...createdDirectorySet].sort(
    (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
  )

  const mutates = operations.some(
    (operation) =>
      operation.outcome === 'create' ||
      operation.outcome === 'replace' ||
      operation.outcome === 'remove',
  )

  const now = formatTimestamp(input.clock.now())
  const nextEntries = [...retained.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  const directorySet = new Set([...manifest.createdDirectories, ...createdDirectories])
  const nextManifest: OwnershipManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    state: 'installed',
    installationId: manifest.installationId,
    wrkrsVersion: input.wrkrsVersion,
    installedAt: manifest.installedAt,
    updatedAt: manifest.updatedAt,
    preset: { id: input.roster.presetId, version: input.roster.presetVersion },
    runtimeAdapters: input.runtimeAdapters,
    entries: nextEntries,
    createdDirectories: [...directorySet].sort(
      (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
    ),
  }

  const manifestSource: OperationSource = {
    path: MANIFEST_PATH,
    component: CORE_COMPONENT,
    reason: 'Ownership manifest recording exactly what wrkrs owns',
    management: 'managed',
    sourceId: MANIFEST_SOURCE_ID,
    sourceVersion: MANIFEST_SCHEMA_VERSION,
  }
  const manifestFile = snapshot.targets.get(MANIFEST_PATH)?.file ?? undefined
  const currentManifest = contents.get(MANIFEST_PATH) ?? ''
  // Rewriting the manifest is itself a change, so the timestamp only moves
  // when something else does. That makes "already current" a true no-op.
  const unchanged = !mutates && serializeManifest(nextManifest) === currentManifest
  if (unchanged || !manifestFile) {
    operations.push(
      passiveOperation(
        { ...manifestSource, reason: unchanged ? 'Already current' : 'Ownership manifest' },
        'no-op',
        manifestFile,
      ),
    )
  } else {
    const stateConflict = fileStateConflict(MANIFEST_PATH, manifestFile)
    if (stateConflict) {
      operations.push(blockedOperation(manifestSource, manifestFile, stateConflict))
    } else {
      operations.push(
        replaceOperation(
          manifestSource,
          manifestFile,
          currentManifest,
          serializeManifest({ ...nextManifest, updatedAt: now }),
        ),
      )
    }
  }

  const notices = operations
    .filter(
      (operation) => operation.outcome === 'preserve' && operation.management !== 'referenced',
    )
    .map((operation) =>
      createFinding(
        operation.management === 'seeded'
          ? 'UPDATE_CUSTOMIZATION_PRESERVED'
          : 'UPDATE_DRIFT_PRESERVED',
        operation.management === 'seeded' ? 'info' : 'warning',
        operation.reason,
        {
          path: operation.path,
          evidence: [{ key: 'management', value: operation.management ?? '' }],
        },
      ),
    )

  return finishPlan({
    command: 'update',
    input,
    operations,
    notices,
    createdDirectories,
    removedDirectories: [],
    now,
  })
}

/**
 * Builds the uninstall plan from the validated manifest and current bytes
 * alone. Packaged templates are never consulted: what wrkrs removes is what
 * it recorded installing and still recognizes byte for byte.
 */
export function buildUninstallPlan(input: UninstallPlanInput): InstallPlan {
  const { snapshot, manifest, contents } = input
  const operations: PlanOperation[] = []
  const preserved: ManifestEntry[] = []

  for (const entry of [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const source = entrySource(entry, 'Installed by wrkrs')
    if (entry.management === 'referenced') {
      preserved.push(entry)
      operations.push(
        passiveOperation(
          { ...source, reason: 'Pre-existing file referenced by wrkrs; never removed' },
          'preserve',
          snapshot.targets.get(entry.path)?.file ?? undefined,
        ),
      )
      continue
    }
    const blocked = pathConflict(entry.path, snapshot)
    if (blocked) {
      preserved.push(entry)
      operations.push(blockedOperation(source, undefined, blocked))
      continue
    }
    const file = snapshot.targets.get(entry.path)?.file ?? undefined
    if (!file) {
      operations.push(passiveOperation({ ...source, reason: 'Already absent' }, 'no-op', undefined))
      continue
    }
    const stateConflict = fileStateConflict(entry.path, file)
    if (stateConflict) {
      preserved.push(entry)
      operations.push(blockedOperation(source, file, stateConflict))
      continue
    }
    if (file.hash !== entry.lastAppliedHash) {
      preserved.push(entry)
      operations.push(
        passiveOperation(
          {
            ...source,
            reason:
              entry.management === 'seeded'
                ? 'Customized after installation; the customization is preserved'
                : 'Changed since wrkrs last applied it; the change is preserved',
          },
          'preserve',
          file,
        ),
      )
      continue
    }
    operations.push(removeOperation(source, file, contents.get(entry.path) ?? ''))
  }

  const now = formatTimestamp(input.clock.now())
  const complete = preserved.length === 0
  const manifestSource: OperationSource = {
    path: MANIFEST_PATH,
    component: CORE_COMPONENT,
    reason: complete
      ? 'Ownership manifest; nothing owned remains'
      : 'Reduced ownership manifest listing only what was preserved',
    management: 'managed',
    sourceId: MANIFEST_SOURCE_ID,
    sourceVersion: MANIFEST_SCHEMA_VERSION,
  }
  const manifestFile = snapshot.targets.get(MANIFEST_PATH)?.file ?? undefined
  const currentManifest = contents.get(MANIFEST_PATH) ?? ''

  // Paths that must survive; a directory holding one of them is never removed.
  const survivors = preserved.map((entry) => entry.path)
  if (!complete) survivors.push(MANIFEST_PATH)

  if (!manifestFile) {
    operations.push(
      passiveOperation({ ...manifestSource, reason: 'Already absent' }, 'no-op', undefined),
    )
  } else {
    const stateConflict = fileStateConflict(MANIFEST_PATH, manifestFile)
    if (stateConflict) {
      operations.push(blockedOperation(manifestSource, manifestFile, stateConflict))
      survivors.push(MANIFEST_PATH)
    } else if (complete) {
      operations.push(removeOperation(manifestSource, manifestFile, currentManifest))
    } else {
      const reduced: OwnershipManifest = {
        ...manifest,
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        state: 'partial-uninstall',
        wrkrsVersion: input.wrkrsVersion,
        updatedAt: now,
        entries: preserved,
        createdDirectories: manifest.createdDirectories.filter((directory) =>
          survivors.some((path) => path === directory || path.startsWith(`${directory}/`)),
        ),
      }
      operations.push(
        replaceOperation(manifestSource, manifestFile, currentManifest, serializeManifest(reduced)),
      )
    }
  }

  const removedDirectories = [...manifest.createdDirectories]
    .filter(
      (directory) =>
        !survivors.some((path) => path === directory || path.startsWith(`${directory}/`)),
    )
    // Deepest first, so a parent is only attempted once its children are gone;
    // paths at the same depth are ordered by name for a stable plan.
    .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1))

  const notices: Finding[] = []
  if (!complete) {
    notices.push(
      createFinding(
        'UNINSTALL_PARTIAL',
        'warning',
        `${preserved.length} owned file(s) changed since wrkrs applied them and are preserved; a reduced manifest records them`,
        { path: WRKRS_DIRECTORY, evidence: [{ key: 'preserved', value: preserved.length }] },
      ),
    )
  }
  for (const entry of preserved) {
    notices.push(
      createFinding('UNINSTALL_PRESERVED', 'info', 'Preserved; wrkrs did not remove it', {
        path: entry.path,
        evidence: [{ key: 'management', value: entry.management }],
      }),
    )
  }

  return finishPlan({
    command: 'uninstall',
    input,
    operations,
    notices,
    createdDirectories: [],
    removedDirectories,
    now,
  })
}

/**
 * Sorts operations, collects blockers, and computes the digest. A conflict
 * raised here is informational unless it is attached to an operation as a
 * blocker: preserved drift never stops a lifecycle command.
 */
function finishPlan(input: {
  command: PlanCommand
  input: LifecyclePlanInput & { roster: RosterRecommendation }
  operations: PlanOperation[]
  /** Non-blocking observations reported beside the plan; never stop a command. */
  notices: readonly Finding[]
  createdDirectories: readonly string[]
  removedDirectories: readonly string[]
  now: string
}): InstallPlan {
  const operations = sortOperations(input.operations)
  const blockers = sortConflicts(
    operations.flatMap((operation) => (operation.blocker ? [operation.blocker] : [])),
  )
  const withoutDigest: Omit<InstallPlan, 'digest'> = {
    schemaVersion: 1,
    command: input.command,
    wrkrsVersion: input.input.wrkrsVersion,
    repositoryRoot: input.input.snapshot.root,
    createdAt: input.now,
    installationId: input.input.manifest.installationId,
    findings: sortFindings([...input.input.findings, ...input.notices]),
    roster: input.input.roster,
    operations,
    blockers,
    createdDirectories: [...input.createdDirectories],
    removedDirectories: [...input.removedDirectories],
    manifestPath: MANIFEST_PATH,
  }
  return { ...withoutDigest, digest: computePlanDigest(withoutDigest) }
}
