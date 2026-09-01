import type { CheckReport } from '../../check/check.js'
import type { WrkrsError } from '../../core/errors.js'
import type { InstallPlan, PlanOperation } from '../../core/plan.js'
import type { ApplyResult } from '../../writer/transaction.js'

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function operationToJson(operation: PlanOperation): Record<string, JsonValue> {
  return {
    path: operation.path,
    outcome: operation.outcome,
    component: operation.component,
    reason: operation.reason,
    management: operation.management,
    sourceId: operation.sourceId,
    sourceVersion: operation.sourceVersion,
    expected: { ...operation.expected },
    proposedHash: operation.proposedHash,
    proposedSize: operation.proposedSize,
    mode: operation.mode === null ? null : operation.mode.toString(8),
    diff: operation.diff,
    blocker: operation.blocker ? { ...operation.blocker } : null,
  }
}

/** Serializable plan: no bytes, no terminal styling, stable key order. */
export function planToJson(plan: InstallPlan): Record<string, JsonValue> {
  const counts: Record<string, number> = {}
  for (const operation of plan.operations) {
    counts[operation.outcome] = (counts[operation.outcome] ?? 0) + 1
  }
  return {
    schemaVersion: plan.schemaVersion,
    command: plan.command,
    wrkrsVersion: plan.wrkrsVersion,
    digest: plan.digest,
    createdAt: plan.createdAt,
    installationId: plan.installationId,
    findings: plan.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      path: finding.path,
      evidence: finding.evidence.map((item) => ({ key: item.key, value: item.value })),
    })),
    roster: {
      presetId: plan.roster.presetId,
      presetVersion: plan.roster.presetVersion,
      primaryRoleId: plan.roster.primaryRoleId,
      roles: plan.roster.roles.map((role) => ({
        id: role.id,
        title: role.title,
        primary: role.primary,
        source: role.source,
        reason: role.reason,
        specializations: role.specializations.map((specialization) => ({
          id: specialization.id,
          title: specialization.title,
          evidence: specialization.evidence.map((item) => ({ ...item })),
        })),
      })),
    },
    summary: counts,
    operations: plan.operations.map(operationToJson),
    blockers: plan.blockers.map((blocker) => ({ ...blocker })),
    createdDirectories: [...plan.createdDirectories],
    removedDirectories: [...plan.removedDirectories],
    manifestPath: plan.manifestPath,
  }
}

export function applyResultToJson(result: ApplyResult): Record<string, JsonValue> {
  switch (result.status) {
    case 'applied':
      return {
        status: 'applied',
        transactionId: result.transactionId,
        appliedPaths: [...result.appliedPaths],
        removedPaths: [...result.removedPaths],
        createdDirectories: [...result.createdDirectories],
        removedDirectories: [...result.removedDirectories],
        durability: result.durability,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          details: { ...diagnostic.details },
        })),
      }
    case 'aborted':
      return { status: 'aborted', conflicts: result.conflicts.map((conflict) => ({ ...conflict })) }
    case 'rolled-back':
      return {
        status: 'rolled-back',
        transactionId: result.transactionId,
        failure: result.failure,
        conflict: result.conflict ? { ...result.conflict } : null,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          details: { ...diagnostic.details },
        })),
      }
    case 'rollback-incomplete':
      return {
        status: 'rollback-incomplete',
        transactionId: result.transactionId,
        failure: result.failure,
        conflict: result.conflict ? { ...result.conflict } : null,
        retained: result.retained.map((item) => ({ ...item })),
        journalPath: result.journalPath,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          details: { ...diagnostic.details },
        })),
      }
  }
}

export function checkToJson(report: CheckReport, wrkrsVersion: string): Record<string, JsonValue> {
  return {
    schemaVersion: 1,
    command: 'check',
    wrkrsVersion,
    repositoryRoot: report.repositoryRoot,
    ok: report.ok,
    summary: { ...report.summary },
    diagnostics: report.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      path: diagnostic.path,
      remediation: diagnostic.remediation,
      details: { ...diagnostic.details },
    })),
  }
}

export function errorToJson(error: WrkrsError): Record<string, JsonValue> {
  return { code: error.code, message: error.message, details: { ...error.details } }
}

export function renderJson(value: Record<string, JsonValue>): string {
  return JSON.stringify(value, null, 2) + '\n'
}
