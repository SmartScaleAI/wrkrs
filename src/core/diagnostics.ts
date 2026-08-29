/**
 * Diagnostics are the output of `wrkrs check` and of post-apply validation.
 * Codes are stable identifiers; severities drive exit codes.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  readonly code: string
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly path: string | null
  readonly remediation: string | null
  readonly details: Readonly<Record<string, string | number | boolean>>
}

export interface DiagnosticSummary {
  readonly errors: number
  readonly warnings: number
  readonly infos: number
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 }

export function createDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  options: {
    path?: string | null
    remediation?: string | null
    details?: Record<string, string | number | boolean>
  } = {},
): Diagnostic {
  return {
    code,
    severity,
    message,
    path: options.path ?? null,
    remediation: options.remediation ?? null,
    details: options.details ?? {},
  }
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (rank !== 0) return rank
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const pa = a.path ?? ''
    const pb = b.path ?? ''
    if (pa !== pb) return pa < pb ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}

export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticSummary {
  let errors = 0
  let warnings = 0
  let infos = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1
    else if (diagnostic.severity === 'warning') warnings += 1
    else infos += 1
  }
  return { errors, warnings, infos }
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
}
