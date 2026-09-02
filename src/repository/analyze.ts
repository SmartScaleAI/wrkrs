import { createFinding, sortFindings, type Finding } from '../core/findings.js'
import { WRKRS_DIRECTORY } from '../core/ownership.js'
import type { FileSystemPort } from '../core/ports.js'
import type { FileSnapshot, RepositorySnapshot } from '../core/snapshot.js'
import { createRepositoryReader, type ContainmentFailure } from '../platform/contained-path.js'
import { detectClaudeCode } from './detectors/claude-code.js'
import { detectProject } from './detectors/project.js'
import { detectWrkrs } from './detectors/wrkrs.js'
import type { LocatedRepository } from './locate.js'
import {
  captureTargets,
  createScanContext,
  indexTree,
  MAX_INDEXED_ENTRIES,
  MAX_LISTING_ENTRIES,
} from './snapshot.js'

export const CLAUDE_DIRECTORY = '.claude'

export interface AnalyzeOptions {
  /** Entry bound for the generic .claude/.wrkrs index. */
  readonly indexLimit?: number
  /** Name bound for the per-directory listings used in collision proofs. */
  readonly listingLimit?: number
}

function containmentFindings(failures: ReadonlyMap<string, ContainmentFailure>): Finding[] {
  return [...failures.values()].map((failure) =>
    createFinding(
      'SCAN_PATH_UNSAFE',
      'warning',
      `${failure.message}; nothing beneath it was read`,
      {
        path: failure.ancestor ?? failure.path,
        evidence: [{ key: 'code', value: failure.code }],
      },
    ),
  )
}

/**
 * Read-only repository analysis. Produces a snapshot with bounded project
 * signals, Claude Code configuration presence, existing wrkrs state, and a
 * bounded file index of the trees that planning must reason about. Every
 * read goes through the contained reader, so symlinked ancestors are never
 * followed.
 */
export async function analyzeRepository(
  repository: LocatedRepository,
  fs: FileSystemPort,
  options: AnalyzeOptions = {},
): Promise<RepositorySnapshot> {
  const reader = await createRepositoryReader(repository.root, fs)
  const context = createScanContext(reader)
  const findings: Finding[] = []

  if (repository.dirty) {
    findings.push(
      createFinding(
        'GIT_WORKTREE_DIRTY',
        'warning',
        'The Git worktree has uncommitted changes; wrkrs never touches unrelated files',
      ),
    )
  }

  const project = await detectProject(context)
  const claude = await detectClaudeCode(context)
  const wrkrs = await detectWrkrs(context)
  findings.push(...project.findings, ...claude.findings, ...wrkrs.findings)

  const files = new Map<string, FileSnapshot>()
  const rootEntries = await context.listDirectory('')
  for (const entry of rootEntries) {
    const snapshot = await context.snapshotPath(entry.name)
    if (snapshot) files.set(entry.name, snapshot)
  }
  const indexOptions = { maxEntries: options.indexLimit ?? MAX_INDEXED_ENTRIES }
  const claudeIndex = await indexTree(context, CLAUDE_DIRECTORY, files, indexOptions)
  const wrkrsIndex = await indexTree(context, WRKRS_DIRECTORY, files, indexOptions)
  const indexTruncated = claudeIndex.truncated || wrkrsIndex.truncated
  if (indexTruncated) {
    findings.push(
      createFinding(
        'SCAN_INDEX_TRUNCATED',
        'warning',
        'The .claude or .wrkrs tree exceeded the generic scan bound; generated targets are still inspected exactly',
      ),
    )
  }
  findings.push(...containmentFindings(context.failures))

  return {
    root: repository.root,
    git: { root: repository.root, dirty: repository.dirty },
    projectSignals: project.signals,
    claude: claude.claude,
    wrkrs: wrkrs.wrkrs,
    files,
    targets: new Map(),
    listings: new Map(),
    scan: { indexTruncated, listingLimit: options.listingLimit ?? MAX_LISTING_ENTRIES },
    findings: sortFindings(findings),
  }
}

/**
 * Captures exact snapshots of the desired generated targets (and their
 * ancestors and parent listings) once the runtime adapters and providers have
 * compiled the desired state. Returns a new snapshot; the input is unchanged.
 */
export async function snapshotTargets(
  snapshot: RepositorySnapshot,
  paths: readonly string[],
  fs: FileSystemPort,
  options: AnalyzeOptions = {},
): Promise<RepositorySnapshot> {
  const reader = await createRepositoryReader(snapshot.root, fs)
  const context = createScanContext(reader)
  const capture = await captureTargets(
    context,
    paths,
    options.listingLimit ?? snapshot.scan.listingLimit,
  )
  const known = new Set(snapshot.findings.map((finding) => `${finding.code}:${finding.path ?? ''}`))
  const additional = containmentFindings(context.failures).filter(
    (finding) => !known.has(`${finding.code}:${finding.path ?? ''}`),
  )
  return {
    ...snapshot,
    targets: capture.targets,
    listings: capture.listings,
    findings: sortFindings([...snapshot.findings, ...additional]),
  }
}
