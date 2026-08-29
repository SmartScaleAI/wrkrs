import type { Conflict, ExpectedState, PlanOperation, PlanOutcome } from '../core/plan.js'
import type { ManagementMode } from '../core/ownership.js'
import type { FileSnapshot } from '../core/snapshot.js'
import { sha256 } from '../platform/hash.js'
import { renderCreateDiff } from './diff.js'

export const GENERATED_FILE_MODE = 0o644
export const GENERATED_DIRECTORY_MODE = 0o755

export function expectedStateOf(file: FileSnapshot | undefined): ExpectedState {
  if (!file) return { kind: 'absent' }
  if (file.kind === 'file' && file.hash) return { kind: 'file', hash: file.hash, mode: file.mode }
  if (file.kind === 'directory') return { kind: 'directory' }
  if (file.kind === 'symlink') return { kind: 'symlink' }
  return { kind: 'other' }
}

export interface OperationSource {
  readonly path: string
  readonly component: string
  readonly reason: string
  readonly management: ManagementMode | null
  readonly sourceId: string | null
  readonly sourceVersion: number | null
}

export function createOperation(source: OperationSource, content: string): PlanOperation {
  const bytes = new TextEncoder().encode(content)
  return {
    path: source.path,
    outcome: 'create',
    component: source.component,
    reason: source.reason,
    management: source.management,
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    expected: { kind: 'absent' },
    proposedHash: sha256(bytes),
    proposedSize: bytes.byteLength,
    proposedBytes: bytes,
    mode: GENERATED_FILE_MODE,
    diff: renderCreateDiff(source.path, content),
    blocker: null,
  }
}

export function passiveOperation(
  source: OperationSource,
  outcome: Extract<PlanOutcome, 'reuse' | 'preserve' | 'no-op'>,
  existing: FileSnapshot | undefined,
): PlanOperation {
  return {
    path: source.path,
    outcome,
    component: source.component,
    reason: source.reason,
    management: source.management,
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    expected: expectedStateOf(existing),
    proposedHash: null,
    proposedSize: null,
    proposedBytes: null,
    mode: null,
    diff: null,
    blocker: null,
  }
}

export function blockedOperation(
  source: OperationSource,
  existing: FileSnapshot | undefined,
  blocker: Conflict,
): PlanOperation {
  return {
    path: source.path,
    outcome: 'block',
    component: source.component,
    reason: source.reason,
    management: source.management,
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    expected: expectedStateOf(existing),
    proposedHash: null,
    proposedSize: null,
    proposedBytes: null,
    mode: null,
    diff: null,
    blocker,
  }
}

export function sortOperations(operations: readonly PlanOperation[]): PlanOperation[] {
  return [...operations].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
