import { serializeManifest } from '../config/serialize.js'
import type { Finding } from '../core/findings.js'
import {
  JOURNAL_PATH,
  LOCK_PATH,
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  WRKRS_DIRECTORY,
  type ManifestEntry,
  type OwnershipManifest,
} from '../core/ownership.js'
import type { Conflict, DesiredComponent, InstallPlan, PlanOperation } from '../core/plan.js'
import type { ClockPort, IdPort } from '../core/ports.js'
import type { RosterRecommendation } from '../core/roster.js'
import type { PreservedComponent } from '../core/runtime-adapter.js'
import type { FileSnapshot, RepositorySnapshot } from '../core/snapshot.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories, caseFoldKey, normalizeRelativePath } from '../platform/paths.js'
import { formatTimestamp } from '../platform/clock.js'
import { conflict, FUTURE_UPDATE_REMEDIATION, sortConflicts } from './conflicts.js'
import { computePlanDigest, MANIFEST_SOURCE_ID } from './digest.js'
import {
  blockedOperation,
  createOperation,
  passiveOperation,
  sortOperations,
  type OperationSource,
} from './operations.js'

export interface InitPlanInput {
  readonly snapshot: RepositorySnapshot
  readonly roster: RosterRecommendation
  readonly desired: readonly DesiredComponent[]
  readonly preserved: readonly PreservedComponent[]
  readonly findings: readonly Finding[]
  readonly wrkrsVersion: string
  readonly runtimeAdapters: readonly { readonly id: string; readonly version: number }[]
  readonly clock: ClockPort
  readonly ids: IdPort
}

const CORE_COMPONENT = 'wrkrs'

function globalConflicts(snapshot: RepositorySnapshot): Conflict[] {
  const conflicts: Conflict[] = []
  const wrkrs = snapshot.wrkrs
  if (wrkrs.directoryKind === null) return conflicts
  if (wrkrs.directoryKind !== 'directory') {
    conflicts.push(
      conflict(
        'PATH',
        'PATH_WRKRS_NOT_A_DIRECTORY',
        WRKRS_DIRECTORY,
        `.wrkrs exists but is a ${wrkrs.directoryKind}`,
        'Move the existing path aside before running wrkrs init',
      ),
    )
    return conflicts
  }
  if (wrkrs.journal) {
    conflicts.push(
      conflict(
        'OWNERSHIP',
        'OWNERSHIP_TRANSACTION_INTERRUPTED',
        JOURNAL_PATH,
        `An interrupted wrkrs transaction (${wrkrs.journal.transactionId ?? 'unknown id'}, status ${wrkrs.journal.status ?? 'unknown'}) is present`,
        'Inspect the journal, restore or remove the listed paths, then delete the journal before retrying',
      ),
    )
  }
  if (wrkrs.lockPresent) {
    conflicts.push(
      conflict(
        'OWNERSHIP',
        'OWNERSHIP_LOCK_PRESENT',
        LOCK_PATH,
        'A wrkrs installation lock is present',
        'Ensure no other wrkrs process is running, then remove the stale lock file',
      ),
    )
  }
  if (!wrkrs.manifest) {
    conflicts.push(
      conflict(
        'OWNERSHIP',
        'OWNERSHIP_MANIFEST_MISSING',
        WRKRS_DIRECTORY,
        '.wrkrs exists without an ownership manifest, so wrkrs cannot tell what it owns',
        'Remove or rename the existing .wrkrs directory, or restore its manifest.json from version control',
      ),
    )
  } else if (!wrkrs.manifest.valid) {
    conflicts.push(
      conflict(
        'OWNERSHIP',
        'OWNERSHIP_MANIFEST_INVALID',
        MANIFEST_PATH,
        `The existing ownership manifest is invalid: ${wrkrs.manifest.error ?? 'unknown error'}`,
        'Restore a valid manifest.json from version control or remove the .wrkrs directory',
      ),
    )
  }
  return conflicts
}

function ancestorConflict(path: string, files: ReadonlyMap<string, FileSnapshot>): Conflict | null {
  for (const ancestor of ancestorDirectories(path)) {
    const existing = files.get(ancestor)
    if (!existing) continue
    if (existing.kind === 'symlink') {
      return conflict(
        'PATH',
        'PATH_ANCESTOR_SYMLINK',
        path,
        `Parent directory "${ancestor}" is a symlink; wrkrs does not write through symlinks`,
        'Replace the symlink with a real directory or move it aside',
      )
    }
    if (existing.kind !== 'directory') {
      return conflict(
        'PATH',
        'PATH_ANCESTOR_NOT_A_DIRECTORY',
        path,
        `Parent path "${ancestor}" exists and is a ${existing.kind}`,
        'Move the conflicting path aside before running wrkrs init',
      )
    }
  }
  return null
}

