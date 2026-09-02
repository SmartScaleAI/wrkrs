import { READ_CAPABILITY_IDS } from '../../core/capabilities.js'
import { configuredCliExecutables } from '../../core/connections.js'
import type { Diagnostic } from '../../core/diagnostics.js'
import { resolveConnections } from '../../core/provider.js'
import { isConnectionIdentifier } from '../../core/sanitize.js'
import { findPresentExecutables } from '../../platform/environment.js'
import type { CheckContext } from '../context.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function projectServerNames(context: CheckContext): Promise<readonly string[]> {
  const text = await context.reader.readText('.mcp.json')
  if (!text.ok || text.value === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.value)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) return []
  return Object.keys(parsed['mcpServers']).filter(isConnectionIdentifier)
}

export async function checkConnections(context: CheckContext): Promise<Diagnostic[]> {
  const config = context.config
  if (!config) return []
  const names = await projectServerNames(context)
  const cliExecutables = await findPresentExecutables(
    configuredCliExecutables(Object.values(config.connections)),
    context.environment,
    context.fs,
  )
  const { diagnostics } = resolveConnections(config.connections, context.providers, {
    projectServers: new Set(names),
    cliExecutables,
  })
  void READ_CAPABILITY_IDS
  return [...diagnostics]
}
