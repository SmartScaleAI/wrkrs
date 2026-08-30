import { serializeJournal } from '../config/serialize.js'
import {
  JOURNAL_PATH,
  WRKRS_DIRECTORY,
  type JournalOperation,
  type JournalOperationStatus,
  type TransactionJournal,
  type TransactionStatus,
} from '../core/ownership.js'
import {
  FileSystemError,
  type ClockPort,
  type DirectorySyncResult,
  type FileSystemPort,
} from '../core/ports.js'
import { formatTimestamp } from '../platform/clock.js'
import { baseName } from '../platform/paths.js'

export const JOURNAL_FILE_MODE = 0o644
export const JOURNAL_FILE_NAME = baseName(JOURNAL_PATH)

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
    durability: 'strict',
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

/** Records a directory-sync outcome: one unsupported sync downgrades the whole transaction. */
export function withDurability(
  journal: TransactionJournal,
  sync: DirectorySyncResult,
): TransactionJournal {
  if (sync === 'synced') return journal
  return journal.durability === 'best-effort' ? journal : { ...journal, durability: 'best-effort' }
}

/** Temporary name used while replacing the journal; never the recovery record itself. */
export function journalStagingName(transactionId: string): string {
  return `${JOURNAL_FILE_NAME}.${transactionId.slice(0, 8)}.tmp`
}

/**
 * Durable journal replacement inside the bound .wrkrs directory:
 *
 * 1. the new version is written to a temporary sibling with O_EXCL and its
 *    bytes are fsynced;
 * 2. the temporary file is renamed over the live journal, so the previous
 *    record stays intact until the rename succeeds and the live journal is
 *    never truncated or rewritten in place;
 * 3. the directory is fsynced so the new entry survives a power loss on
 *    filesystems that require it.
 *
 * Where the platform cannot fsync a directory the journal records
 * durability "best-effort" instead of claiming strict durability.
 */
export async function persistJournal(
  fs: FileSystemPort,
  root: string,
  journal: TransactionJournal,
  clock: ClockPort,
): Promise<TransactionJournal> {
  const stamped: TransactionJournal = { ...journal, updatedAt: formatTimestamp(clock.now()) }
  const staging = journalStagingName(journal.transactionId)
  return fs.withinDirectory(root, WRKRS_DIRECTORY, async (directory) => {
    const bytes = new TextEncoder().encode(serializeJournal(stamped))
    try {
      await directory.writeFileExclusive(staging, bytes, JOURNAL_FILE_MODE)
    } catch (error) {
      if (!(error instanceof FileSystemError && error.code === 'EEXIST')) throw error
      // A previous attempt left its temporary file behind; replace it.
      await directory.unlink(staging)
      await directory.writeFileExclusive(staging, bytes, JOURNAL_FILE_MODE)
    }
    try {
      await directory.rename(staging, JOURNAL_FILE_NAME)
    } catch (error) {
      await directory.unlink(staging).catch(() => undefined)
      throw error
    }
    const sync = await directory.sync()
    return withDurability(stamped, sync)
  })
}