function classifyDesired(
  component: DesiredComponent,
  snapshot: RepositorySnapshot,
  installation: OwnershipManifest | null,
): PlanOperation {
  const source: OperationSource = {
    path: component.path,
    component: component.component,
    reason: component.reason,
    management: component.management,
    sourceId: component.sourceId,
    sourceVersion: component.sourceVersion,
  }
  const normalized = normalizeRelativePath(component.path)
  if (!normalized.ok || normalized.value !== component.path) {
    return blockedOperation(
      source,
      undefined,
      conflict(
        'PATH',
        normalized.ok ? 'PATH_NOT_NORMALIZED' : normalized.error.code,
        component.path,
        normalized.ok
          ? 'Planned path is not in normalized repository-relative form'
          : normalized.error.message,
        'This is an internal planning error; report it with the plan digest',
      ),
    )
  }
  const existing = snapshot.files.get(component.path)
  const ancestor = ancestorConflict(component.path, snapshot.files)
  if (ancestor) return blockedOperation(source, existing, ancestor)

  const proposedHash = sha256(new TextEncoder().encode(component.content))
  const entry = installation?.entries.find((candidate) => candidate.path === component.path)

  if (!existing) {
    if (installation) {
      return blockedOperation(
        source,
        existing,
        conflict(
          'OWNERSHIP',
          'OWNERSHIP_EXISTING_INSTALLATION',
          component.path,
          'The file is missing from an existing wrkrs installation',
          FUTURE_UPDATE_REMEDIATION,
        ),
      )
    }
    return createOperation(source, component.content)
  }
  if (existing.kind === 'symlink') {
    return blockedOperation(
      source,
      existing,
      conflict(
        'PATH',
        'PATH_TARGET_SYMLINK',
        component.path,
        'The target path is a symlink',
        'Remove the symlink or move it aside; wrkrs never writes through symlinks',
      ),
    )
  }
  if (existing.kind !== 'file') {
    return blockedOperation(
      source,
      existing,
      conflict(
        'PATH',
        'PATH_TARGET_NOT_A_FILE',
        component.path,
        `The target path exists and is a ${existing.kind}`,
        'Move the conflicting path aside before running wrkrs init',
      ),
    )
  }
  if (!existing.hash) {
    return blockedOperation(
      source,
      existing,
      conflict(
        'FORMAT',
        'FORMAT_UNINSPECTABLE_TARGET',
        component.path,
        'The existing file is too large to inspect safely',
        'Move the file aside before running wrkrs init',
      ),
    )
  }
  if (existing.hash === proposedHash) {
    if (installation) {
      if (entry) {
        return passiveOperation(
          { ...source, reason: 'Already installed and unchanged' },
          'no-op',
          existing,
        )
      }
      return blockedOperation(
        source,
        existing,
        conflict(
          'OWNERSHIP',
          'OWNERSHIP_EXISTING_INSTALLATION',
          component.path,
          'Identical content exists but is not recorded by the existing installation',
          FUTURE_UPDATE_REMEDIATION,
        ),
      )
    }
    return passiveOperation(
      {
        ...source,
        management: 'referenced',
        reason: 'Identical content already exists; it is referenced, not owned',
      },
      'reuse',
      existing,
    )
  }
  if (installation && entry) {
    if (entry.management === 'seeded') {
      return passiveOperation(
        { ...source, reason: 'Seeded file was customized after installation and is preserved' },
        'preserve',
        existing,
      )
    }
    return blockedOperation(
      source,
      existing,
      conflict(
        'CUSTOMIZATION',
        'CUSTOMIZATION_MANAGED_DRIFT',
        component.path,
        'A managed file drifted from the content wrkrs last applied',
        FUTURE_UPDATE_REMEDIATION,
      ),
    )
  }
  return blockedOperation(
    source,
    existing,
    conflict(
      'COMPONENT',
      'COMPONENT_CONTENT_DIFFERS',
      component.path,
      'A file already exists at this namespaced path with different content',
      'Review the existing file; move it aside or rename it before running wrkrs init',
    ),
  )
}

function caseCollisionConflicts(
  operations: readonly PlanOperation[],
  files: ReadonlyMap<string, FileSnapshot>,
): Map<string, Conflict> {
  const conflicts = new Map<string, Conflict>()
  const existingByFold = new Map<string, string[]>()
  for (const path of files.keys()) {
    const key = caseFoldKey(path)
    existingByFold.set(key, [...(existingByFold.get(key) ?? []), path])
  }
  const plannedByFold = new Map<string, string[]>()
  const creates = operations.filter((operation) => operation.outcome === 'create')
  for (const operation of creates) {
    for (const candidate of [operation.path, ...ancestorDirectories(operation.path)]) {
      const key = caseFoldKey(candidate)
      const list = plannedByFold.get(key) ?? []
      if (!list.includes(candidate)) plannedByFold.set(key, [...list, candidate])
    }
  }
  for (const operation of creates) {
    for (const candidate of [operation.path, ...ancestorDirectories(operation.path)]) {
      const key = caseFoldKey(candidate)
      const clashes = [
        ...(existingByFold.get(key) ?? []),
        ...(plannedByFold.get(key) ?? []),
      ].filter((other) => other !== candidate)
      if (clashes.length === 0) continue
      const first = clashes.sort()[0] ?? ''
      conflicts.set(
        operation.path,
        conflict(
          'PATH',
          'PATH_CASE_COLLISION',
          operation.path,
          `"${candidate}" differs only by case from "${first}", which is unsafe on case-insensitive filesystems`,
          'Rename the existing path or the planned path so they no longer collide',
        ),
      )
      break
    }
  }
  return conflicts
}

