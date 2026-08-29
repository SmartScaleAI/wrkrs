import { createFinding, sortFindings, type Finding } from '../core/findings.js'
import { WRKRS_DIRECTORY } from '../core/ownership.js'
import type { FileSystemPort } from '../core/ports.js'
import type { FileSnapshot, RepositorySnapshot } from '../core/snapshot.js'
import { detectClaudeCode } from './detectors/claude-code.js'
import { detectProject } from './detectors/project.js'
import { detectWrkrs } from './detectors/wrkrs.js'
import type { LocatedRepository } from './locate.js'
import { createScanContext, indexTree } from './snapshot.js'

export const CLAUDE_DIRECTORY = '.claude'

/**
 * Read-only repository analysis. Produces a snapshot with bounded project
 * signals, Claude Code configuration presence, existing wrkrs state, and a
 * file index of the trees that planning must reason about.
 */
export async function analyzeRepository(
  repository: LocatedRepository,
  fs: FileSystemPort,
): Promise<RepositorySnapshot> {
  const context = createScanContext(repository.root, fs)
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
  for (const path of ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json']) {
    const snapshot = await context.snapshotPath(path)
    if (snapshot) files.set(path, snapshot)
  }
  const claudeIndex = await indexTree(context, CLAUDE_DIRECTORY, files)
  const wrkrsIndex = await indexTree(context, WRKRS_DIRECTORY, files)
  if (claudeIndex.truncated || wrkrsIndex.truncated) {
    findings.push(
      createFinding(
        'SCAN_INDEX_TRUNCATED',
        'warning',
        'The .claude or .wrkrs tree exceeded scan limits; collision checks cover indexed paths only',
      ),
    )
  }

  return {
    root: repository.root,
    git: { root: repository.root, dirty: repository.dirty },
    projectSignals: project.signals,
    claude: claude.claude,
    wrkrs: wrkrs.wrkrs,
    files,
    findings: sortFindings(findings),
  }
}
