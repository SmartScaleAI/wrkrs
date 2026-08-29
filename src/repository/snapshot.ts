import type { DirectoryEntry, FileStat, FileSystemPort } from '../core/ports.js'
import type { FileSnapshot } from '../core/snapshot.js'
import { sha256 } from '../platform/hash.js'
import { joinRelativePath, toSystemPath } from '../platform/paths.js'

/** Files larger than this are never parsed or hashed by the scanner. */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024
export const MAX_INDEXED_ENTRIES = 5000
export const MAX_INDEX_DEPTH = 8

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

export interface ScanContext {
  readonly root: string
  readonly fs: FileSystemPort
  stat(relativePath: string): Promise<FileStat | null>
  /** UTF-8 text of a regular file, or null when missing, not a file, or too large. */
  readText(relativePath: string): Promise<string | null>
  snapshotPath(relativePath: string): Promise<FileSnapshot | null>
  listDirectory(relativePath: string): Promise<readonly DirectoryEntry[]>
}

export function createScanContext(root: string, fs: FileSystemPort): ScanContext {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return {
    root,
    fs,
    stat(relativePath) {
      return fs.lstat(toSystemPath(root, relativePath))
    },
    async readText(relativePath) {
      const systemPath = toSystemPath(root, relativePath)
      const stat = await fs.lstat(systemPath)
      if (!stat || stat.kind !== 'file' || stat.size > MAX_SCANNED_FILE_BYTES) return null
      return decoder.decode(await fs.readFile(systemPath))
    },
    async snapshotPath(relativePath) {
      const systemPath = toSystemPath(root, relativePath)
      const stat = await fs.lstat(systemPath)
      if (!stat) return null
      let hash: string | null = null
      if (stat.kind === 'file' && stat.size <= MAX_SCANNED_FILE_BYTES) {
        hash = sha256(await fs.readFile(systemPath))
      }
      return { path: relativePath, kind: stat.kind, size: stat.size, mode: stat.mode, hash }
    },
    async listDirectory(relativePath) {
      const systemPath = relativePath === '' ? root : toSystemPath(root, relativePath)
      const stat = await fs.lstat(systemPath)
      if (!stat || stat.kind !== 'directory') return []
      return fs.readDirectory(systemPath)
    },
  }
}

export interface IndexResult {
  readonly truncated: boolean
}

/**
 * Indexes a directory tree into the snapshot file map without following
 * symlinks. Bounded by depth and entry count so a large repository cannot
 * make planning unbounded.
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

  const rootStat = await context.stat(relativeDirectory)
  if (rootStat) {
    const rootSnapshot = await context.snapshotPath(relativeDirectory)
    if (rootSnapshot) index.set(relativeDirectory, rootSnapshot)
    if (rootStat.kind === 'directory') {
      await walk(relativeDirectory, 1)
    }
  }
  return { truncated }
}

export function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name)
}
