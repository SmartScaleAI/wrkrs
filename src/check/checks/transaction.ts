import { parseJournalDocument } from '../../config/load.js'
import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { JOURNAL_PATH, LOCK_PATH } from '../../core/ownership.js'
import { toSystemPath } from '../../platform/paths.js'
import { readRepositoryText, type CheckContext } from '../context.js'

export async function checkTransaction(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const journalSystemPath = toSystemPath(context.root, JOURNAL_PATH)
  const journalStat = await context.fs.lstat(journalSystemPath)
  if (journalStat) {
    if (journalStat.kind !== 'file') {
      diagnostics.push(
        createDiagnostic(
          'TRANSACTION_JOURNAL_UNREADABLE',
          'error',
          `Transaction journal path is a ${journalStat.kind}`,
          {
            path: JOURNAL_PATH,
            remediation: 'Inspect and remove the path manually',
          },
        ),
      )
    } else {
      const parsed = parseJournalDocument(await readRepositoryText(context, journalSystemPath))
      if (!parsed.ok) {
        diagnostics.push(
          createDiagnostic(
            'TRANSACTION_JOURNAL_UNREADABLE',
            'error',
            `Transaction journal could not be parsed: ${parsed.error.message}`,
            {
              path: JOURNAL_PATH,
              remediation:
                'Inspect the journal, restore or remove listed paths, then delete the journal',
            },
          ),
        )
      } else if (parsed.value.transactionId !== context.activeTransactionId) {
        const retained = parsed.value.operations
          .filter((operation) => operation.status === 'retained')
          .map((operation) => operation.path)
        diagnostics.push(
          createDiagnostic(
            'TRANSACTION_INTERRUPTED',
            'error',
            `A wrkrs transaction (${parsed.value.transactionId}) was interrupted with status "${parsed.value.status}"${parsed.value.failure ? `: ${parsed.value.failure}` : ''}`,
            {
              path: JOURNAL_PATH,
              remediation:
                retained.length > 0
                  ? `Review the retained paths (${retained.join(', ')}), restore or remove them, then delete the journal`
                  : 'Review the journal, restore or remove the listed paths, then delete the journal',
              details: {
                transactionId: parsed.value.transactionId,
                status: parsed.value.status,
                retained: retained.join(','),
              },
            },
          ),
        )
      }
    }
  }

  const lockStat = await context.fs.lstat(toSystemPath(context.root, LOCK_PATH))
  if (lockStat && context.activeTransactionId === null) {
    diagnostics.push(
      createDiagnostic(
        'TRANSACTION_LOCK_PRESENT',
        'warning',
        'A wrkrs installation lock is present; another install may be running or the lock is stale',
        {
          path: LOCK_PATH,
          remediation: 'If no wrkrs process is running, remove the lock file',
        },
      ),
    )
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(
      createDiagnostic('TRANSACTION_OK', 'info', 'No interrupted wrkrs transaction is present'),
    )
  }
  return diagnostics
}
