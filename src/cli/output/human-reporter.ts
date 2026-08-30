import type { CheckReport } from '../../check/check.js'
import type { Diagnostic } from '../../core/diagnostics.js'
import type { WrkrsError } from '../../core/errors.js'
import type { Finding } from '../../core/findings.js'
import type { InstallPlan, PlanOperation, PlanOutcome } from '../../core/plan.js'
import type { ApplyResult } from '../../writer/transaction.js'

export interface Styler {
  bold(text: string): string
  dim(text: string): string
  green(text: string): string
  yellow(text: string): string
  red(text: string): string
  cyan(text: string): string
}

const ESC = String.fromCharCode(27)

export function createStyler(colors: boolean): Styler {
  const wrap = (open: number, close: number) => (text: string) =>
    colors ? `${ESC}[${open}m${text}${ESC}[${close}m` : text
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    cyan: wrap(36, 39),
  }
}

const OUTCOME_ORDER: readonly PlanOutcome[] = [
  'create',
  'structural-merge',
  'reuse',
  'preserve',
  'no-op',
  'block',
]

function severityLabel(
  style: Styler,
  severity: Finding['severity'] | Diagnostic['severity'],
): string {
  switch (severity) {
    case 'blocker':
    case 'error':
      return style.red(severity.padEnd(7))
    case 'warning':
      return style.yellow(severity.padEnd(7))
    default:
      return style.dim(severity.padEnd(7))
  }
}

function outcomeLabel(style: Styler, outcome: PlanOutcome): string {
  const text = outcome.padEnd(16)
  switch (outcome) {
    case 'create':
      return style.green(text)
    case 'block':
      return style.red(text)
    case 'reuse':
    case 'structural-merge':
      return style.cyan(text)
    default:
      return style.dim(text)
  }
}

function renderFindings(findings: readonly Finding[], style: Styler): string[] {
  if (findings.length === 0) return ['  (none)']
  return findings.map((finding) => {
    const evidence = finding.evidence.map((item) => `${item.key}=${String(item.value)}`).join(' ')
    return `  ${severityLabel(style, finding.severity)} ${finding.code.padEnd(34)} ${finding.path ?? '-'}${evidence ? style.dim('  ' + evidence) : ''}`
  })
}

/** Renders the dry-run presentation in the order fixed by the architecture. */
export function renderPlan(plan: InstallPlan, style: Styler, options: { dryRun: boolean }): string {
  const lines: string[] = []
  lines.push(
    style.bold(`wrkrs init${options.dryRun ? ' (dry run)' : ''} — wrkrs ${plan.wrkrsVersion}`),
  )
  lines.push(`Repository: ${plan.repositoryRoot}`)
  lines.push('')

  lines.push(style.bold('Findings'))
  lines.push(...renderFindings(plan.findings, style))
  lines.push('')

  lines.push(
    style.bold(`Recommended roster (${plan.roster.presetId} v${plan.roster.presetVersion})`),
  )
  for (const role of plan.roster.roles) {
    const marker = role.primary ? style.cyan('primary') : '       '
    lines.push(`  ${marker} ${role.id.padEnd(18)} ${style.dim(role.title)}`)
    for (const specialization of role.specializations) {
      const evidence = specialization.evidence
        .map((item) => `${item.path}: ${item.detail}`)
        .join(', ')
      lines.push(`          specialization ${specialization.id.padEnd(16)} ${style.dim(evidence)}`)
    }
    if (role.id === 'software-engineer' && role.specializations.length === 0) {
      lines.push(`          ${style.dim('no specialization detected')}`)
    }
  }
  lines.push('')

  lines.push(style.bold('Planned paths'))
  const grouped = new Map<PlanOutcome, PlanOperation[]>()
  for (const operation of plan.operations) {
    grouped.set(operation.outcome, [...(grouped.get(operation.outcome) ?? []), operation])
  }
  for (const outcome of OUTCOME_ORDER) {
    for (const operation of grouped.get(outcome) ?? []) {
      const management = operation.management ? style.dim(`[${operation.management}]`) : ''
      lines.push(`  ${outcomeLabel(style, outcome)} ${operation.path.padEnd(48)} ${management}`)
    }
  }
  if (plan.createdDirectories.length > 0) {
    lines.push(`  ${style.dim('directories to create: ' + plan.createdDirectories.join(', '))}`)
  }
  lines.push('')

  const creates = plan.operations.filter((operation) => operation.outcome === 'create')
  lines.push(style.bold(`Diffs (${creates.length} new files)`))
  for (const operation of creates) {
    lines.push(
      style.dim(`# ${operation.path} (${operation.proposedSize} bytes, ${operation.proposedHash})`),
    )
    for (const line of (operation.diff ?? '').split('\n')) {
      if (line === '') continue
      if (line.startsWith('+++') || line.startsWith('---')) lines.push(style.bold(line))
      else if (line.startsWith('@@')) lines.push(style.cyan(line))
      else if (line.startsWith('+')) lines.push(style.green(line))
      else lines.push(line)
    }
    lines.push('')
  }

  lines.push(style.bold('Ownership'))
  const byManagement = new Map<string, string[]>()
  for (const operation of plan.operations) {
    if (!operation.management || (operation.outcome !== 'create' && operation.outcome !== 'reuse'))
      continue
    byManagement.set(operation.management, [
      ...(byManagement.get(operation.management) ?? []),
      operation.path,
    ])
  }
  if (byManagement.size === 0) lines.push('  (no ownership recorded)')
  for (const [management, paths] of [...byManagement.entries()].sort()) {
    lines.push(`  ${management.padEnd(10)} ${paths.join(', ')}`)
  }
  lines.push('')

  const warnings = plan.findings.filter((finding) => finding.severity === 'warning')
  lines.push(style.bold('Warnings and blockers'))
  if (warnings.length === 0 && plan.blockers.length === 0) lines.push('  (none)')
  for (const warning of warnings) {
    lines.push(
      `  ${style.yellow('warning')} ${warning.code}${warning.path ? ` ${warning.path}` : ''}: ${warning.message}`,
    )
  }
  for (const blocker of plan.blockers) {
    lines.push(
      `  ${style.red('blocker')} ${blocker.code}${blocker.path ? ` ${blocker.path}` : ''}: ${blocker.message}`,
    )
    lines.push(`          ${style.dim(blocker.remediation)}`)
  }
  lines.push('')
  lines.push(`Plan digest: ${plan.digest}`)
  return lines.join('\n') + '\n'
}

