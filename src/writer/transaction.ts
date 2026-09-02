import { createDiagnostic, hasErrors, type Diagnostic } from '../core/diagnostics.js'
import {
  JOURNAL_PATH,
  LOCK_PATH,
  WRKRS_DIRECTORY,
  type JournalOperation,
  type TransactionDurability,
  type TransactionJournal,
} from '../core/ownership.js'
import {
  MUTATING_OUTCOMES,
  type Conflict,
  type InstallPlan,
  type PlanOperation,
} from '../core/plan.js'
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
  withoutStrictDurability,
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
      /** Paths created or replaced, in application order. */
      readonly appliedPaths: readonly string[]
      /** Paths removed, in application order. */
      readonly removedPaths: readonly string[]
      readonly createdDirectories: readonly string[]
      readonly removedDirectories: readonly string[]
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

/**
 * Authoritative state of every bookkeeping name inside .wrkrs (the lock, the
 * live journal, and journal temporaries) this transaction removed or failed
 * to remove. Each exact path is in one of these states:
 *
 * - unknown: never created by this transaction, or its removal is proven
 *   durable. Nothing is reported.
 * - pending: the unlink succeeded and the name was verified absent, but the
 *   directory entry has not been synced yet. It is reported as
 *   durability-unproven unless a later completed sync of .wrkrs proves it.
 * - retained: the name could not be removed, is still present, or could not
 *   be inspected. No later sync clears it.
 *
 * Every completed .wrkrs directory sync proves the pending removals in that
 * directory, including the sync persistJournal performs, so the reported
 * paths always reflect the latest proven filesystem state. Removals whose
 * durability depends on another directory (.wrkrs itself, which is synced
 * through its parent) are recorded as retained instead, because no .wrkrs
 * sync can prove them.
 */
class BookkeepingLedger {
  /** Exact paths removed and verified absent, awaiting the sync that proves it. */
  private readonly pending = new Set<string>()
  /** Exact path -> reason it may still exist; never cleared by a directory sync. */
  private readonly retained = new Map<string, string>()

  /** The unlink succeeded and the name is gone; its durability is not proven yet. */
  awaitingSync(path: string): void {
    this.retained.delete(path)
    this.pending.add(path)
  }

  /** The name could not be removed, is still present, or could not be inspected. */
  retain(path: string, reason: string): void {
    this.pending.delete(path)
    this.retained.set(path, reason)
  }

  /** Whether this transaction still believes the name may exist. */
  mayExist(path: string): boolean {
    return this.retained.has(path)
  }

  /** Whether the path is reported at all (pending or retained). */
  has(path: string): boolean {
    return this.pending.has(path) || this.retained.has(path)
  }

  /** Whether any name could not be removed, whatever its durability. */
  get hasRetained(): boolean {
    return this.retained.size > 0
  }

  /** Whether any removal is still awaiting the sync that proves it. */
  get hasUnproven(): boolean {
    return this.pending.size > 0
  }

  get isEmpty(): boolean {
    return this.pending.size === 0 && this.retained.size === 0
  }

  /** A completed sync of .wrkrs proves every pending removal inside it. */
  directorySynced(): void {
    this.pending.clear()
  }

  /** Current state, one entry per exact path. */
  entries(): RetainedPath[] {
    const merged = new Map<string, string>(this.retained)
    for (const path of this.pending) if (!merged.has(path)) merged.set(path, DURABILITY_UNPROVEN)
    return [...merged.entries()].map(([path, reason]) => ({ path, reason }))
  }
}

const byPath = (a: PlanOperation, b: PlanOperation): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * Deterministic application order: content first, removals next, and the
 * ownership manifest last, so an interrupted transaction always leaves a
 * manifest that still describes everything wrkrs owns.
 */
function orderedMutations(plan: InstallPlan): PlanOperation[] {
  const mutations = plan.operations.filter((operation) =>
    MUTATING_OUTCOMES.includes(operation.outcome),
  )
  const manifest = mutations.filter((operation) => operation.sourceId === MANIFEST_SOURCE_ID)
  const rest = mutations.filter((operation) => operation.sourceId !== MANIFEST_SOURCE_ID)
  const writes = rest
    .filter((operation) => operation.outcome === 'create' || operation.outcome === 'replace')
    .sort(byPath)
  const removals = rest.filter((operation) => operation.outcome === 'remove').sort(byPath)
  return [...writes, ...removals, ...manifest]
}

