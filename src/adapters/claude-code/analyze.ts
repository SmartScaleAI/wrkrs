import { createFinding, type Finding } from '../../core/findings.js'
import type { AdapterAnalysis, PreservedComponent } from '../../core/runtime-adapter.js'
import type { RepositorySnapshot } from '../../core/snapshot.js'
import { AGENTS_DIRECTORY, isNamespacedPath, SKILL_PATH } from './layout.js'

/**
 * Lists every existing Claude Code component the first slice preserves and
 * flags namespaced paths that already exist so the planner can classify them.
 */
export function analyzeClaudeCodeSnapshot(snapshot: RepositorySnapshot): AdapterAnalysis {
  const preserved: PreservedComponent[] = []
  const findings: Finding[] = []
  const claude = snapshot.claude

  const add = (path: string | null | undefined, kind: string, description: string) => {
    if (!path) return
    if (isNamespacedPath(path)) return
    preserved.push({ path, kind, description })
  }

  add(claude.claudeMd, 'instructions', 'Project instructions are never edited by wrkrs')
  add(claude.claudeLocalMd, 'local-instructions', 'Local instructions are never edited by wrkrs')
  add(claude.settings?.path, 'settings', 'Shared settings, permissions, and hooks are preserved')
  add(claude.settingsLocal?.path, 'local-settings', 'Local settings are preserved')
  for (const agent of claude.agents) add(agent.path, 'agent', 'Existing agent is preserved')
  for (const skill of claude.skills) add(skill.path, 'skill', 'Existing skill is preserved')
  for (const command of claude.commands)
    add(command.path, 'command', 'Existing command is preserved')
  for (const hook of claude.hooks) add(hook.path, 'hook', 'Existing hook script is preserved')
  add(claude.mcp?.path, 'mcp', 'MCP server configuration is preserved')

  for (const [path, file] of snapshot.files) {
    if (!isNamespacedPath(path)) continue
    if (file.kind === 'directory') continue
    findings.push(
      createFinding(
        'CLAUDE_NAMESPACED_PATH_PRESENT',
        'warning',
        'A wrkrs-namespaced Claude path already exists and will be compared with the proposed content',
        { path, evidence: [{ key: 'kind', value: file.kind }] },
      ),
    )
  }

  preserved.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { preserved, findings }
}

export { AGENTS_DIRECTORY, SKILL_PATH }
