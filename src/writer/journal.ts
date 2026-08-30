import { serializeJournal } from '../config/serialize.js'
import type {
  JournalOperation,
  JournalOperationStatus,
  TransactionJournal,
  TransactionStatus,
} from '../core/ownership.js'
import { FileSystemError, type ClockPort, type FileSystemPort } from '../core/ports.js'
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
  expectedHash: string | null = null,
): JournalOperation {
  return { path, kind, status, stagingPath: null, expectedHash, appliedHash: null, note: null }
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
  patch: Partial<
    Pick<JournalOperation, 'status' | 'stagingPath' | 'expectedHash' | 'appliedHash' | 'note'>
  >,
): TransactionJournal {
  return {
    ...journal,
    operations: journal.operations.map((operation) =>
      operation.path === path ? { ...operation, ...patch } : operation,
    ),
  }
}

/** Temporary file used while replacing the journal; never the recovery record itself. */
export function journalStagingPath(journalSystemPath: string, transactionId: string): string {
  return `${journalSystemPath}.${transactionId.slice(0, 8)}.tmp`
}

/**
 * Durable journal replacement: the new version is written to a temporary
 * sibling, synced, and renamed over the journal. The previous journal stays
 * intact until the rename succeeds, so a failure at any point leaves a valid
 * recovery record on disk.
 */
export async function persistJournal(
  fs: FileSystemPort,
  journalSystemPath: string,
  journal: TransactionJournal,
  clock: ClockPort,
): Promise<TransactionJournal> {
  const stamped = { ...journal, updatedAt: formatTimestamp(clock.now()) }
  const bytes = new TextEncoder().encode(serializeJournal(stamped))
  const staging = journalStagingPath(journalSystemPath, journal.transactionId)
  try {
    await fs.writeFileExclusive(staging, bytes, JOURNAL_FILE_MODE)
  } catch (error) {
    if (!(error instanceof FileSystemError && error.code === 'EEXIST')) throw error
    // A previous attempt left its temporary file behind; replace it.
    await fs.unlink(staging)
    await fs.writeFileExclusive(staging, bytes, JOURNAL_FILE_MODE)
  }
  try {
    await fs.rename(staging, journalSystemPath)
  } catch (error) {
    await fs.unlink(staging).catch(() => undefined)
    throw error
  }
  return stamped
}
