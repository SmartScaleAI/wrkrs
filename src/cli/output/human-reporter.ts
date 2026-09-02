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
  'replace',
  'remove',
  'structural-merge',
  'reuse',
  'preserve',
  'no-op',
  'block',
]

const COMMAND_TITLE: Record<InstallPlan['command'], string> = {
  init: 'wrkrs init',
  update: 'wrkrs update',
  uninstall: 'wrkrs uninstall',
}

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
    case 'replace':
      return style.yellow(text)
    case 'remove':
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
    style.bold(
      `${COMMAND_TITLE[plan.command]}${options.dryRun ? ' (dry run)' : ''} — wrkrs ${plan.wrkrsVersion}`,
    ),
  )
  lines.push(`Repository: ${plan.repositoryRoot}`)
  lines.push('')

  lines.push(style.bold('Findings'))
  lines.push(...renderFindings(plan.findings, style))
  lines.push('')

  // An uninstall that runs after configuration is already gone has no roster
  // to show; it plans from the manifest alone.
  if (plan.roster.roles.length > 0) {
    lines.push(
      style.bold(
        `${plan.command === 'init' ? 'Recommended roster' : 'Configured roster'} (${plan.roster.presetId} v${plan.roster.presetVersion})`,
      ),
    )
  }
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
  if (plan.removedDirectories.length > 0) {
    lines.push(`  ${style.dim('directories to remove: ' + plan.removedDirectories.join(', '))}`)
  }
  lines.push('')

  const changes = plan.operations.filter(
    (operation) =>
      operation.outcome === 'create' ||
      operation.outcome === 'replace' ||
      operation.outcome === 'remove',
  )
  const counts = {
    create: changes.filter((operation) => operation.outcome === 'create').length,
    replace: changes.filter((operation) => operation.outcome === 'replace').length,
    remove: changes.filter((operation) => operation.outcome === 'remove').length,
  }
  const summary = [
    counts.create > 0 ? `${counts.create} new` : '',
    counts.replace > 0 ? `${counts.replace} changed` : '',
    counts.remove > 0 ? `${counts.remove} removed` : '',
  ]
    .filter((part) => part !== '')
    .join(', ')
  lines.push(style.bold(`Diffs (${summary === '' ? 'no file changes' : summary})`))
  for (const operation of changes) {
    const size =
      operation.outcome === 'remove'
        ? 'removed'
        : `${operation.proposedSize} bytes, ${operation.proposedHash}`
    lines.push(style.dim(`# ${operation.path} (${size})`))
    for (const line of (operation.diff ?? '').split('\n')) {
      if (line === '') continue
      if (line.startsWith('+++') || line.startsWith('---')) lines.push(style.bold(line))
      else if (line.startsWith('@@')) lines.push(style.cyan(line))
      else if (line.startsWith('+')) lines.push(style.green(line))
      else if (line.startsWith('-')) lines.push(style.red(line))
      else lines.push(line)
    }
    lines.push('')
  }

  lines.push(style.bold('Ownership'))
  const byManagement = new Map<string, string[]>()
  for (const operation of plan.operations) {
    if (
      !operation.management ||
      (operation.outcome !== 'create' &&
        operation.outcome !== 'replace' &&
        operation.outcome !== 'reuse')
    ) {
      continue
    }
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

const APPLIED_TITLE: Record<InstallPlan['command'], string> = {
  init: 'Installed wrkrs',
  update: 'Updated the wrkrs installation',
  uninstall: 'Removed the wrkrs installation',
}

const NEXT_STEPS: Record<InstallPlan['command'], readonly string[]> = {
  init: [
    'Next: run `wrkrs check`, review the generated files, and invoke the `/wrkrs` skill from Claude Code with the outcome you want.',
  ],
  update: ['Next: run `wrkrs check` and review the changed files.'],
  uninstall: ['Review the removal, then commit it when you are ready.'],
}

export function renderApplyResult(
  result: ApplyResult,
  style: Styler,
  options: { command: InstallPlan['command']; verb?: string } = { command: 'init' },
): string {
  const command = options.command
  const lines: string[] = []
  switch (result.status) {
    case 'applied':
      lines.push(
        style.green(style.bold(APPLIED_TITLE[command])) +
          ` (transaction ${result.transactionId || 'none'})`,
      )
      for (const path of result.appliedPaths) {
        lines.push(`  ${command === 'init' ? 'created' : 'wrote  '} ${path}`)
      }
      for (const path of result.removedPaths) lines.push(`  removed ${path}`)
      for (const path of result.removedDirectories) lines.push(`  removed ${path}/`)
      if (result.appliedPaths.length === 0 && result.removedPaths.length === 0) {
        lines.push('  (no file changed)')
      }
      if (result.durability !== 'strict') {
        lines.push(`  ${style.yellow('durability')} ${result.durability}`)
      }
      for (const diagnostic of result.diagnostics.filter((item) => item.severity === 'warning')) {
        lines.push(`  ${style.yellow('warning')} ${diagnostic.code}: ${diagnostic.message}`)
      }
      lines.push('')
      lines.push(...NEXT_STEPS[command])
      lines.push('wrkrs did not commit anything; the working tree is yours to review.')
      break
    case 'aborted':
      lines.push(
        style.red(
          style.bold(`${options.verb ?? 'Installation'} aborted before any change was made`),
        ),
      )
      for (const conflict of result.conflicts) {
        lines.push(
          `  ${style.red(conflict.code)}${conflict.path ? ` ${conflict.path}` : ''}: ${conflict.message}`,
        )
        lines.push(`    ${style.dim(conflict.remediation)}`)
      }
      break
    case 'rolled-back':
      lines.push(
        style.red(style.bold(`${options.verb ?? 'Installation'} failed and was rolled back`)) +
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
      lines.push('  The repository was restored to the state it had before the command ran.')
      break
    case 'rollback-incomplete':
      lines.push(
        style.red(
          style.bold(
            `${options.verb ?? 'Installation'} failed and rollback could not restore every path`,
          ),
        ) + ` (transaction ${result.transactionId})`,
      )
      lines.push(`  ${result.failure}`)
      if (result.conflict) {
        lines.push(
          `  ${style.red(result.conflict.code)}${result.conflict.path ? ` ${result.conflict.path}` : ''}: ${result.conflict.message}`,
        )
        lines.push(`    ${style.dim(result.conflict.remediation)}`)
      }
      lines.push('  Retained paths (left alone because they changed or could not be reconciled):')
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
