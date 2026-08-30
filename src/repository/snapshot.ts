import type { DirectoryEntry, FileStat } from '../core/ports.js'
import type {
  AncestorSnapshot,
  ContainmentState,
  DirectoryListing,
  FileSnapshot,
  TargetSnapshot,
} from '../core/snapshot.js'
import type { ContainmentFailure, RepositoryReader } from '../platform/contained-path.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories, joinRelativePath, parentDirectory } from '../platform/paths.js'

/** Files larger than this are never parsed or hashed by the scanner. */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024
export const MAX_INDEXED_ENTRIES = 5000
export const MAX_INDEX_DEPTH = 8
/** Upper bound on names kept per directory listing used for collision proofs. */
export const MAX_LISTING_ENTRIES = 50_000

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'DerivedData',
  'Pods',
  'target',
])

/**
 * Scan context used by detectors. Every access goes through the contained
 * reader; a containment failure (symlinked ancestor, escape from the root,
 * symlinked target, oversized file) is recorded once per offending path and
 * the access behaves as if the path were absent, so nothing outside the
 * worktree is ever read or echoed.
 */
export interface ScanContext {
  readonly root: string
  readonly reader: RepositoryReader
  readonly failures: ReadonlyMap<string, ContainmentFailure>
  stat(relativePath: string): Promise<FileStat | null>
  /** UTF-8 text of a regular file, or null when missing, unsafe, not a file, or too large. */
  readText(relativePath: string): Promise<string | null>
  snapshotPath(relativePath: string): Promise<FileSnapshot | null>
  /** Entries of a real directory; empty when absent or unsafe. The empty path lists the root. */
  listDirectory(relativePath: string): Promise<readonly DirectoryEntry[]>
}

export function createScanContext(reader: RepositoryReader): ScanContext {
  const failures = new Map<string, ContainmentFailure>()
  const record = (failure: ContainmentFailure): void => {
    const key = failure.ancestor ?? failure.path
    if (!failures.has(key)) failures.set(key, failure)
  }

  return {
    root: reader.root,
    reader,
    failures,
    async stat(relativePath) {
      const resolved = await reader.resolve(relativePath)
      if (!resolved.ok) {
        record(resolved.error)
        return null
      }
      return resolved.value.stat
    },
    async readText(relativePath) {
      const text = await reader.readText(relativePath, MAX_SCANNED_FILE_BYTES)
      if (!text.ok) {
        record(text.error)
        return null
      }
      return text.value
    },
    async snapshotPath(relativePath) {
      const resolved = await reader.resolve(relativePath)
      if (!resolved.ok) {
        record(resolved.error)
        return null
      }
      const { stat, relativePath: path } = resolved.value
      if (!stat) return null
      let hash: string | null = null
      if (stat.kind === 'file' && stat.size <= MAX_SCANNED_FILE_BYTES) {
        const bytes = await reader.readBytes(path, MAX_SCANNED_FILE_BYTES)
        if (bytes.ok && bytes.value) hash = sha256(bytes.value)
      }
      return { path, kind: stat.kind, size: stat.size, mode: stat.mode, hash }
    },
    async listDirectory(relativePath) {
      const entries = await reader.listDirectory(relativePath)
      if (!entries.ok) {
        record(entries.error)
        return []
      }
      return entries.value ?? []
    },
  }
}

export interface IndexResult {
  readonly truncated: boolean
}

/**
 * Indexes a directory tree into the snapshot file map without following
 * symlinks. Bounded by depth and entry count so a large repository cannot
 * make planning unbounded; exact targets are captured separately by
 * snapshotTargets so truncation never hides a known target.
 */
export async function indexTree(
  context: ScanContext,
  relativeDirectory: string,
  index: Map<string, FileSnapshot>,
  options: { depth?: number; maxEntries?: number } = {},
): Promise<IndexResult> {
  const maxDepth = options.depth ?? MAX_INDEX_DEPTH
  const maxEntries = options.maxEntries ?? MAX_INDEXED_ENTRIES
  let truncated = false

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      truncated = true
      return
    }
    const entries = await context.listDirectory(directory)
    for (const entry of entries) {
      if (index.size >= maxEntries) {
        truncated = true
        return
      }
      const relativePath = joinRelativePath(directory, entry.name)
      const snapshot = await context.snapshotPath(relativePath)
      if (!snapshot) continue
      index.set(relativePath, snapshot)
      if (snapshot.kind === 'directory' && !SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(relativePath, depth + 1)
      }
    }
  }

  const rootSnapshot = await context.snapshotPath(relativeDirectory)
  if (rootSnapshot) {
    index.set(relativeDirectory, rootSnapshot)
    if (rootSnapshot.kind === 'directory') {
      await walk(relativeDirectory, 1)
    }
  }
  return { truncated }
}

