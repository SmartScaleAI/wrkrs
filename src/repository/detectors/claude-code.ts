import { createFinding, type Finding, type FindingEvidence } from '../../core/findings.js'
import type {
  ClaudeComponentSnapshot,
  ClaudeSettingsSnapshot,
  ClaudeSnapshot,
  McpSnapshot,
} from '../../core/snapshot.js'
import { isConnectionIdentifier } from '../../core/sanitize.js'
import { joinRelativePath } from '../../platform/paths.js'
import type { ScanContext } from '../snapshot.js'

export interface ClaudeDetection {
  readonly claude: ClaudeSnapshot
  readonly findings: readonly Finding[]
}

/** Per-kind bound on preserved components; presence beyond it is reported, not lost. */
export const MAX_COMPONENTS_PER_KIND = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extracts only the `name` value from Markdown frontmatter; content is never retained. */
export function frontmatterName(text: string): string | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const match = /^name:[ \t]*(.+?)[ \t]*$/m.exec(block)
  if (!match || !match[1]) return null
  return match[1].replace(/^["']|["']$/g, '')
}

function emptySettings(path: string, valid: boolean): ClaudeSettingsSnapshot {
  return {
    path,
    valid,
    hookEvents: [],
    hookCount: 0,
    permissionRuleCounts: { allow: 0, deny: 0, ask: 0 },
  }
}

async function readSettings(
  context: ScanContext,
  path: string,
): Promise<ClaudeSettingsSnapshot | null> {
  const stat = await context.stat(path)
  if (!stat) return null
  if (stat.kind !== 'file') return emptySettings(path, false)
  const text = await context.readText(path)
  if (text === null) return emptySettings(path, false)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptySettings(path, false)
  }
  if (!isRecord(parsed)) return emptySettings(path, false)
  const hookEvents: string[] = []
  let hookCount = 0
  const hooks = parsed['hooks']
  if (isRecord(hooks)) {
    for (const event of Object.keys(hooks).sort()) {
      hookEvents.push(event)
      const matchers = hooks[event]
      if (Array.isArray(matchers)) {
        for (const matcher of matchers) {
          if (isRecord(matcher) && Array.isArray(matcher['hooks'])) {
            hookCount += matcher['hooks'].length
          } else {
            hookCount += 1
          }
        }
      }
    }
  }
  const permissions = parsed['permissions']
  const count = (key: string): number => {
    if (!isRecord(permissions)) return 0
    const rules = permissions[key]
    return Array.isArray(rules) ? rules.length : 0
  }
  return {
    path,
    valid: true,
    hookEvents,
    hookCount,
    permissionRuleCounts: { allow: count('allow'), deny: count('deny'), ask: count('ask') },
  }
}

async function readMcp(context: ScanContext, path: string): Promise<McpSnapshot | null> {
  const stat = await context.stat(path)
  if (!stat) return null
  if (stat.kind !== 'file') return { path, valid: false, servers: [] }
  const text = await context.readText(path)
  if (text === null) return { path, valid: false, servers: [] }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return { path, valid: false, servers: [] }
  }
  if (!isRecord(parsed)) return { path, valid: false, servers: [] }
  const servers = parsed['mcpServers']
  const result: { name: string; transport: string }[] = []
  if (isRecord(servers)) {
    for (const name of Object.keys(servers).sort()) {
      if (!isConnectionIdentifier(name)) continue
      const server = servers[name]
      let transport = 'unknown'
      if (isRecord(server)) {
        if (typeof server['type'] === 'string') transport = server['type']
        else if (typeof server['url'] === 'string') transport = 'http'
        else if (typeof server['command'] === 'string') transport = 'stdio'
      }
      result.push({ name, transport })
    }
  }
  return { path, valid: true, servers: result }
}

interface ComponentList {
  readonly components: ClaudeComponentSnapshot[]
  readonly truncated: boolean
}

async function listMarkdownComponents(
  context: ScanContext,
  directory: string,
  options: { nested: boolean; fileName?: string },
): Promise<ComponentList> {
  const components: ClaudeComponentSnapshot[] = []
  let truncated = false
  const entries = await context.listDirectory(directory)
  for (const entry of entries) {
    if (components.length >= MAX_COMPONENTS_PER_KIND) {
      truncated = true
      break
    }
    const relativePath = joinRelativePath(directory, entry.name)
    if (options.fileName) {
      if (entry.kind !== 'directory') continue
      const skillPath = joinRelativePath(relativePath, options.fileName)
      const stat = await context.stat(skillPath)
      if (!stat || stat.kind !== 'file') continue
      const text = await context.readText(skillPath)
      components.push({ path: skillPath, name: text === null ? null : frontmatterName(text) })
      continue
    }
    if (entry.kind === 'file' && entry.name.endsWith('.md')) {
      const text = await context.readText(relativePath)
      components.push({ path: relativePath, name: text === null ? null : frontmatterName(text) })
    } else if (entry.kind === 'directory' && options.nested) {
      const nested = await listMarkdownComponents(context, relativePath, { nested: false })
      components.push(...nested.components)
      truncated = truncated || nested.truncated
    }
  }
  return { components, truncated }
}

