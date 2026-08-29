/**
 * Findings describe what the read-only repository scan observed. They are
 * deterministic, bounded, and free of secret values.
 */
export type FindingSeverity = 'info' | 'warning' | 'blocker'

export interface FindingEvidence {
  readonly key: string
  readonly value: string | number | boolean
}

export interface Finding {
  readonly code: string
  readonly severity: FindingSeverity
  readonly message: string
  readonly path: string | null
  readonly evidence: readonly FindingEvidence[]
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { blocker: 0, warning: 1, info: 2 }

export function createFinding(
  code: string,
  severity: FindingSeverity,
  message: string,
  options: { path?: string | null; evidence?: readonly FindingEvidence[] } = {},
): Finding {
  return {
    code,
    severity,
    message,
    path: options.path ?? null,
    evidence: options.evidence ?? [],
  }
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (rank !== 0) return rank
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const pa = a.path ?? ''
    const pb = b.path ?? ''
    if (pa !== pb) return pa < pb ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}
