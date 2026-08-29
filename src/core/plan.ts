import type { Finding } from './findings.js'
import type { ManagementMode } from './ownership.js'
import type { RosterRecommendation } from './roster.js'

export const PLAN_OUTCOMES = [
  'create',
  'structural-merge',
  'reuse',
  'preserve',
  'no-op',
  'block',
] as const

export type PlanOutcome = (typeof PLAN_OUTCOMES)[number]

export type ConflictFamily =
  | 'PATH'
  | 'OWNERSHIP'
  | 'COMPONENT'
  | 'FORMAT'
  | 'SECURITY'
  | 'PRECONDITION'
  | 'CUSTOMIZATION'
  | 'ENVIRONMENT'
  | 'GIT'

export interface Conflict {
  readonly code: string
  readonly family: ConflictFamily
  readonly path: string | null
  readonly message: string
  readonly remediation: string
}

export type ExpectedState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly hash: string; readonly mode: number }
  | { readonly kind: 'directory' }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'other' }

/** A desired component is exact proposed content produced by the core or an adapter. */
export interface DesiredComponent {
  readonly path: string
  readonly content: string
  readonly management: Extract<ManagementMode, 'managed' | 'seeded'>
  readonly sourceId: string
  readonly sourceVersion: number
  readonly component: string
  readonly reason: string
}

export interface PlanOperation {
  readonly path: string
  readonly outcome: PlanOutcome
  readonly component: string
  readonly reason: string
  readonly management: ManagementMode | null
  readonly sourceId: string | null
  readonly sourceVersion: number | null
  readonly expected: ExpectedState
  readonly proposedHash: string | null
  readonly proposedSize: number | null
  readonly proposedBytes: Uint8Array | null
  readonly mode: number | null
  readonly diff: string | null
  readonly blocker: Conflict | null
}

export interface InstallPlan {
  readonly schemaVersion: 1
  readonly command: 'init'
  readonly wrkrsVersion: string
  readonly repositoryRoot: string
  readonly createdAt: string
  readonly installationId: string
  readonly findings: readonly Finding[]
  readonly roster: RosterRecommendation
  readonly operations: readonly PlanOperation[]
  readonly blockers: readonly Conflict[]
  readonly createdDirectories: readonly string[]
  readonly manifestPath: string
  readonly digest: string
}

export function mutatingOperations(plan: InstallPlan): PlanOperation[] {
  return plan.operations.filter((operation) => operation.outcome === 'create')
}

export function isBlocked(plan: InstallPlan): boolean {
  return plan.blockers.length > 0
}
