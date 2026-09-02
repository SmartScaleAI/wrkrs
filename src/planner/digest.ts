import type { InstallPlan, PlanOperation } from '../core/plan.js'
import { hashCanonicalJson } from '../platform/hash.js'

export const MANIFEST_SOURCE_ID = 'wrkrs/manifest'

/**
 * Deterministic digest over the semantic plan. Excludes the repository root,
 * timestamps, the installation identifier, and the manifest bytes (which
 * embed the identifier and timestamps) so two plans for the same desired
 * change hash identically across machines and runs.
 */
export function computePlanDigest(plan: Omit<InstallPlan, 'digest'>): string {
  return hashCanonicalJson({
    schemaVersion: plan.schemaVersion,
    command: plan.command,
    wrkrsVersion: plan.wrkrsVersion,
    roster: {
      presetId: plan.roster.presetId,
      presetVersion: plan.roster.presetVersion,
      primaryRoleId: plan.roster.primaryRoleId,
      roles: plan.roster.roles.map((role) => ({
        id: role.id,
        primary: role.primary,
        source: role.source,
        specializations: role.specializations.map((specialization) => ({
          id: specialization.id,
          evidence: specialization.evidence,
        })),
      })),
    },
    operations: plan.operations.map(semanticOperation),
    blockers: plan.blockers,
    createdDirectories: plan.createdDirectories,
    removedDirectories: plan.removedDirectories,
  })
}

function semanticOperation(operation: PlanOperation): Record<string, unknown> {
  const isManifest = operation.sourceId === MANIFEST_SOURCE_ID
  return {
    path: operation.path,
    outcome: operation.outcome,
    component: operation.component,
    reason: operation.reason,
    management: operation.management,
    sourceId: operation.sourceId,
    sourceVersion: operation.sourceVersion,
    expected: operation.expected,
    proposedHash: isManifest ? null : operation.proposedHash,
    mode: operation.mode,
    blocker: operation.blocker,
  }
}
