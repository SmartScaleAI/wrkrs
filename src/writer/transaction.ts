import { createDiagnostic, hasErrors, type Diagnostic } from '../core/diagnostics.js'
import {
  JOURNAL_PATH,
  LOCK_PATH,
  WRKRS_DIRECTORY,
  type JournalOperation,
  type TransactionDurability,
  type TransactionJournal,
} from '../core/ownership.js'
import type { Conflict, InstallPlan, PlanOperation } from '../core/plan.js'
import {
  AtomicPublicationUnsupportedError,
  ContainmentError,
  ExclusiveWriteError,
  FileSystemError,
  type BoundDirectory,
  type ClockPort,
  type DirectorySyncResult,
  type EnvironmentPort,
  type FileSystemPort,
  type IdPort,
} from '../core/ports.js'
import { formatTimestamp } from '../platform/clock.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories, baseName, parentDirectory } from '../platform/paths.js'
import { conflict } from '../planner/conflicts.js'
import { MANIFEST_SOURCE_ID } from '../planner/digest.js'
import { GENERATED_DIRECTORY_MODE } from '../planner/operations.js'
import {
  createJournal,
  journalStagingName,
  JOURNAL_FILE_NAME,
  JournalTempRetainedError,
  persistJournal,
  plannedOperation,
  withDurability,
  withOperation,
  withStatus,
} from './journal.js'
import { recheckPreconditions } from './preconditions.js'
import { rollbackTransaction, type RetainedPath } from './rollback.js'

export interface WriterPorts {
  readonly fs: FileSystemPort
  readonly clock: ClockPort
  readonly ids: IdPort
  readonly environment: EnvironmentPort
}

export interface ApplyInput {
  readonly plan: InstallPlan
  /** Post-write validation using the same rules as `wrkrs check`. Errors fail the transaction. */
  readonly validate: (context: { transactionId: string }) => Promise<readonly Diagnostic[]>
}

export type ApplyResult =
  | {
      readonly status: 'applied'
      readonly transactionId: string
      readonly appliedPaths: readonly string[]
      readonly createdDirectories: readonly string[]
      /** Effective durability of the whole transaction, including bookkeeping cleanup. */
      readonly durability: TransactionDurability
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly status: 'aborted'; readonly conflicts: readonly Conflict[] }
  | {
      readonly status: 'rolled-back'
      readonly transactionId: string
      readonly failure: string
      /** Stable conflict when the failure was a precondition or environment limit. */
      readonly conflict: Conflict | null
      readonly diagnostics: readonly Diagnostic[]
    }
  | {
      readonly status: 'rollback-incomplete'
      readonly transactionId: string
      readonly failure: string
      readonly conflict: Conflict | null
      readonly retained: readonly RetainedPath[]
      readonly journalPath: string
      readonly diagnostics: readonly Diagnostic[]
    }

class TransactionFailure extends Error {
  readonly diagnostics: readonly Diagnostic[]
  readonly conflict: Conflict | null
  constructor(
    message: string,
    options: { diagnostics?: readonly Diagnostic[]; conflict?: Conflict | null } = {},
  ) {
    super(message)
    this.name = 'TransactionFailure'
    this.diagnostics = options.diagnostics ?? []
    this.conflict = options.conflict ?? null
  }
}

const LOCK_FILE_NAME = baseName(LOCK_PATH)
const REPLAN = 'Run `wrkrs init --dry-run` again and review the new plan'
const DURABILITY_UNPROVEN =
  'removed, but the directory sync failed so the removal is not proven durable'

function orderedCreates(plan: InstallPlan): PlanOperation[] {
  const creates = plan.operations.filter((operation) => operation.outcome === 'create')
  const manifest = creates.filter((operation) => operation.sourceId === MANIFEST_SOURCE_ID)
  const others = creates
    .filter((operation) => operation.sourceId !== MANIFEST_SOURCE_ID)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return [...others, ...manifest]
}

function stagingNameFor(path: string, transactionId: string): string {
  return `.${baseName(path)}.wrkrs-${transactionId.slice(0, 8)}.tmp`
}

