import { createDiagnostic, hasErrors, type Diagnostic } from '../core/diagnostics.js'
import {
  JOURNAL_PATH,
  LOCK_PATH,
  WRKRS_DIRECTORY,
  type JournalOperation,
  type TransactionJournal,
} from '../core/ownership.js'
import type { Conflict, InstallPlan, PlanOperation } from '../core/plan.js'
import {
  AtomicPublicationUnsupportedError,
  ContainmentError,
  FileSystemError,
  type ClockPort,
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
  if (error instanceof ContainmentError) return `${error.code}: ${error.message}`
  if (error instanceof AtomicPublicationUnsupportedError) return error.message
  if (error instanceof FileSystemError) return `${error.code} at ${error.path}`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Turns a low-level failure raised while operating on `path` into a stable conflict where one applies. */
function conflictFor(error: unknown, path: string): Conflict | null {
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

/**
 * Applies a validated, unblocked plan through a journaled transaction:
 * lock, recheck, staged writes in deterministic order, atomic no-replace
 * publication, separate verified staging cleanup, post-publication hash
 * verification, validation, and hash-guarded reverse rollback on any failure.
 *
 * Every filesystem step runs inside a bound parent directory
 * (FileSystemPort.withinDirectory), so a symlinked or swapped ancestor makes
 * the step fail closed rather than touch anything outside the repository.
 *
 * Journal state is advanced in memory before each attempt to persist it and
 * before each fallible cleanup, so neither a persistence failure nor a
 * staging-cleanup failure can hide a name wrkrs created, and every journal
 * write replaces the file atomically so the previous record survives.
 */
export async function applyPlan(input: ApplyInput, ports: WriterPorts): Promise<ApplyResult> {
  const { plan } = input
  const { fs, clock, ids } = ports
  const root = plan.repositoryRoot

  if (plan.blockers.length > 0) {
    return { status: 'aborted', conflicts: plan.blockers }
  }
  const creates = orderedCreates(plan)
  if (creates.length === 0) {
    return {
      status: 'applied',
      transactionId: '',
      appliedPaths: [],
      createdDirectories: [],
      diagnostics: [],
    }
  }

  const inDirectory = <T>(
    directory: string,
    operation: Parameters<FileSystemPort['withinDirectory']>[2] extends (
      d: infer D,
    ) => Promise<unknown>
      ? (bound: D) => Promise<T>
      : never,
  ): Promise<T> => fs.withinDirectory(root, directory, operation)

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
      const found = conflictFor(error, JOURNAL_PATH)
      return {
        status: 'aborted',
        conflicts: found
          ? [found]
          : [
              conflict(
                'PRECONDITION',
                'PRECONDITION_TARGET_CHANGED',
                WRKRS_DIRECTORY,
                describeFailure(error),
                REPLAN,
              ),
            ],
      }
    }
  }

  const before = await recheckPreconditions(plan, root, fs)
  if (before.length > 0) return { status: 'aborted', conflicts: before }

  const transactionId = ids.uuid()
  const startedAt = formatTimestamp(clock.now())
  const journalTempName = journalStagingName(transactionId)

  // The lock lives inside .wrkrs, so that directory is the one piece of
  // bookkeeping that may exist before the lock is held. It is a planned
  // created directory and is removed again on any abort or complete rollback.
  let wrkrsCreated = false
  let wrkrsPresent: boolean
  try {
    wrkrsPresent = (await inDirectory('', (bound) => bound.lstat(WRKRS_DIRECTORY))) !== null
  } catch (error) {
    const found = conflictFor(error, WRKRS_DIRECTORY)
    return {
      status: 'aborted',
      conflicts: found
        ? [found]
        : [
            conflict(
              'PRECONDITION',
              'PRECONDITION_TARGET_CHANGED',
              WRKRS_DIRECTORY,
              describeFailure(error),
              REPLAN,
            ),
          ],
    }
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
      await inDirectory('', (bound) =>
        bound.makeDirectory(WRKRS_DIRECTORY, GENERATED_DIRECTORY_MODE),
      )
    } catch (error) {
      const found = conflictFor(error, WRKRS_DIRECTORY)
      return {
        status: 'aborted',
        conflicts: [
          found ??
            conflict(
              'PRECONDITION',
              'PRECONDITION_TARGET_CHANGED',
              WRKRS_DIRECTORY,
              `Could not create .wrkrs (${describeFailure(error)})`,
              REPLAN,
            ),
        ],
      }
    }
    wrkrsCreated = true
  }

  /** Removes bookkeeping; returns the paths that could not be removed. */
  const releaseBookkeeping = async (): Promise<string[]> => {
    const remaining: string[] = []
    try {
      await inDirectory(WRKRS_DIRECTORY, async (bound) => {
        for (const [name, path] of [
          [journalTempName, `${JOURNAL_PATH} (temporary)`],
          [JOURNAL_FILE_NAME, JOURNAL_PATH],
          [LOCK_FILE_NAME, LOCK_PATH],
        ] as const) {
          try {
            await bound.unlink(name)
          } catch (error) {
            if (!(error instanceof FileSystemError && error.code === 'ENOENT')) remaining.push(path)
          }
        }
        await bound.sync().catch(() => 'unsupported' as const)
      })
    } catch (error) {
      if (!(error instanceof ContainmentError && error.code === 'PATH_ANCESTOR_MISSING')) {
        remaining.push(JOURNAL_PATH, LOCK_PATH)
      }
    }
    if (wrkrsCreated) {
      try {
        await inDirectory('', async (bound) => {
          await bound.removeDirectory(WRKRS_DIRECTORY)
          await bound.sync().catch(() => 'unsupported' as const)
        })
      } catch (error) {
        if (!(error instanceof FileSystemError && error.code === 'ENOENT')) {
          remaining.push(WRKRS_DIRECTORY)
        }
      }
    }
    return remaining
  }

  const lockContent = JSON.stringify(
    { transactionId, pid: ports.environment.processId, startedAt },
    null,
    2,
  )
  try {
    await inDirectory(WRKRS_DIRECTORY, (bound) =>
      bound.writeFileExclusive(LOCK_FILE_NAME, new TextEncoder().encode(lockContent + '\n'), 0o644),
    )
  } catch (error) {
    if (wrkrsCreated) {
      await inDirectory('', (bound) => bound.removeDirectory(WRKRS_DIRECTORY)).catch(
        () => undefined,
      )
    }
    const code = error instanceof FileSystemError ? error.code : 'EUNKNOWN'
    const found = conflictFor(error, LOCK_PATH)
    return {
      status: 'aborted',
      conflicts: [
        found ??
          conflict(
            'OWNERSHIP',
            code === 'EEXIST' ? 'OWNERSHIP_LOCK_PRESENT' : 'OWNERSHIP_LOCK_FAILED',
            LOCK_PATH,
            code === 'EEXIST'
              ? 'Another wrkrs installation holds the lock'
              : `Could not acquire the installation lock (${code})`,
            'Ensure no other wrkrs process is running, then remove a stale lock file and retry',
          ),
      ],
    }
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
  const persist = (next: TransactionJournal) => persistJournal(fs, root, next, clock)

  try {
    journal = await persist(journal)
  } catch (error) {
    const remaining = await releaseBookkeeping()
    if (remaining.length > 0) {
      return {
        status: 'rollback-incomplete',
        transactionId,
        failure: `Could not write the transaction journal (${describeFailure(error)})`,
        conflict: conflictFor(error, JOURNAL_PATH),
        retained: remaining.map((path) => ({ path, reason: 'bookkeeping could not be removed' })),
        journalPath: JOURNAL_PATH,
        diagnostics: [],
      }
    }
    return {
      status: 'aborted',
      conflicts: [
        conflictFor(error, JOURNAL_PATH) ??
          conflict(
            'PRECONDITION',
            'PRECONDITION_JOURNAL_UNWRITABLE',
            JOURNAL_PATH,
            `Could not write the transaction journal (${describeFailure(error)})`,
            'Check filesystem permissions and retry',
          ),
      ],
    }
  }

  const after = await recheckPreconditions(plan, root, fs, {
    allowExistingDirectories: new Set(wrkrsCreated ? [WRKRS_DIRECTORY] : []),
  })
  if (after.length > 0) {
    await releaseBookkeeping()
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

      // 1. Stage: full content written and fsynced under a temporary name in the bound directory.
      await inDirectory(directory, (bound) => bound.writeFileExclusive(stagingName, bytes, mode))
      await advance(
        withOperation(journal, operation.path, { status: 'staged', stagingPath, expectedHash }),
      )

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

      // 3. Clean up the staging name and prove it is gone before dropping it from the journal.
      await inDirectory(directory, async (bound) => {
        try {
          await bound.unlink(stagingName)
        } catch (error) {
          if (!(error instanceof FileSystemError && error.code === 'ENOENT')) throw error
        }
        if (await bound.lstat(stagingName)) {
          throw new TransactionFailure(`Staging file for ${operation.path} could not be removed`)
        }
      })
      journal = withOperation(journal, operation.path, { stagingPath: null })
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
    if (journal.durability === 'best-effort') {
      diagnostics.push(
        createDiagnostic(
          'TRANSACTION_DURABILITY_BEST_EFFORT',
          'warning',
          'The filesystem could not sync directory entries; the installation is complete but a power loss before the operating system flushes its caches could revert it',
          {
            remediation: 'No action is required; re-run `wrkrs check` after an unexpected shutdown',
          },
        ),
      )
    }
    const leftovers = await releaseBookkeeping()
    for (const path of leftovers) {
      diagnostics.push(
        createDiagnostic(
          'TRANSACTION_BOOKKEEPING_RETAINED',
          'warning',
          `Transaction bookkeeping could not be removed: ${path}`,
          { path, remediation: 'Remove the file manually' },
        ),
      )
    }
    return { status: 'applied', transactionId, appliedPaths, createdDirectories, diagnostics }
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
      const leftovers = await releaseBookkeeping()
      for (const path of leftovers) retained.set(path, 'bookkeeping could not be removed')
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

    try {
      await persist(withStatus(journal, 'rollback-incomplete', failure))
    } catch {
      // The retained paths are reported to the caller regardless.
    }
    await inDirectory(WRKRS_DIRECTORY, async (bound) => {
      for (const name of [journalTempName, LOCK_FILE_NAME]) {
        await bound.unlink(name).catch(() => undefined)
      }
    }).catch(() => undefined)
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
