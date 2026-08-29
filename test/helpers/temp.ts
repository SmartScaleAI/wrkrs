import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  lstatSync,
  readlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const FIXTURES_ROOT = path.join(REPOSITORY_ROOT, 'test', 'fixtures')
export const COMPILED_CLI = path.join(REPOSITORY_ROOT, 'dist', 'cli', 'index.js')

export type FixtureName = 'clean-repository' | 'existing-claude-repository'

export function makeTempDir(prefix = 'wrkrs-test-'): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
}

export function removeDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

export function gitInit(directory: string, options: { commit?: boolean } = {}): void {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'Fixture')
  git('config', 'commit.gpgsign', 'false')
  if (options.commit) {
    git('add', '-A')
    git('commit', '-q', '-m', 'fixture')
  }
}

/** Copies a fixture into a fresh temporary directory and initializes a real Git worktree. */
export function createFixtureRepository(
  fixture: FixtureName,
  options: { commit?: boolean } = {},
): string {
  const directory = makeTempDir(`wrkrs-${fixture}-`)
  cpSync(path.join(FIXTURES_ROOT, fixture), directory, { recursive: true })
  gitInit(directory, options)
  return directory
}

export interface TreeEntry {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'symlink'
  readonly mode: number
  readonly hash: string | null
}

/** Deterministic listing of a tree (excluding .git) with modes and content hashes. */
export function readTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  const walk = (directory: string) => {
    const names = readdirSync(directory).sort()
    for (const name of names) {
      const absolute = path.join(directory, name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (relative === '.git' || relative.startsWith('.git/')) continue
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        entries.push({
          path: relative,
          kind: 'symlink',
          mode: stat.mode & 0o777,
          hash: createHash('sha256').update(readlinkSync(absolute)).digest('hex'),
        })
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777, hash: null })
        walk(absolute)
      } else {
        entries.push({
          path: relative,
          kind: 'file',
          mode: stat.mode & 0o777,
          hash: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        })
      }
    }
  }
  walk(root)
  return entries
}

export function hashTree(root: string): string {
  return createHash('sha256')
    .update(JSON.stringify(readTree(root)))
    .digest('hex')
}

export function fileMode(file: string): number {
  return lstatSync(file).mode & 0o777
}