const JOURNAL_KIND: Record<'create' | 'replace' | 'remove', JournalOperation['kind']> = {
  create: 'create-file',
  replace: 'replace-file',
  remove: 'remove-file',
}

function stagingNameFor(path: string, transactionId: string): string {
  return `.${baseName(path)}.wrkrs-${transactionId.slice(0, 8)}.tmp`
}

/**
 * Sibling name holding a hard link to a file about to be replaced or removed.
 * It lives in the target's own directory so restoring is a single atomic
 * rename inside one bound directory, and it keeps the original inode, so a
 * restore returns the exact bytes and mode that were there before.
 */
function backupNameFor(path: string, transactionId: string): string {
  return `.${baseName(path)}.wrkrs-${transactionId.slice(0, 8)}.bak`
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

function stagingNameTakenConflict(stagingPath: string): Conflict {
  return conflict(
    'PRECONDITION',
    'PRECONDITION_STAGING_NAME_TAKEN',
    stagingPath,
    `"${stagingPath}" already exists and was not created by this transaction; wrkrs did not overwrite it`,
    'Remove or rename that entry, then run the command again',
  )
}

/**
 * The sibling name a replacement or removal uses to keep the previous entry
 * alive is occupied by something wrkrs did not create. Nothing is replaced or
 * removed, because the original could not be preserved first.
 */
function backupNameTakenConflict(backupPath: string): Conflict {
  return conflict(
    'PRECONDITION',
    'PRECONDITION_BACKUP_NAME_TAKEN',
    backupPath,
    `"${backupPath}" already exists and was not created by this transaction; wrkrs did not overwrite it and changed nothing`,
    'Remove or rename that entry, then run the command again',
  )
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
  const mutations = orderedMutations(plan)
  if (mutations.length === 0 && plan.removedDirectories.length === 0) {
    return {
      status: 'applied',
      transactionId: '',
      appliedPaths: [],
      removedPaths: [],
      createdDirectories: [],
      removedDirectories: [],
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

  /** Authoritative state of every bookkeeping name this transaction may create. */
  const ledger = new BookkeepingLedger()
  const bookkeeping: { durability: TransactionDurability } = { durability: 'strict' }
  const noteSync = (sync: DirectorySyncResult): void => {
    if (sync === 'unsupported') bookkeeping.durability = 'best-effort'
  }

  /**
   * Removes one bookkeeping name inside a bound directory and records the
   * exact outcome: unlink, verify absence, then mark the removal as awaiting
   * the directory sync that proves it. A name that was never there needs no
   * proof and is left as it is, so an earlier proven removal is never
   * resurrected as pending.
   */
  const removeNamed = async (bound: BoundDirectory, name: string, path: string): Promise<void> => {
    let unlinked = false
    try {
      await bound.unlink(name)
      unlinked = true
    } catch (error) {
      if (!(error instanceof FileSystemError && error.code === 'ENOENT')) {
        ledger.retain(path, 'bookkeeping could not be removed')
        return
      }
    }
    let present: boolean
    try {
      present = (await bound.lstat(name)) !== null
    } catch (error) {
      ledger.retain(path, `could not verify removal (${describeFailure(error)})`)
      return
    }
    if (present) {
      ledger.retain(path, 'still present after removal')
      return
    }
    if (unlinked || ledger.mayExist(path)) ledger.awaitingSync(path)
  }

  /**
   * Removes transient bookkeeping (a retained journal temporary, the lock,
   * and the live journal) in the proven order and records every outcome in
   * the ledger. A real directory-sync failure is never collapsed onto
   * .wrkrs: every exact path whose removal was awaiting that sync stays
   * pending and is reported by name.
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
  }): Promise<void> => {
    let keptJournal = false
    try {
      await inDirectory(WRKRS_DIRECTORY, async (bound) => {
        // A journal temporary is only ever ours when a previous cleanup
        // failed; any other entry under that name belongs to someone else
        // and stays. One that is merely awaiting its sync is already gone.
        if (ledger.mayExist(journalTempPath)) {
          await removeNamed(bound, journalTempName, journalTempPath)
        }
        await removeNamed(bound, LOCK_FILE_NAME, LOCK_PATH)
        // The live journal is kept as the recovery record only when a name
        // could not be removed; a removal awaiting its sync is covered by
        // the sync below.
        keptJournal = options.keepJournalWhenRetained && ledger.hasRetained
        if (!keptJournal) await removeNamed(bound, JOURNAL_FILE_NAME, JOURNAL_PATH)
        try {
          noteSync(await bound.sync())
          ledger.directorySynced()
        } catch {
          // Every removal awaiting this sync keeps its exact path and is
          // reported as durability-unproven until a later sync proves it.
        }
      })
    } catch (error) {
      if (!(error instanceof ContainmentError && error.code === 'PATH_ANCESTOR_MISSING')) {
        // .wrkrs itself is named only when the directory could not be bound.
        ledger.retain(WRKRS_DIRECTORY, describeFailure(error))
      }
    }
    // The directory is removed unless it was deliberately kept as the
    // recovery location; when it cannot be removed (for example because a
    // retained entry is still inside) that failure is reported for .wrkrs
    // itself, never as a substitute for an individual file.
    if (options.removeCreatedDirectory && wrkrsCreated && !keptJournal) {
      const leftover = await removeCreatedWrkrs(inDirectory, noteSync)
      if (leftover) ledger.retain(leftover.path, leftover.reason)
    }
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
    await releaseBookkeeping({ keepJournalWhenRetained: false, removeCreatedDirectory: true })
    const remaining = ledger.entries()
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
  for (const operation of mutations) {
    for (const ancestor of ancestorDirectories(operation.path)) {
      if (plan.createdDirectories.includes(ancestor) && !listedDirectories.has(ancestor)) {
        journalOperations.push(plannedOperation(ancestor, 'create-directory'))
        listedDirectories.add(ancestor)
      }
    }
    const kind = JOURNAL_KIND[operation.outcome as 'create' | 'replace' | 'remove']
    // A removal has no proposed content: its expected hash is the content that
    // must still be there for the removal to be allowed at all.
    const expectedHash =
      operation.outcome === 'remove'
        ? operation.expected.kind === 'file'
          ? operation.expected.hash
          : null
        : operation.proposedHash
    journalOperations.push(plannedOperation(operation.path, kind, 'planned', expectedHash))
  }
  // Directory removals are journaled for the record; they run after the
  // transaction commits, once every backup inside them has been released.
  for (const directory of plan.removedDirectories) {
    journalOperations.push(plannedOperation(directory, 'remove-directory'))
  }

  let journal: TransactionJournal = createJournal({
    transactionId,
    planDigest: plan.digest,
    startedAt,
    command: plan.command,
    operations: journalOperations,
  })
  const persist = async (next: TransactionJournal): Promise<TransactionJournal> => {
    try {
      const persisted = await persistJournal(fs, root, next, clock)
      // persistJournal only returns after a completed .wrkrs directory sync,
      // which also proves every bookkeeping removal pending in that directory.
      ledger.directorySynced()
      return persisted
    } catch (error) {
      if (error instanceof JournalTempRetainedError) {
        // A temporary that was removed but not synced stays reconcilable; one
        // that may still exist is retained until a later removal proves it gone.
        if (error.removed) ledger.awaitingSync(error.tempPath)
        else ledger.retain(error.tempPath, error.reason)
      }
      throw error
    }
  }

  try {
    journal = await persist(journal)
  } catch (error) {
    await releaseBookkeeping({ keepJournalWhenRetained: true, removeCreatedDirectory: true })
    const remaining = ledger.entries()
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
    await releaseBookkeeping({ keepJournalWhenRetained: true, removeCreatedDirectory: true })
    const remaining = ledger.entries()
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
  const removedPaths: string[] = []
  const createdDirectories: string[] = wrkrsCreated ? [WRKRS_DIRECTORY] : []
  const created = new Set(createdDirectories)

  // Advances the in-memory journal first, then attempts to persist it. The
  // in-memory record is what rollback reconciles against.
  const advance = async (next: TransactionJournal): Promise<void> => {
    journal = next
    journal = await persist(journal)
  }

  /** Records journal state after the commit point, where persistence can no longer fail the run. */
  const saveQuietly = async (next: TransactionJournal): Promise<void> => {
    journal = next
    try {
      journal = await persist(journal)
    } catch {
      // The committed result stands; the live journal keeps its last state.
    }
  }

  /** Syncs a directory; an I/O error propagates as a transaction failure. */
  const syncDirectory = async (directory: string): Promise<void> => {
    const sync = await inDirectory(directory, (bound) => bound.sync())
    journal = withDurability(journal, sync)
  }

  /**
   * Creates a new file: stage under an exclusive name, publish the target
   * atomically without ever replacing an existing entry, prove the staging
   * name gone, then verify the published bytes.
   */
  const applyCreate = async (operation: PlanOperation): Promise<void> => {
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

  /**
   * Replaces a file wrkrs already owns. The previous entry is hard-linked to a
   * sibling backup name before anything is overwritten, so rollback restores
   * the exact inode; the backup is released only once the whole transaction
   * has validated. Publication is a rename over the target, which is atomic
   * and, unlike creation, deliberately replaces the entry the manifest proves
   * wrkrs wrote.
   */
  const applyReplace = async (operation: PlanOperation): Promise<void> => {
    const bytes = operation.proposedBytes
    if (!bytes || operation.proposedHash === null || operation.mode === null) {
      throw new TransactionFailure(`Operation for ${operation.path} carries no content`)
    }
    if (operation.expected.kind !== 'file') {
      throw new TransactionFailure(`Replacement for ${operation.path} has no expected file state`)
    }
    const expectedHash = operation.proposedHash
    const previousHash = operation.expected.hash
    const directory = parentDirectory(operation.path) ?? ''
    const targetName = baseName(operation.path)
    const stagingName = stagingNameFor(operation.path, transactionId)
    const stagingPath = directory === '' ? stagingName : `${directory}/${stagingName}`
    const backupName = backupNameFor(operation.path, transactionId)
    const backupPath = directory === '' ? backupName : `${directory}/${backupName}`
    const mode = operation.mode

    // 1. Stage the new content under an exclusive name.
    await advance(
      withOperation(journal, operation.path, { status: 'staging', stagingPath, expectedHash }),
    )
    try {
      await inDirectory(directory, (bound) => bound.writeFileExclusive(stagingName, bytes, mode))
    } catch (error) {
      if (error instanceof FileSystemError && error.code === 'EEXIST') {
        journal = withOperation(journal, operation.path, {
          status: 'planned',
          stagingPath: null,
          note: 'staging name was already taken by another entry; it was left untouched',
        })
        throw new TransactionFailure(
          `Precondition failed: staging name for "${operation.path}" was already taken; the existing entry was left untouched`,
          { conflict: stagingNameTakenConflict(stagingPath) },
        )
      }
      if (error instanceof FileSystemError || error instanceof ContainmentError) {
        journal = withOperation(journal, operation.path, {
          status: 'planned',
          stagingPath: null,
          note: 'staging write failed before the entry was created',
        })
      }
      throw error
    }
    await advance(withOperation(journal, operation.path, { status: 'staged' }))

    // 2. Back up the current entry by hard link, announcing the name first so
    //    no failure can hide it. The backup shares the original inode, so it
    //    holds the exact previous bytes and mode.
    await advance(withOperation(journal, operation.path, { backupPath, backupHash: previousHash }))
    try {
      await inDirectory(directory, (bound) => bound.linkExclusive(targetName, backupName))
    } catch (error) {
      if (error instanceof FileSystemError && error.code === 'EEXIST') {
        journal = withOperation(journal, operation.path, {
          backupPath: null,
          backupHash: null,
          note: 'backup name was already taken by another entry; it was left untouched',
        })
        throw new TransactionFailure(
          `Precondition failed: backup name for "${operation.path}" was already taken; nothing was replaced`,
          { conflict: backupNameTakenConflict(backupPath) },
        )
      }
      if (error instanceof FileSystemError || error instanceof ContainmentError) {
        journal = withOperation(journal, operation.path, {
          backupPath: null,
          backupHash: null,
          note: 'backup link failed before the entry was created',
        })
      }
      throw error
    }
    journal = withOperation(journal, operation.path, { status: 'backed-up' })
    await syncDirectory(directory)
    await advance(journal)

    // 3. Publish: rename the staging entry over the target. The rename
    //    consumes the staging name, so nothing is left to clean up.
    await inDirectory(directory, (bound) => bound.rename(stagingName, targetName))
    journal = withOperation(journal, operation.path, { status: 'published', stagingPath: null })
    await syncDirectory(directory)
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

  /**
   * Removes a file wrkrs owns. The entry is hard-linked to a sibling backup
   * before it is unlinked, so the content survives until the transaction
   * commits and rollback can restore the exact inode.
   */
  const applyRemove = async (operation: PlanOperation): Promise<void> => {
    if (operation.expected.kind !== 'file') {
      throw new TransactionFailure(`Removal of ${operation.path} has no expected file state`)
    }
    const previousHash = operation.expected.hash
    const directory = parentDirectory(operation.path) ?? ''
    const targetName = baseName(operation.path)
    const backupName = backupNameFor(operation.path, transactionId)
    const backupPath = directory === '' ? backupName : `${directory}/${backupName}`

    // 1. Back up by hard link, announcing the name before creating it.
    await advance(withOperation(journal, operation.path, { backupPath, backupHash: previousHash }))
    try {
      await inDirectory(directory, (bound) => bound.linkExclusive(targetName, backupName))
    } catch (error) {
      if (error instanceof FileSystemError && error.code === 'EEXIST') {
        journal = withOperation(journal, operation.path, {
          backupPath: null,
          backupHash: null,
          note: 'backup name was already taken by another entry; it was left untouched',
        })
        throw new TransactionFailure(
          `Precondition failed: backup name for "${operation.path}" was already taken; nothing was removed`,
          { conflict: backupNameTakenConflict(backupPath) },
        )
      }
      if (error instanceof FileSystemError || error instanceof ContainmentError) {
        journal = withOperation(journal, operation.path, {
          backupPath: null,
          backupHash: null,
          note: 'backup link failed before the entry was created',
        })
      }
      throw error
    }
    journal = withOperation(journal, operation.path, { status: 'backed-up' })
    await syncDirectory(directory)
    await advance(journal)

    // 2. Unlink the target and prove it absent before recording the removal.
    await inDirectory(directory, async (bound) => {
      try {
        await bound.unlink(targetName)
      } catch (error) {
        if (!(error instanceof FileSystemError && error.code === 'ENOENT')) throw error
      }
      if (await bound.lstat(targetName)) {
        throw new TransactionFailure(`${operation.path} is still present after removal`)
      }
    })
    journal = withOperation(journal, operation.path, { status: 'removed' })
    await syncDirectory(directory)
    await advance(journal)
    removedPaths.push(operation.path)
  }

  let failingPath: string | null = null

  try {
    await advance(withStatus(journal, 'applying'))

    for (const operation of mutations) {
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
      if (operation.outcome === 'create') await applyCreate(operation)
      else if (operation.outcome === 'replace') await applyReplace(operation)
      else await applyRemove(operation)
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

    // Commit before any backup is released: from here the new state is the
    // one wrkrs stands behind, and a crash finds a committed journal that
    // still names every backup it had not cleaned up yet.
    await advance(withStatus(journal, 'committed'))

    // Backups kept the previous bytes alive for rollback. Now that the
    // transaction has validated they are released; a failure here leaves a
    // named file behind but never changes the committed result.
    const retainedBackups: RetainedPath[] = []
    const hadBackups = journal.operations.some((operation) => operation.backupPath !== null)
    for (const operation of journal.operations) {
      const backupPath = operation.backupPath
      if (!backupPath) continue
      const directory = parentDirectory(backupPath) ?? ''
      const name = baseName(backupPath)
      try {
        const sync = await inDirectory(directory, async (bound) => {
          try {
            await bound.unlink(name)
          } catch (error) {
            if (!(error instanceof FileSystemError && error.code === 'ENOENT')) throw error
          }
          if (await bound.lstat(name)) {
            throw new FileSystemError('EEXIST', name, 'still present after removal')
          }
          return bound.sync()
        })
        journal = withDurability(
          withOperation(journal, operation.path, { backupPath: null, backupHash: null }),
          sync,
        )
      } catch (error) {
        retainedBackups.push({ path: backupPath, reason: describeFailure(error) })
      }
    }
    // A plan that replaced or removed nothing has no backup to release, so it
    // writes no extra journal revision here.
    if (hadBackups) await saveQuietly(journal)

    // Only transient bookkeeping (lock, journal temporary, live journal) is
    // removed after a successful commit; the installed .wrkrs directory and
    // its repository-owned contents stay unless the plan removes them.
    await releaseBookkeeping({ keepJournalWhenRetained: false, removeCreatedDirectory: false })

    // Directories the plan retires are removed last, once every backup and
    // every bookkeeping file inside them is gone. Deepest first, empty only.
    const removedDirectories: string[] = []
    const retainedDirectories: RetainedPath[] = []
    for (const directory of plan.removedDirectories) {
      const outcome = await removeEmptyDirectory(inDirectory, directory, noteSync)
      if (outcome === null) removedDirectories.push(directory)
      else retainedDirectories.push(outcome)
    }

    const leftovers = ledger.entries()
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
    for (const item of retainedBackups) {
      diagnostics.push(
        createDiagnostic(
          'TRANSACTION_BACKUP_RETAINED',
          'warning',
          `The backup of a replaced or removed file could not be released: ${item.path} (${item.reason})`,
          {
            path: item.path,
            remediation: 'Delete the file; the change it protected is already applied and verified',
          },
        ),
      )
    }
    for (const item of retainedDirectories) {
      diagnostics.push(
        createDiagnostic(
          'DIRECTORY_RETAINED',
          'warning',
          `Directory was left in place: ${item.path} (${item.reason})`,
          {
            path: item.path,
            remediation:
              'Review the remaining entries and remove the directory manually if it is no longer wanted',
          },
        ),
      )
    }
    return {
      status: 'applied',
      transactionId,
      appliedPaths,
      removedPaths,
      createdDirectories,
      removedDirectories,
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
      // and clears it from the ledger once its removal is proven, so a
      // transient failure does not surface a stale retained path. Ledger
      // state is read once, at the end, so a later proven sync is never
      // reported from a stale copy.
      await releaseBookkeeping({ keepJournalWhenRetained: true, removeCreatedDirectory: true })
      // Final proof: every directory this transaction created must be gone.
      for (const directory of [...createdDirectories].reverse()) {
        if (retained.has(directory) || ledger.has(directory)) continue
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
      if (retained.size === 0 && ledger.isEmpty) {
        return {
          status: 'rolled-back',
          transactionId,
          failure,
          conflict: failureConflict,
          diagnostics,
        }
      }
    }

    // Release the lock through the same durable removal contract used
    // everywhere else (unlink, verify absence, sync, then forget). The exact
    // path stays pending in the ledger until a completed .wrkrs sync — this
    // one or the final journal write below — proves the removal durable.
    try {
      await inDirectory(WRKRS_DIRECTORY, async (bound) => {
        await removeNamed(bound, LOCK_FILE_NAME, LOCK_PATH)
        try {
          journal = withDurability(journal, await bound.sync())
          ledger.directorySynced()
        } catch {
          // Pending removals keep their exact paths; the final journal write
          // syncs the same directory and reconciles them when it succeeds.
        }
      })
    } catch (releaseError) {
      if (!(
        releaseError instanceof ContainmentError && releaseError.code === 'PATH_ANCESTOR_MISSING'
      )) {
        ledger.retain(LOCK_PATH, describeFailure(releaseError))
      }
    }
    // A removal that is not proven durable must not be recorded under a
    // strict durability claim, so the persisted journal and the reported
    // paths cannot contradict each other.
    if (ledger.hasUnproven) journal = withoutStrictDurability(journal)
    try {
      await persist(withStatus(journal, 'rollback-incomplete', failure))
    } catch {
      // The live journal remains the recovery record in its last persisted state.
    }
    // Read the ledger once, after the last sync that could prove a removal.
    for (const item of ledger.entries()) retained.set(item.path, item.reason)
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

/**
 * Removes one directory a plan retires: rmdir, verify absence, sync the
 * parent. Returns null when the directory is gone (or was already absent) and
 * the exact retained entry when it is not. A directory that still holds
 * entries is never forced: it is reported and left alone.
 */
async function removeEmptyDirectory(
  inDirectory: <T>(
    directory: string,
    operation: (bound: BoundDirectory) => Promise<T>,
  ) => Promise<T>,
  directory: string,
  noteSync: (sync: DirectorySyncResult) => void,
): Promise<RetainedPath | null> {
  const parent = parentDirectory(directory) ?? ''
  const name = baseName(directory)
  try {
    return await inDirectory(parent, async (bound) => {
      try {
        await bound.removeDirectory(name)
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'ENOENT') return null
        if (error instanceof FileSystemError && error.code === 'ENOTEMPTY') {
          return {
            path: directory,
            reason: 'the directory still holds entries wrkrs does not own',
          }
        }
        return { path: directory, reason: describeFailure(error) }
      }
      if (await bound.lstat(name)) {
        return { path: directory, reason: 'still present after removal' }
      }
      try {
        noteSync(await bound.sync())
      } catch {
        return { path: directory, reason: DURABILITY_UNPROVEN }
      }
      return null
    })
  } catch (error) {
    if (error instanceof ContainmentError && error.code === 'PATH_ANCESTOR_MISSING') return null
    return { path: directory, reason: describeFailure(error) }
  }
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