/**
 * Builds the immutable, create-only installation plan for `wrkrs init`.
 */
export function buildInitPlan(input: InitPlanInput): InstallPlan {
  const { snapshot } = input
  const installation = snapshot.wrkrs.manifest?.valid ? snapshot.wrkrs.manifest.manifest : null
  const conflicts: Conflict[] = globalConflicts(snapshot)

  const desiredPaths = new Set(input.desired.map((component) => component.path))
  let operations: PlanOperation[] = [...input.desired]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((component) => classifyDesired(component, snapshot, installation))

  const collisions = caseCollisionConflicts(operations, snapshot.files)
  operations = operations.map((operation) => {
    const collision = collisions.get(operation.path)
    if (!collision || operation.outcome !== 'create') return operation
    return blockedOperation(operation, snapshot.files.get(operation.path), collision)
  })

  for (const preserved of input.preserved) {
    if (desiredPaths.has(preserved.path)) continue
    operations.push(
      passiveOperation(
        {
          path: preserved.path,
          component: 'claude-code',
          reason: preserved.description,
          management: null,
          sourceId: null,
          sourceVersion: null,
        },
        'preserve',
        snapshot.files.get(preserved.path),
      ),
    )
  }

  const creates = operations.filter((operation) => operation.outcome === 'create')
  const reuses = operations.filter((operation) => operation.outcome === 'reuse')

  const createdDirectorySet = new Set<string>()
  for (const operation of creates) {
    for (const ancestor of ancestorDirectories(operation.path)) {
      if (!snapshot.files.has(ancestor)) createdDirectorySet.add(ancestor)
    }
  }
  if (!installation && (creates.length > 0 || reuses.length > 0)) {
    for (const ancestor of ancestorDirectories(MANIFEST_PATH)) {
      if (!snapshot.files.has(ancestor)) createdDirectorySet.add(ancestor)
    }
  }
  const createdDirectories = [...createdDirectorySet].sort(
    (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
  )

  const now = formatTimestamp(input.clock.now())
  const installationId = input.ids.uuid()
  const entries: ManifestEntry[] = [
    ...creates
      .filter((operation) => operation.management !== null && operation.sourceId !== null)
      .map((operation): ManifestEntry => ({
        path: operation.path,
        kind: 'file',
        management: operation.management as ManifestEntry['management'],
        sourceId: operation.sourceId as string,
        sourceVersion: operation.sourceVersion ?? 1,
        lastAppliedHash: operation.proposedHash as string,
      })),
    ...reuses.map((operation): ManifestEntry => ({
      path: operation.path,
      kind: 'file',
      management: 'referenced',
      sourceId: operation.sourceId as string,
      sourceVersion: operation.sourceVersion ?? 1,
      lastAppliedHash: operation.expected.kind === 'file' ? operation.expected.hash : '',
    })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  if (!installation && (creates.length > 0 || reuses.length > 0)) {
    const manifest: OwnershipManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      installationId,
      wrkrsVersion: input.wrkrsVersion,
      installedAt: now,
      updatedAt: now,
      preset: { id: input.roster.presetId, version: input.roster.presetVersion },
      runtimeAdapters: input.runtimeAdapters,
      entries,
      createdDirectories,
    }
    const existingManifest = snapshot.files.get(MANIFEST_PATH)
    const manifestSource: OperationSource = {
      path: MANIFEST_PATH,
      component: CORE_COMPONENT,
      reason: 'Ownership manifest recording exactly what wrkrs installed',
      management: 'managed',
      sourceId: MANIFEST_SOURCE_ID,
      sourceVersion: MANIFEST_SCHEMA_VERSION,
    }
    if (existingManifest) {
      operations.push(
        blockedOperation(
          manifestSource,
          existingManifest,
          conflict(
            'OWNERSHIP',
            'OWNERSHIP_MANIFEST_UNEXPECTED',
            MANIFEST_PATH,
            'A manifest exists but could not be used as an installation record',
            'Restore a valid manifest.json or remove the .wrkrs directory',
          ),
        ),
      )
    } else {
      operations.push(createOperation(manifestSource, serializeManifest(manifest)))
    }
  }

  operations = sortOperations(operations)
  const blockers = sortConflicts([
    ...conflicts,
    ...operations.flatMap((operation) => (operation.blocker ? [operation.blocker] : [])),
  ])

  const withoutDigest: Omit<InstallPlan, 'digest'> = {
    schemaVersion: 1,
    command: 'init',
    wrkrsVersion: input.wrkrsVersion,
    repositoryRoot: snapshot.root,
    createdAt: now,
    installationId,
    findings: input.findings,
    roster: input.roster,
    operations,
    blockers,
    createdDirectories,
    manifestPath: MANIFEST_PATH,
  }
  return { ...withoutDigest, digest: computePlanDigest(withoutDigest) }
}