async function listFiles(context: ScanContext, directory: string): Promise<ComponentList> {
  const entries = await context.listDirectory(directory)
  const files = entries.filter((entry) => entry.kind === 'file')
  return {
    components: files
      .slice(0, MAX_COMPONENTS_PER_KIND)
      .map((entry) => ({ path: joinRelativePath(directory, entry.name), name: null })),
    truncated: files.length > MAX_COMPONENTS_PER_KIND,
  }
}

/**
 * Detects existing Claude Code configuration without modifying anything and
 * without following symlinks. Only presence, validity, component names, hook
 * event names, permission rule counts, and MCP server names/transports are
 * recorded.
 */
export async function detectClaudeCode(context: ScanContext): Promise<ClaudeDetection> {
  const findings: Finding[] = []

  const filePresent = async (path: string): Promise<string | null> => {
    const stat = await context.stat(path)
    return stat && (stat.kind === 'file' || stat.kind === 'symlink') ? path : null
  }

  const claudeMd = await filePresent('CLAUDE.md')
  const claudeLocalMd = await filePresent('CLAUDE.local.md')
  const settings = await readSettings(context, '.claude/settings.json')
  const settingsLocal = await readSettings(context, '.claude/settings.local.json')
  const agents = await listMarkdownComponents(context, '.claude/agents', { nested: false })
  const skills = await listMarkdownComponents(context, '.claude/skills', {
    nested: false,
    fileName: 'SKILL.md',
  })
  const commands = await listMarkdownComponents(context, '.claude/commands', { nested: true })
  const hooks = await listFiles(context, '.claude/hooks')
  const mcp = await readMcp(context, '.mcp.json')

  const present = (path: string, kind: string, evidence: FindingEvidence[] = []) => {
    findings.push(
      createFinding(
        'CLAUDE_COMPONENT_PRESENT',
        'info',
        `Existing Claude ${kind} will be preserved`,
        {
          path,
          evidence: [{ key: 'kind', value: kind }, ...evidence],
        },
      ),
    )
  }

  if (claudeMd) present(claudeMd, 'instructions')
  if (claudeLocalMd) present(claudeLocalMd, 'local-instructions')
  for (const [snapshot, kind] of [
    [settings, 'settings'],
    [settingsLocal, 'local-settings'],
  ] as const) {
    if (!snapshot) continue
    present(snapshot.path, kind, [
      { key: 'valid', value: snapshot.valid },
      { key: 'hookEvents', value: snapshot.hookEvents.join(',') },
      { key: 'hookCount', value: snapshot.hookCount },
      { key: 'allowRules', value: snapshot.permissionRuleCounts.allow },
      { key: 'denyRules', value: snapshot.permissionRuleCounts.deny },
      { key: 'askRules', value: snapshot.permissionRuleCounts.ask },
    ])
    if (!snapshot.valid) {
      findings.push(
        createFinding(
          'CLAUDE_SETTINGS_INVALID',
          'warning',
          'Claude settings file is not valid JSON or could not be inspected; it is preserved unchanged',
          { path: snapshot.path },
        ),
      )
    }
  }
  for (const agent of agents.components) {
    present(agent.path, 'agent', agent.name ? [{ key: 'name', value: agent.name }] : [])
  }
  for (const skill of skills.components) {
    present(skill.path, 'skill', skill.name ? [{ key: 'name', value: skill.name }] : [])
  }
  for (const command of commands.components) present(command.path, 'command')
  for (const hook of hooks.components) present(hook.path, 'hook')
  for (const [list, directory] of [
    [agents, '.claude/agents'],
    [skills, '.claude/skills'],
    [commands, '.claude/commands'],
    [hooks, '.claude/hooks'],
  ] as const) {
    if (list.truncated) {
      findings.push(
        createFinding(
          'CLAUDE_COMPONENTS_TRUNCATED',
          'warning',
          `More than ${MAX_COMPONENTS_PER_KIND} components exist; only the first ${MAX_COMPONENTS_PER_KIND} are listed as preserved (all are preserved)`,
          { path: directory },
        ),
      )
    }
  }
  if (mcp) {
    present(
      mcp.path,
      'mcp',
      mcp.servers.map((server) => ({ key: server.name, value: server.transport })),
    )
    if (!mcp.valid) {
      findings.push(
        createFinding(
          'CLAUDE_MCP_INVALID',
          'warning',
          '.mcp.json is not valid JSON or could not be inspected; it is preserved unchanged',
          { path: mcp.path },
        ),
      )
    }
  }

  return {
    claude: {
      claudeMd,
      claudeLocalMd,
      settings,
      settingsLocal,
      agents: agents.components,
      skills: skills.components,
      commands: commands.components,
      hooks: hooks.components,
      mcp,
    },
    findings,
  }
}