function describeFailure(error: unknown): string {
  if (error instanceof TransactionFailure) return error.message
  if (error instanceof JournalTempRetainedError) return error.message
  if (error instanceof ContainmentError) return `${error.code}: ${error.message}`
  if (error instanceof AtomicPublicationUnsupportedError) return error.message
  if (error instanceof ExclusiveWriteError) return `${error.code} while writing ${error.entryName}`
  if (error instanceof FileSystemError) return `${error.code} at ${error.path}`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Turns a low-level failure raised while operating on `path` into a stable conflict where one applies. */
function conflictFor(error: unknown, path: string): Conflict | null {
  if (error instanceof ContainmentError && error.code === 'CONTAINMENT_UNSUPPORTED') {
    return containmentUnsupportedConflict(error.message)
  }
  if (error instanceof ContainmentError) {
    return conflict(
      'PATH',
      'PATH_ANCESTOR_CHANGED',
      path,
      `Parent directory "${error.ancestor ?? error.directory}" changed during apply (${error.code}); nothing was read, written, or removed outside the repository`,
      REPLAN,
    )
  }
  if (error instanceof AtomicPublicationUnsupportedError) {
    return conflict(
      'ENVIRONMENT',
      'ENVIRONMENT_ATOMIC_PUBLICATION_UNSUPPORTED',
      path,
      'The filesystem holding the repository cannot create hard links, so wrkrs cannot publish files atomically without replacing existing entries',
      'Move the repository to a filesystem that supports hard links (for example APFS, ext4, or NTFS) and run `wrkrs init` again',
    )
  }
  return null
}

export function containmentUnsupportedConflict(reason: string): Conflict {
  return conflict(
    'ENVIRONMENT',
    'ENVIRONMENT_CONTAINMENT_UNSUPPORTED',
    null,
    `Strict repository containment is not available here: ${reason}`,
    'Run wrkrs on macOS or Linux; nothing in the repository was read or written',
  )
}

/**
 * Applies a validated, unblocked plan through a journaled transaction:
 * lock, recheck, staged writes in deterministic order, atomic no-replace
 * publication, separately verified staging cleanup, post-publication hash
 * verification, validation, and hash-guarded reverse rollback on any failure.
 *
 * Every filesystem step runs inside a bound parent directory
 * (FileSystemPort.withinDirectory), so a symlinked or swapped ancestor makes
 * the step fail closed rather than touch anything outside the repository.
 *
 * Journal state is advanced in memory before every operation that may create
 * an entry (staging, lock, journal temporary) and before every fallible
 * cleanup, so no failure can hide a name wrkrs created. Every removal is
 * proven (absence check, directory sync) before the journal forgets it.
 */
export async function applyPlan(input: ApplyInput, ports: WriterPorts): Promise<ApplyResult> {
  const { plan } = input
  const { fs, clock, ids } = ports
  const root = plan.repositoryRoot

  if (plan.blockers.length > 0) {
    return { status: 'aborted', conflicts: plan.blockers }
  }
  if (!fs.containment.supported) {
    return { status: 'aborted', conflicts: [containmentUnsupportedConflict(fs.containment.reason)] }
  }
  const creates = orderedCreates(plan)
  if (creates.length === 0) {
    return {
      status: 'applied',
      transactionId: '',
      appliedPaths: [],
      createdDirectories: [],
      durability: 'strict',
      diagnostics: [],
    }
  }

  const inDirectory = <T>(
    directory: string,
    operation: (bound: BoundDirectory) => Promise<T>,
  ): Promise<T> => fs.withinDirectory(root, directory, operation)

  const abortedWith = (error: unknown, path: string, fallback: Conflict): ApplyResult => ({
    status: 'aborted',
    conflicts: [conflictFor(error, path) ?? fallback],
  })

  try {
    const journalStat = await inDirectory(WRKRS_DIRECTORY, (bound) =>
      bound.lstat(JOURNAL_FILE_NAME),
    )
    if (journalStat) {
      return {
        status: 'aborted',
        conflicts: [
          conflict(
            'OWNERSHIP',
            'OWNERSHIP_TRANSACTION_INTERRUPTED',
            JOURNAL_PATH,
            'An interrupted wrkrs transaction journal is present',
            'Resolve the journal before retrying',
          ),
        ],
      }
    }
  } catch (error) {
    if (!(error instanceof ContainmentError && error.code === 'PATH_ANCESTOR_MISSING')) {
      return abortedWith(
        error,
        JOURNAL_PATH,
        conflict(
          'PRECONDITION',
          'PRECONDITION_TARGET_CHANGED',
          WRKRS_DIRECTORY,
          describeFailure(error),
          REPLAN,
        ),
      )
    }
  }

  const before = await recheckPreconditions(plan, root, fs)
  if (before.length > 0) return { status: 'aborted', conflicts: before }

  const transactionId = ids.uuid()
  const startedAt = formatTimestamp(clock.now())
  const journalTempName = journalStagingName(transactionId)
  const journalTempPath = `${WRKRS_DIRECTORY}/${journalTempName}`

  // The lock lives inside .wrkrs, so that directory is the one piece of
  // bookkeeping that may exist before the lock is held. It is a planned
  // created directory and is removed again on any abort or complete rollback.
  let wrkrsCreated = false
  let wrkrsPresent: boolean
  try {
    wrkrsPresent = (await inDirectory('', (bound) => bound.lstat(WRKRS_DIRECTORY))) !== null
  } catch (error) {
    return abortedWith(
      error,
      WRKRS_DIRECTORY,
      conflict(
        'PRECONDITION',
        'PRECONDITION_TARGET_CHANGED',
        WRKRS_DIRECTORY,
        describeFailure(error),
        REPLAN,
      ),
    )
  }
  if (!wrkrsPresent) {
    if (!plan.createdDirectories.includes(WRKRS_DIRECTORY)) {
      return {
        status: 'aborted',
        conflicts: [
          conflict(
            'PRECONDITION',
            'PRECONDITION_DIRECTORY_MISSING',
            WRKRS_DIRECTORY,
            '.wrkrs is absent but the plan did not expect to create it',
            REPLAN,
          ),
        ],
      }
    }
    try {
      await inDirectory('', async (bound) => {
        await bound.makeDirectory(WRKRS_DIRECTORY, GENERATED_DIRECTORY_MODE)
        await bound.sync()
      })
    } catch (error) {
      // A directory that was created but whose sync failed is removed again below.
      const remaining = await removeCreatedWrkrs(inDirectory)
      if (remaining) {
        return incompleteBookkeeping(transactionId, error, [remaining], null)
      }
      return abortedWith(
        error,
        WRKRS_DIRECTORY,
        conflict(
          'PRECONDITION',
          'PRECONDITION_TARGET_CHANGED',
          WRKRS_DIRECTORY,
          `Could not create .wrkrs (${describeFailure(error)})`,
          REPLAN,
        ),
      )
    }
    wrkrsCreated = true
  }

  /** Paths of journal temporaries that could not be removed; reported on every exit. */
  const retainedTemps = new Map<string, string>()
  const bookkeeping: { durability: TransactionDurability } = { durability: 'strict' }
  const noteSync = (sync: DirectorySyncResult): void => {
    if (sync === 'unsupported') bookkeeping.durability = 'best-effort'
  }

  /**
   * Removes bookkeeping in the proven order (unlink, verify absent, sync) and
   * returns every path whose removal could not be proven.
   */
  const releaseBookkeeping = async (options: {
    /** Keep the live journal as the recovery record when anything else is retained. */
    keepJournalWhenRetained: boolean
    /**
     * Remove a .wrkrs directory this transaction created. Only abort and
     * rollback paths may do this; after a successful installation .wrkrs
     * holds the repository-owned configuration and manifest and must stay.
     */
    removeCreatedDirectory: boolean
  }): Promise<RetainedPath[]> => {
    const remaining = new Map<string, string>()
    const removeNamed = async (
      bound: BoundDirectory,
      name: string,
      path: string,
    ): Promise<boolean> => {
      try {
        await bound.unlink(name)
      } catch (error) {
        if (!(error instanceof FileSystemError && error.code === 'ENOENT')) {
          remaining.set(path, 'bookkeeping could not be removed')
          return false
        }
      }
      if (await bound.lstat(name)) {
        remaining.set(path, 'still present after removal')
        return false
      }
      return true
    }
    try {
      await inDirectory(WRKRS_DIRECTORY, async (bound) => {
        // A journal temporary is only ever ours when a previous cleanup failed;
        // any other entry under that name belongs to someone else and stays.
        let tempRemoved = false
        if (retainedTemps.has(journalTempPath)) {
          tempRemoved = await removeNamed(bound, journalTempName, journalTempPath)
        }
        await removeNamed(bound, LOCK_FILE_NAME, LOCK_PATH)
        const keepJournal = options.keepJournalWhenRetained && remaining.size > 0
        if (!keepJournal) await removeNamed(bound, JOURNAL_FILE_NAME, JOURNAL_PATH)
        try {
          noteSync(await bound.sync())
          // Only a removal whose directory entry is synced counts as proven;
          // the retention map then reflects the current state.
          if (tempRemoved) retainedTemps.delete(journalTempPath)
        } catch {
          remaining.set(WRKRS_DIRECTORY, DURABILITY_UNPROVEN)
        }
      })
    } catch (error) {
      if (!(error instanceof ContainmentError && error.code === 'PATH_ANCESTOR_MISSING')) {
        remaining.set(WRKRS_DIRECTORY, describeFailure(error))
      }
    }
    if (options.removeCreatedDirectory && wrkrsCreated && remaining.size === 0) {
      const leftover = await removeCreatedWrkrs(inDirectory, noteSync)
      if (leftover) remaining.set(leftover.path, leftover.reason)
    }
    return retainedEntries(remaining)
  }

  const lockContent = JSON.stringify(
    { transactionId, pid: ports.environment.processId, startedAt },
    null,
    2,
  )
  let lockCreated = false
  try {
    await inDirectory(WRKRS_DIRECTORY, async (bound) => {
      await bound.writeFileExclusive(
        LOCK_FILE_NAME,
        new TextEncoder().encode(lockContent + '\n'),
        0o644,
      )
      // The exclusive create completed; any later failure (such as the
      // directory sync below) leaves a lock this transaction must reconcile.
      lockCreated = true
      noteSync(await bound.sync())
    })
  } catch (error) {
    if (!lockCreated && (error instanceof FileSystemError || error instanceof ContainmentError)) {
      // Nothing was created by this transaction at the lock name (EEXIST means
      // the entry belongs to another process and must stay). Only the .wrkrs
      // directory this transaction created is removed, and only when that can
      // be proven.
      const code = error instanceof FileSystemError ? error.code : 'EUNKNOWN'
      const lockConflict = conflict(
        'OWNERSHIP',
        code === 'EEXIST' ? 'OWNERSHIP_LOCK_PRESENT' : 'OWNERSHIP_LOCK_FAILED',
        LOCK_PATH,
        code === 'EEXIST'
          ? 'Another wrkrs installation holds the lock'
          : `Could not acquire the installation lock (${describeFailure(error)})`,
        'Ensure no other wrkrs process is running, then remove a stale lock file and retry',
      )
      const leftover = wrkrsCreated ? await removeCreatedWrkrs(inDirectory, noteSync) : null
      if (leftover) {
        return incompleteBookkeeping(transactionId, error, [leftover], LOCK_PATH, lockConflict)
      }
      return abortedWith(error, LOCK_PATH, lockConflict)
    }
    // The lock name exists (the write failed after creation, or the directory
    // sync failed after a successful creation): prove it gone or report it;
    // never return plain "aborted" while it remains.
    const remaining = await releaseBookkeeping({
      keepJournalWhenRetained: false,
      removeCreatedDirectory: true,
    })
    if (remaining.length > 0) {
      return incompleteBookkeeping(
        transactionId,
        error,
        remaining,
        LOCK_PATH,
        undefined,
        async () =>
          writeRecoveryJournal(
            fs,
            root,
            transactionId,
            startedAt,
            plan.digest,
            describeFailure(error),
            clock,
          ),
      )
    }
    return abortedWith(
      error,
      LOCK_PATH,
      conflict(
        'OWNERSHIP',
        'OWNERSHIP_LOCK_FAILED',
        LOCK_PATH,
        `Could not acquire the installation lock (${describeFailure(error)})`,
        'Ensure no other wrkrs process is running, then remove a stale lock file and retry',
      ),
    )
  }

  // .wrkrs itself is transaction bookkeeping (it holds the journal and lock),
  // so it is tracked separately and removed last rather than journaled.
  const journalOperations: JournalOperation[] = []
  const listedDirectories = new Set<string>()
  if (wrkrsCreated) listedDirectories.add(WRKRS_DIRECTORY)
  for (const operation of creates) {
    for (const ancestor of ancestorDirectories(operation.path)) {
      if (plan.createdDirectories.includes(ancestor) && !listedDirectories.has(ancestor)) {
        journalOperations.push(plannedOperation(ancestor, 'create-directory'))
        listedDirectories.add(ancestor)
      }
    }
    journalOperations.push(
      plannedOperation(operation.path, 'create-file', 'planned', operation.proposedHash),
    )
  }

  let journal: TransactionJournal = createJournal({
    transactionId,
    planDigest: plan.digest,
    startedAt,
    operations: journalOperations,
  })
  const persist = async (next: TransactionJournal): Promise<TransactionJournal> => {
    try {
      return await persistJournal(fs, root, next, clock)
    } catch (error) {
      if (error instanceof JournalTempRetainedError) retainedTemps.set(error.tempPath, error.reason)
      throw error
    }
  }

  try {
    journal = await persist(journal)
  } catch (error) {
    const remaining = mergeRetained(
      await releaseBookkeeping({ keepJournalWhenRetained: true, removeCreatedDirectory: true }),
      retainedTemps,
    )
    if (remaining.length > 0) {
      return incompleteBookkeeping(transactionId, error, remaining, JOURNAL_PATH)
    }
    return abortedWith(
      error,
      JOURNAL_PATH,
      conflict(
        'PRECONDITION',
        'PRECONDITION_JOURNAL_UNWRITABLE',
        JOURNAL_PATH,
        `Could not write the transaction journal (${describeFailure(error)})`,
        'Check filesystem permissions and retry',
      ),
    )
  }

  const after = await recheckPreconditions(plan, root, fs, {
    allowExistingDirectories: new Set(wrkrsCreated ? [WRKRS_DIRECTORY] : []),
  })
  if (after.length > 0) {
    const remaining = mergeRetained(
      await releaseBookkeeping({ keepJournalWhenRetained: true, removeCreatedDirectory: true }),
      retainedTemps,
    )
    if (remaining.length > 0) {
      return incompleteBookkeeping(
        transactionId,
        new Error(after[0]?.message ?? 'precondition changed'),
        remaining,
        JOURNAL_PATH,
      )
    }
    return { status: 'aborted', conflicts: after }
  }

  const appliedPaths: string[] = []
  const createdDirectories: string[] = wrkrsCreated ? [WRKRS_DIRECTORY] : []
  const created = new Set(createdDirectories)

  // Advances the in-memory journal first, then attempts to persist it. The
  // in-memory record is what rollback reconciles against.
  const advance = async (next: TransactionJournal): Promise<void> => {
    journal = next
    journal = await persist(journal)
  }

  /** Syncs a directory; an I/O error propagates as a transaction failure. */
  const syncDirectory = async (directory: string): Promise<void> => {
    const sync = await inDirectory(directory, (bound) => bound.sync())
    journal = withDurability(journal, sync)
  }

  let failingPath: string | null = null

  try {
    await advance(withStatus(journal, 'applying'))

    for (const operation of creates) {
      for (const ancestor of ancestorDirectories(operation.path)) {
        if (!plan.createdDirectories.includes(ancestor) || created.has(ancestor)) continue
        failingPath = ancestor
        const parent = parentDirectory(ancestor) ?? ''
        await inDirectory(parent, (bound) =>
          bound.makeDirectory(baseName(ancestor), GENERATED_DIRECTORY_MODE),
        )
        created.add(ancestor)
        createdDirectories.push(ancestor)
        journal = withOperation(journal, ancestor, { status: 'applied' })
        await syncDirectory(parent)
        await advance(journal)
      }

      failingPath = operation.path
      const bytes = operation.proposedBytes
      if (!bytes || operation.proposedHash === null || operation.mode === null) {
        throw new TransactionFailure(`Operation for ${operation.path} carries no content`)
      }
      const expectedHash = operation.proposedHash
      const directory = parentDirectory(operation.path) ?? ''
      const targetName = baseName(operation.path)
      const stagingName = stagingNameFor(operation.path, transactionId)
      const stagingPath = directory === '' ? stagingName : `${directory}/${stagingName}`
      const mode = operation.mode

      // 1. Announce the staging name before anything can create it, then
      //    stage: full content written and fsynced under that name.
      await advance(
        withOperation(journal, operation.path, { status: 'staging', stagingPath, expectedHash }),
      )
      try {
        await inDirectory(directory, (bound) => bound.writeFileExclusive(stagingName, bytes, mode))
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'EEXIST') {
          // Someone else owns that name: forget it so rollback never touches it.
          journal = withOperation(journal, operation.path, {
            status: 'planned',
            stagingPath: null,
            note: 'staging name was already taken by another entry; it was left untouched',
          })
          throw new TransactionFailure(
            `Precondition failed: staging name for "${operation.path}" was already taken; the existing entry was left untouched`,
            {
              conflict: conflict(
                'PRECONDITION',
                'PRECONDITION_STAGING_NAME_TAKEN',
                stagingPath,
                `"${stagingPath}" already exists and was not created by this transaction; wrkrs did not overwrite it`,
                'Remove or rename that entry, then run `wrkrs init` again',
              ),
            },
          )
        }
        if (error instanceof FileSystemError || error instanceof ContainmentError) {
          // The exclusive create itself failed, so nothing was created under
          // the staging name; forget it so rollback never touches that name.
          journal = withOperation(journal, operation.path, {
            status: 'planned',
            stagingPath: null,
            note: 'staging write failed before the entry was created',
          })
        }
        // Otherwise (ExclusiveWriteError: entry created, content incomplete)
        // the journal keeps the staging path and rollback reconciles it.
        throw error
      }
      await advance(withOperation(journal, operation.path, { status: 'staged' }))

      // 2. Publish: create the target name atomically; never replace an existing entry.
      try {
        await inDirectory(directory, (bound) => bound.linkExclusive(stagingName, targetName))
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'EEXIST') {
          journal = withOperation(journal, operation.path, {
            note: 'target appeared before publication; the existing entry was left untouched',
          })
          throw new TransactionFailure(
            `Precondition failed: "${operation.path}" appeared before publication; the existing entry was left untouched`,
            {
              conflict: conflict(
                'PRECONDITION',
                'PRECONDITION_TARGET_APPEARED',
                operation.path,
                `"${operation.path}" was created by another process during apply; wrkrs did not overwrite it`,
                'Review the file, then run `wrkrs init --dry-run` again',
              ),
            },
          )
        }
        throw error
      }
      // The target may now exist: record it before anything fallible happens.
      journal = withOperation(journal, operation.path, { status: 'published' })
      await syncDirectory(directory)
      await advance(journal)

      // 3. Remove the staging name, prove it gone, sync the directory, and
      //    only then let the journal forget it.
      const cleanupSync = await inDirectory(directory, async (bound) => {
        try {
          await bound.unlink(stagingName)
        } catch (error) {
          if (!(error instanceof FileSystemError && error.code === 'ENOENT')) throw error
        }
        if (await bound.lstat(stagingName)) {
          throw new TransactionFailure(`Staging file for ${operation.path} could not be removed`)
        }
        return bound.sync()
      })
      journal = withDurability(
        withOperation(journal, operation.path, { stagingPath: null }),
        cleanupSync,
      )
      await advance(journal)

      // 4. Verify the published bytes through the bound directory.
      const written = await inDirectory(directory, (bound) => bound.readFile(targetName))
      const appliedHash = sha256(written)
      if (appliedHash !== expectedHash) {
        throw new TransactionFailure(
          `Post-write verification failed for ${operation.path}: content hash does not match the plan`,
        )
      }
      appliedPaths.push(operation.path)
      journal = withOperation(journal, operation.path, { status: 'applied', appliedHash })
      await advance(journal)
    }
    failingPath = null

    await advance(withStatus(journal, 'validating'))
    const diagnostics = [...(await input.validate({ transactionId }))]
    if (hasErrors(diagnostics)) {
      const summary = diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}`)
        .join(', ')
      throw new TransactionFailure(`Post-apply validation failed: ${summary}`, { diagnostics })
    }

    await advance(withStatus(journal, 'committed'))
    // Only transient bookkeeping (lock, journal temporary, live journal) is
    // removed after a successful commit; the installed .wrkrs directory and
    // its repository-owned contents stay.
    const leftovers = mergeRetained(
      await releaseBookkeeping({ keepJournalWhenRetained: false, removeCreatedDirectory: false }),
      retainedTemps,
    )
    let durability: TransactionDurability =
      journal.durability === 'best-effort' || bookkeeping.durability === 'best-effort'
        ? 'best-effort'
        : 'strict'
    for (const item of leftovers) {
      if (item.reason === DURABILITY_UNPROVEN || item.reason.includes('not proven durable')) {
        durability = 'best-effort'
        diagnostics.push(
          createDiagnostic(
            'TRANSACTION_BOOKKEEPING_DURABILITY_UNPROVEN',
            'warning',
            `Transaction bookkeeping was removed, but the directory sync of ${item.path} failed, so the removal is not proven durable and strict durability is not claimed`,
            { path: item.path, remediation: 'Re-run `wrkrs check` after an unexpected shutdown' },
          ),
        )
      } else {
        diagnostics.push(
          createDiagnostic(
            'TRANSACTION_BOOKKEEPING_RETAINED',
            'warning',
            `Transaction bookkeeping could not be removed: ${item.path} (${item.reason})`,
            { path: item.path, remediation: 'Remove the file manually' },
          ),
        )
      }
    }
    if (durability === 'best-effort') {
      diagnostics.push(
        createDiagnostic(
          'TRANSACTION_DURABILITY_BEST_EFFORT',
          'warning',
          'Not every directory entry could be synced to stable storage; the installation is complete but a power loss before the operating system flushes its caches could revert part of it',
          {
            remediation: 'No action is required; re-run `wrkrs check` after an unexpected shutdown',
          },
        ),
      )
    }
    return {
      status: 'applied',
      transactionId,
      appliedPaths,
      createdDirectories,
      durability,
      diagnostics,
    }
  } catch (error) {
    const failure = describeFailure(error)
    const diagnostics = error instanceof TransactionFailure ? error.diagnostics : []
    const failureConflict =
      error instanceof TransactionFailure
        ? error.conflict
        : conflictFor(error, failingPath ?? WRKRS_DIRECTORY)
    try {
      journal = await persist(withStatus(journal, 'rolling-back', failure))
    } catch {
      journal = withStatus(journal, 'rolling-back', failure)
    }

    const outcome = await rollbackTransaction({ root, fs, journal, persist })
    journal = outcome.journal
    const retained = new Map(outcome.retained.map((item) => [item.path, item.reason] as const))

    if (retained.size === 0) {
      try {
        journal = await persist(withStatus(journal, 'rolled-back', failure))
      } catch {
        journal = withStatus(journal, 'rolled-back', failure)
      }
      // Bookkeeping release retries a previously retained journal temporary
      // and clears it from the retention map once its removal is proven, so a
      // transient failure does not surface a stale retained path.
      const leftovers = mergeRetained(
        await releaseBookkeeping({ keepJournalWhenRetained: true, removeCreatedDirectory: true }),
        retainedTemps,
      )
      for (const item of leftovers) retained.set(item.path, item.reason)
      // Final proof: every directory this transaction created must be gone.
      for (const directory of [...createdDirectories].reverse()) {
        if (retained.has(directory)) continue
        const parent = parentDirectory(directory) ?? ''
        try {
          const stat = await inDirectory(parent, (bound) => bound.lstat(baseName(directory)))
          if (stat) retained.set(directory, 'directory still present after rollback')
        } catch (verifyError) {
          if (!(
            verifyError instanceof ContainmentError && verifyError.code === 'PATH_ANCESTOR_MISSING'
          )) {
            retained.set(directory, `could not verify removal (${describeFailure(verifyError)})`)
          }
        }
      }
      if (retained.size === 0) {
        return {
          status: 'rolled-back',
          transactionId,
          failure,
          conflict: failureConflict,
          diagnostics,
        }
      }
    }

    for (const [path, reason] of retainedTemps) retained.set(path, reason)
    // Release the lock through the same durable removal contract used
    // everywhere else (unlink, verify absence, sync, then forget), before the
    // final journal write so the persisted durability and the retained list
    // match the filesystem. The live journal stays as the recovery record.
    try {
      await inDirectory(WRKRS_DIRECTORY, async (bound) => {
        let lockRemoved = true
        try {
          await bound.unlink(LOCK_FILE_NAME)
        } catch (unlinkError) {
          if (!(unlinkError instanceof FileSystemError && unlinkError.code === 'ENOENT')) {
            retained.set(LOCK_PATH, 'bookkeeping could not be removed')
            lockRemoved = false
          }
        }
        if (lockRemoved && (await bound.lstat(LOCK_FILE_NAME))) {
          retained.set(LOCK_PATH, 'still present after removal')
          lockRemoved = false
        }
        try {
          journal = withDurability(journal, await bound.sync())
        } catch {
          if (lockRemoved) retained.set(LOCK_PATH, DURABILITY_UNPROVEN)
        }
      })
    } catch (releaseError) {
      if (!(
        releaseError instanceof ContainmentError && releaseError.code === 'PATH_ANCESTOR_MISSING'
      )) {
        retained.set(LOCK_PATH, describeFailure(releaseError))
      }
    }
    try {
      await persist(withStatus(journal, 'rollback-incomplete', failure))
    } catch {
      // The live journal remains the recovery record in its last persisted state.
    }
    for (const [path, reason] of retainedTemps) retained.set(path, reason)
    return {
      status: 'rollback-incomplete',
      transactionId,
      failure,
      conflict: failureConflict,
      retained: [...retained.entries()]
        .map(([path, reason]) => ({ path, reason }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      journalPath: JOURNAL_PATH,
      diagnostics,
    }
  }
}

function retainedEntries(map: ReadonlyMap<string, string>): RetainedPath[] {
  return [...map.entries()].map(([path, reason]) => ({ path, reason }))
}

/** Merges retained entries with the current temp-retention map without duplicates. */
function mergeRetained(
  entries: readonly RetainedPath[],
  temps: ReadonlyMap<string, string>,
): RetainedPath[] {
  const merged = new Map<string, string>()
  for (const item of entries) if (!merged.has(item.path)) merged.set(item.path, item.reason)
  for (const [path, reason] of temps) if (!merged.has(path)) merged.set(path, reason)
  return retainedEntries(merged)
}

/** Removes a .wrkrs directory this transaction created (rmdir, verify, sync); returns the retained entry when that fails. */
async function removeCreatedWrkrs(
  inDirectory: <T>(
    directory: string,
    operation: (bound: BoundDirectory) => Promise<T>,
  ) => Promise<T>,
  noteSync: (sync: DirectorySyncResult) => void = () => undefined,
): Promise<RetainedPath | null> {
  try {
    return await inDirectory('', async (bound) => {
      try {
        await bound.removeDirectory(WRKRS_DIRECTORY)
      } catch (error) {
        if (!(error instanceof FileSystemError && error.code === 'ENOENT')) {
          return { path: WRKRS_DIRECTORY, reason: describeFailure(error) }
        }
      }
      if (await bound.lstat(WRKRS_DIRECTORY)) {
        return { path: WRKRS_DIRECTORY, reason: 'still present after removal' }
      }
      try {
        noteSync(await bound.sync())
      } catch {
        return { path: WRKRS_DIRECTORY, reason: DURABILITY_UNPROVEN }
      }
      return null
    })
  } catch (error) {
    return { path: WRKRS_DIRECTORY, reason: describeFailure(error) }
  }
}

/**
 * Writes a minimal recovery journal when bookkeeping is retained before the
 * transaction journal existed (for example a lock that could not be removed),
 * so `wrkrs check` reports the interrupted transaction. Best effort.
 */
async function writeRecoveryJournal(
  fs: FileSystemPort,
  root: string,
  transactionId: string,
  startedAt: string,
  planDigest: string,
  failure: string,
  clock: ClockPort,
): Promise<void> {
  const journal = withStatus(
    createJournal({ transactionId, planDigest, startedAt, operations: [] }),
    'rollback-incomplete',
    failure,
  )
  await persistJournal(fs, root, journal, clock).catch(() => undefined)
}

function incompleteBookkeeping(
  transactionId: string,
  error: unknown,
  retained: readonly RetainedPath[],
  path: string | null,
  explicitConflict?: Conflict,
  recovery?: () => Promise<void>,
): Promise<ApplyResult> | ApplyResult {
  const result: ApplyResult = {
    status: 'rollback-incomplete',
    transactionId,
    failure: describeFailure(error),
    conflict: explicitConflict ?? conflictFor(error, path ?? WRKRS_DIRECTORY),
    retained: [...retained].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    journalPath: JOURNAL_PATH,
    diagnostics: [],
  }
  if (!recovery) return result
  return recovery().then(() => result)
}
