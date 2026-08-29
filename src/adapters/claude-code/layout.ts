export const ADAPTER_ID = 'claude-code'
export const ADAPTER_VERSION = 1
export const AGENT_PREFIX = 'wrkrs-'
export const AGENTS_DIRECTORY = '.claude/agents'
export const SKILL_DIRECTORY = '.claude/skills/wrkrs'
export const SKILL_PATH = '.claude/skills/wrkrs/SKILL.md'
export const SKILL_NAME = 'wrkrs'

export function agentName(roleId: string): string {
  return `${AGENT_PREFIX}${roleId}`
}

export function agentPath(roleId: string): string {
  return `${AGENTS_DIRECTORY}/${agentName(roleId)}.md`
}

export function agentSourceId(roleId: string): string {
  return `${ADAPTER_ID}/agent/${roleId}`
}

export const SKILL_SOURCE_ID = `${ADAPTER_ID}/skill/wrkrs`

/** True for any path inside the wrkrs namespace of the Claude project directory. */
export function isNamespacedPath(path: string): boolean {
  if (path === SKILL_DIRECTORY || path.startsWith(`${SKILL_DIRECTORY}/`)) return true
  return path.startsWith(`${AGENTS_DIRECTORY}/${AGENT_PREFIX}`)
}