export function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name)
}

function containmentState(failure: ContainmentFailure): ContainmentState {
  switch (failure.code) {
    case 'PATH_ANCESTOR_SYMLINK':
      return 'ancestor-symlink'
    case 'PATH_ANCESTOR_NOT_A_DIRECTORY':
      return 'ancestor-not-directory'
    case 'PATH_ESCAPES_ROOT':
      return 'escapes-root'
    case 'PATH_INVALID':
      return 'invalid-path'
    default:
      return 'escapes-root'
  }
}

export interface TargetCapture {
  readonly targets: ReadonlyMap<string, TargetSnapshot>
  readonly listings: ReadonlyMap<string, DirectoryListing>
}

/**
 * Captures the exact state of every desired generated target and its
 * ancestors, plus a listing of each existing parent directory, independently
 * of the bounded generic index. The planner classifies from these alone.
 */
export async function captureTargets(
  context: ScanContext,
  paths: readonly string[],
  listingLimit = MAX_LISTING_ENTRIES,
): Promise<TargetCapture> {
  const targets = new Map<string, TargetSnapshot>()
  const listings = new Map<string, DirectoryListing>()
  const existingDirectories = new Set<string>([''])

  const ensureListing = async (directory: string): Promise<void> => {
    if (listings.has(directory) || !existingDirectories.has(directory)) return
    const entries = await context.reader.listDirectory(directory)
    if (!entries.ok || entries.value === null) {
      listings.set(directory, { path: directory, names: [], complete: false })
      return
    }
    const names = entries.value.map((entry) => entry.name)
    listings.set(directory, {
      path: directory,
      names: names.slice(0, listingLimit),
      complete: names.length <= listingLimit,
    })
  }

  for (const path of [...new Set(paths)].sort()) {
    const ancestors: AncestorSnapshot[] = []
    let containment: ContainmentState = 'ok'
    let blockingAncestor: string | null = null
    let reachable = true

    for (const ancestor of ancestorDirectories(path)) {
      const probe = await context.reader.resolve(ancestor)
      if (!probe.ok) {
        containment = containmentState(probe.error)
        blockingAncestor = probe.error.ancestor ?? ancestor
        reachable = false
        break
      }
      const kind = probe.value.stat?.kind ?? null
      ancestors.push({ path: ancestor, kind })
      if (kind === null) {
        reachable = false
        break
      }
      if (kind === 'symlink') {
        containment = 'ancestor-symlink'
        blockingAncestor = ancestor
        reachable = false
        break
      }
      if (kind !== 'directory') {
        containment = 'ancestor-not-directory'
        blockingAncestor = ancestor
        reachable = false
        break
      }
      existingDirectories.add(ancestor)
    }

    let file: FileSnapshot | null = null
    if (containment === 'ok' && reachable) {
      const resolved = await context.reader.resolve(path)
      if (!resolved.ok) {
        containment = containmentState(resolved.error)
        blockingAncestor = resolved.error.ancestor
      } else if (resolved.value.stat) {
        const stat = resolved.value.stat
        let hash: string | null = null
        if (stat.kind === 'file' && stat.size <= MAX_SCANNED_FILE_BYTES) {
          const bytes = await context.reader.readBytes(path, MAX_SCANNED_FILE_BYTES)
          if (bytes.ok && bytes.value) hash = sha256(bytes.value)
        }
        file = { path, kind: stat.kind, size: stat.size, mode: stat.mode, hash }
      }
    }
    targets.set(path, { path, containment, blockingAncestor, ancestors, file })

    if (containment === 'ok') {
      for (const candidate of [path, ...ancestorDirectories(path)]) {
        await ensureListing(parentDirectory(candidate) ?? '')
      }
    }
  }

  return { targets, listings }
}
