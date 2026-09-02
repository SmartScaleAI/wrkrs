import { parseJournalDocument } from '../../config/load.js'
import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { JOURNAL_PATH, LOCK_PATH } from '../../core/ownership.js'
import { containmentDiagnostic, type CheckContext } from '../context.js'

export async function checkTransaction(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const journalResolved = await context.reader.resolve(JOURNAL_PATH)
  if (!journalResolved.ok) {
    diagnostics.push(
      containmentDiagnostic('TRANSACTION_PATH_UNSAFE', 'error', journalResolved.error),
    )
    return diagnostics
  }
  const journalStat = journalResolved.value.stat
  if (journalStat) {
    if (journalStat.kind !== 'file') {
      diagnostics.push(
        createDiagnostic(
          'TRANSACTION_JOURNAL_UNREADABLE',
          'error',
          `Transaction journal path is a ${journalStat.kind}; wrkrs did not read it`,
          {
            path: JOURNAL_PATH,
            remediation: 'Inspect and remove the path manually',
          },
        ),
      )
    } else {
      const text = await context.reader.readText(JOURNAL_PATH)
      const parsed = text.ok ? parseJournalDocument(text.value ?? '') : null
      if (!text.ok) {
        diagnostics.push(containmentDiagnostic('TRANSACTION_PATH_UNSAFE', 'error', text.error))
      } else if (!parsed || !parsed.ok) {
        diagnostics.push(
          createDiagnostic(
            'TRANSACTION_JOURNAL_UNREADABLE',
            'error',
            `Transaction journal could not be parsed (${parsed ? parsed.error.code : 'unreadable'})`,
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

  const lockResolved = await context.reader.resolve(LOCK_PATH)
  if (!lockResolved.ok) {
    diagnostics.push(containmentDiagnostic('TRANSACTION_PATH_UNSAFE', 'error', lockResolved.error))
  } else if (lockResolved.value.stat && context.activeTransactionId === null) {
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