export function renderApplyResult(result: ApplyResult, style: Styler): string {
  const lines: string[] = []
  switch (result.status) {
    case 'applied':
      lines.push(
        style.green(style.bold('Installed wrkrs')) +
          ` (transaction ${result.transactionId || 'none'})`,
      )
      for (const path of result.appliedPaths) lines.push(`  created ${path}`)
      for (const diagnostic of result.diagnostics.filter((item) => item.severity === 'warning')) {
        lines.push(`  ${style.yellow('warning')} ${diagnostic.code}: ${diagnostic.message}`)
      }
      lines.push('')
      lines.push(
        'Next: run `wrkrs check`, review the generated files, and invoke the `/wrkrs` skill from Claude Code with the outcome you want.',
      )
      lines.push('wrkrs did not commit anything; the working tree is yours to review.')
      break
    case 'aborted':
      lines.push(style.red(style.bold('Installation aborted before any change was made')))
      for (const conflict of result.conflicts) {
        lines.push(
          `  ${style.red(conflict.code)}${conflict.path ? ` ${conflict.path}` : ''}: ${conflict.message}`,
        )
        lines.push(`    ${style.dim(conflict.remediation)}`)
      }
      break
    case 'rolled-back':
      lines.push(
        style.red(style.bold('Installation failed and was rolled back')) +
          ` (transaction ${result.transactionId})`,
      )
      lines.push(`  ${result.failure}`)
      if (result.conflict) {
        lines.push(
          `  ${style.red(result.conflict.code)}${result.conflict.path ? ` ${result.conflict.path}` : ''}: ${result.conflict.message}`,
        )
        lines.push(`    ${style.dim(result.conflict.remediation)}`)
      }
      for (const diagnostic of result.diagnostics.filter((item) => item.severity === 'error')) {
        lines.push(
          `  ${style.red('error')} ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ''}: ${diagnostic.message}`,
        )
      }
      lines.push('  The repository was restored to its pre-install state.')
      break
    case 'rollback-incomplete':
      lines.push(
        style.red(style.bold('Installation failed and rollback could not remove every path')) +
          ` (transaction ${result.transactionId})`,
      )
      lines.push(`  ${result.failure}`)
      if (result.conflict) {
        lines.push(
          `  ${style.red(result.conflict.code)}${result.conflict.path ? ` ${result.conflict.path}` : ''}: ${result.conflict.message}`,
        )
        lines.push(`    ${style.dim(result.conflict.remediation)}`)
      }
      lines.push('  Retained paths (not deleted because they changed or could not be removed):')
      for (const item of result.retained) lines.push(`    ${item.path}: ${item.reason}`)
      lines.push(
        `  Recovery: review the paths above, restore or remove them, then delete ${result.journalPath}.`,
      )
      break
  }
  return lines.join('\n') + '\n'
}

export function renderCheck(report: CheckReport, style: Styler, wrkrsVersion: string): string {
  const lines: string[] = []
  lines.push(style.bold(`wrkrs check — wrkrs ${wrkrsVersion}`))
  if (report.repositoryRoot) lines.push(`Repository: ${report.repositoryRoot}`)
  lines.push('')
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `  ${severityLabel(style, diagnostic.severity)} ${diagnostic.code.padEnd(34)} ${diagnostic.path ?? '-'}`,
    )
    lines.push(`          ${diagnostic.message}`)
    if (diagnostic.remediation && diagnostic.severity !== 'info') {
      lines.push(`          ${style.dim('→ ' + diagnostic.remediation)}`)
    }
  }
  lines.push('')
  const { errors, warnings, infos } = report.summary
  const status = report.ok ? style.green('OK') : style.red('FAILED')
  lines.push(`${status}: ${errors} error(s), ${warnings} warning(s), ${infos} info`)
  return lines.join('\n') + '\n'
}

export function renderError(error: WrkrsError, style: Styler): string {
  return `${style.red('error')} ${error.code}: ${error.message}\n`
}
