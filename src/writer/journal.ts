import { serializeJournal } from '../config/serialize.js'
import {
  JOURNAL_PATH,
  WRKRS_DIRECTORY,
  type JournalCommand,
  type JournalOperation,
  type JournalOperationStatus,
  type TransactionJournal,
  type TransactionStatus,
} from '../core/ownership.js'
import {
  ExclusiveWriteError,
  FileSystemError,
  type BoundDirectory,
  type ClockPort,
  type DirectorySyncResult,
  type FileSystemPort,
} from '../core/ports.js'
import { formatTimestamp } from '../platform/clock.js'
import { baseName } from '../platform/paths.js'

export const JOURNAL_FILE_MODE = 0o644
export const JOURNAL_FILE_NAME = baseName(JOURNAL_PATH)

/**
 * Raised when a journal temporary file was created but could not be removed
 * (or its removal could not be proven durable). The live journal is
 * untouched; the caller must report the exact retained path.
 */
export class JournalTempRetainedError extends Error {
  readonly tempPath: string
  readonly reason: string
  /**
   * True when the temporary was unlinked and verified absent and only its
   * durability is unproven, so a later completed directory sync still proves
   * the removal. False when the name may still exist.
   */
  readonly removed: boolean

  constructor(tempPath: string, reason: string, options: { removed: boolean; cause: unknown }) {
    super(`journal temporary file retained: ${tempPath} (${reason})`, { cause: options.cause })
    this.name = 'JournalTempRetainedError'
    this.tempPath = tempPath
    this.reason = reason
    this.removed = options.removed
  }
}

export function createJournal(input: {
  transactionId: string
  planDigest: string
  startedAt: string
  command?: JournalCommand
  operations: readonly JournalOperation[]
}): TransactionJournal {
  return {
    schemaVersion: 1,
    transactionId: input.transactionId,
    command: input.command ?? 'init',
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
  return {
    path,
    kind,
    status,
    stagingPath: null,
    backupPath: null,
    backupHash: null,
    expectedHash,
    appliedHash: null,
    note: null,
  }
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
    Pick<
      JournalOperation,
      | 'status'
      | 'stagingPath'
      | 'backupPath'
      | 'backupHash'
      | 'expectedHash'
      | 'appliedHash'
      | 'note'
    >
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
  return sync === 'synced' ? journal : withoutStrictDurability(journal)
}

/**
 * Downgrades the journal to best-effort durability. Used when a removal this
 * transaction performed is not proven durable at the moment the journal is
 * written, so the recorded durability never claims more than was proven.
 */
export function withoutStrictDurability(journal: TransactionJournal): TransactionJournal {
  return journal.durability === 'best-effort' ? journal : { ...journal, durability: 'best-effort' }
}

/** Temporary name used while replacing the journal; never the recovery record itself. */
export function journalStagingName(transactionId: string): string {
  return `${JOURNAL_FILE_NAME}.${transactionId.slice(0, 8)}.tmp`
}

/**
 * Removes a journal temporary file that wrkrs created, proving it absent and
 * syncing the directory; throws JournalTempRetainedError when that cannot be
 * proven so the exact path is reported.
 */
async function removeTemp(
  directory: BoundDirectory,
  tempName: string,
  cause: unknown,
): Promise<DirectorySyncResult> {
  const tempPath = `${WRKRS_DIRECTORY}/${tempName}`
  try {
    await directory.unlink(tempName)
  } catch (error) {
    if (!(error instanceof FileSystemError && error.code === 'ENOENT')) {
      throw new JournalTempRetainedError(tempPath, 'could not be removed', {
        removed: false,
        cause,
      })
    }
  }
  if (await directory.lstat(tempName)) {
    throw new JournalTempRetainedError(tempPath, 'still present after removal', {
      removed: false,
      cause,
    })
  }
  try {
    return await directory.sync()
  } catch {
    // The name is gone; only its durability is unproven, so a later completed
    // sync of .wrkrs still proves this removal.
    throw new JournalTempRetainedError(tempPath, 'removal is not proven durable', {
      removed: true,
      cause,
    })
  }
}

/**
 * Durable journal replacement inside the bound .wrkrs directory:
 *
 * 1. the new version is written to a temporary sibling with O_EXCL and its
 *    bytes are fsynced; an existing entry under that name belongs to someone
 *    else and is never deleted;
 * 2. the temporary file is renamed over the live journal, so the previous
 *    record stays intact until the rename succeeds and the live journal is
 *    never truncated or rewritten in place;
 * 3. the directory is fsynced so the new entry survives a power loss on
 *    filesystems that require it; a sync I/O error propagates.
 *
 * A temporary file whose write failed after creation is removed, proven
 * absent, and synced before the original error propagates; if that cannot be
 * proven a JournalTempRetainedError names it. When the directory sync reports
 * unsupported, the journal is written once more with durability
 * "best-effort" so the serialized value matches the effective guarantee.
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
    const writeOnce = async (document: TransactionJournal): Promise<DirectorySyncResult> => {
      const bytes = new TextEncoder().encode(serializeJournal(document))
      try {
        await directory.writeFileExclusive(staging, bytes, JOURNAL_FILE_MODE)
      } catch (error) {
        if (error instanceof ExclusiveWriteError) {
          await removeTemp(directory, staging, error)
        }
        throw error
      }
      try {
        await directory.rename(staging, JOURNAL_FILE_NAME)
      } catch (error) {
        await removeTemp(directory, staging, error)
        throw error
      }
      return directory.sync()
    }

    let current = stamped
    let sync = await writeOnce(current)
    let result = withDurability(current, sync)
    if (result.durability !== current.durability) {
      current = result
      sync = await writeOnce(current)
      result = withDurability(current, sync)
    }
    return result
  })
}
