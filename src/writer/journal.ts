import { serializeJournal } from '../config/serialize.js'
import type {
  JournalOperation,
  JournalOperationStatus,
  TransactionJournal,
  TransactionStatus,
} from '../core/ownership.js'
import type { ClockPort, FileSystemPort } from '../core/ports.js'
import { formatTimestamp } from '../platform/clock.js'

export const JOURNAL_FILE_MODE = 0o644

export function createJournal(input: {
  transactionId: string
  planDigest: string
  startedAt: string
  operations: readonly JournalOperation[]
}): TransactionJournal {
  return {
    schemaVersion: 1,
    transactionId: input.transactionId,
    command: 'init',
    planDigest: input.planDigest,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    status: 'pending',
    operations: input.operations,
    failure: null,
  }
}

export function plannedOperation(
  path: string,
  kind: JournalOperation['kind'],
  status: JournalOperationStatus = 'planned',
): JournalOperation {
  return { path, kind, status, stagingPath: null, appliedHash: null, note: null }
}

export function withStatus(
  journal: TransactionJournal,
  status: TransactionStatus,
  failure: string | null = journal.failure,
): TransactionJournal {
  return { ...journal, status, failure }
}

export function withOperation(
  journal: TransactionJournal,
  path: string,
  patch: Partial<Pick<JournalOperation, 'status' | 'stagingPath' | 'appliedHash' | 'note'>>,
): TransactionJournal {
  return {
    ...journal,
    operations: journal.operations.map((operation) =>
      operation.path === path ? { ...operation, ...patch } : operation,
    ),
  }
}

/** Persists the journal; the caller decides whether a persistence failure is fatal. */
export async function persistJournal(
  fs: FileSystemPort,
  systemPath: string,
  journal: TransactionJournal,
  clock: ClockPort,
): Promise<TransactionJournal> {
  const stamped = { ...journal, updatedAt: formatTimestamp(clock.now()) }
  await fs.writeFile(
    systemPath,
    new TextEncoder().encode(serializeJournal(stamped)),
    JOURNAL_FILE_MODE,
  )
  return stamped
}
