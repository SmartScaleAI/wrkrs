import YAML from 'yaml'

import { READ_CAPABILITY_IDS } from '../core/capabilities.js'
import type { WrkrsConfig } from '../core/configuration.js'
import type { ConnectionBinding } from '../core/connections.js'
import type { OwnershipManifest, TransactionJournal } from '../core/ownership.js'

const CONFIG_HEADER = [
  '# wrkrs repository configuration (schema version 3).',
  '# Validate with `wrkrs check`. JSON Schema: .wrkrs/schema.json',
  '# Portable role definitions live under .wrkrs/roles and may be edited.',
  '# execution.profile is the floor the Product Manager may raise and must never lower.',
  '# connections: one primary route per Increment 3 read capability.',
  '#   mcp-server: provider github|linear|figma|mcp, server, scope project|user|local|cloud',
  '#   cli: provider github, executable (PATH name only)',
  '#   manual: provider manual',
  '# Reserved mutation capabilities cannot be bound. wrkrs update never prompts; edit and re-run it.',
  '',
].join('\n')

function serializeBinding(binding: ConnectionBinding): Record<string, unknown> {
  if (binding.kind === 'mcp-server') {
    const entry: Record<string, unknown> = {
      provider: binding.provider,
      kind: binding.kind,
      server: binding.server,
      scope: binding.scope,
    }
    if (binding.note !== undefined) entry['note'] = binding.note
    return entry
  }
  if (binding.kind === 'cli') {
    const entry: Record<string, unknown> = {
      provider: binding.provider,
      kind: binding.kind,
      executable: binding.executable,
    }
    if (binding.note !== undefined) entry['note'] = binding.note
    return entry
  }
  const entry: Record<string, unknown> = { provider: binding.provider, kind: binding.kind }
  if (binding.note !== undefined) entry['note'] = binding.note
  return entry
}

/** Serializes configuration with a stable key order, comments, and a final newline. */
export function serializeConfig(config: WrkrsConfig): string {
  const connections: Record<string, unknown> = {}
  for (const capability of READ_CAPABILITY_IDS) {
    const binding = config.connections[capability]
    if (binding) connections[capability] = serializeBinding(binding)
  }
  const ordered = {
    schemaVersion: config.schemaVersion,
    preset: { id: config.preset.id, version: config.preset.version },
    runtime: { primary: config.runtime.primary },
    roster: {
      primaryRole: config.roster.primaryRole,
      roles: config.roster.roles.map((role) => {
        const entry: Record<string, unknown> = { id: role.id, source: role.source }
        if (role.specializations !== undefined) {
          entry['specializations'] = [...role.specializations]
        }
        return entry
      }),
    },
    governance: {
      requirePlanApproval: config.governance.requirePlanApproval,
      requireDesignApproval: config.governance.requireDesignApproval,
      requireOwnerTestForUserFacingOrNativeWork:
        config.governance.requireOwnerTestForUserFacingOrNativeWork,
      requireExplicitReleaseApproval: config.governance.requireExplicitReleaseApproval,
    },
    execution: { profile: config.execution.profile },
    connections,
    extensions: { ...config.extensions },
  }
  const body = YAML.stringify(ordered, { indent: 2, lineWidth: 0 })
  return CONFIG_HEADER + body
}

/** Strict, stable-key JSON with a trailing newline. */
export function serializeManifest(manifest: OwnershipManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    state: manifest.state,
    installationId: manifest.installationId,
    wrkrsVersion: manifest.wrkrsVersion,
    installedAt: manifest.installedAt,
    updatedAt: manifest.updatedAt,
    preset: { id: manifest.preset.id, version: manifest.preset.version },
    runtimeAdapters: manifest.runtimeAdapters.map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
    })),
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      management: entry.management,
      sourceId: entry.sourceId,
      sourceVersion: entry.sourceVersion,
      lastAppliedHash: entry.lastAppliedHash,
    })),
    createdDirectories: [...manifest.createdDirectories],
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}

export function serializeJournal(journal: TransactionJournal): string {
  const ordered = {
    schemaVersion: journal.schemaVersion,
    transactionId: journal.transactionId,
    command: journal.command,
    planDigest: journal.planDigest,
    startedAt: journal.startedAt,
    updatedAt: journal.updatedAt,
    status: journal.status,
    durability: journal.durability,
    operations: journal.operations.map((operation) => ({
      path: operation.path,
      kind: operation.kind,
      status: operation.status,
      stagingPath: operation.stagingPath,
      backupPath: operation.backupPath,
      backupHash: operation.backupHash,
      expectedHash: operation.expectedHash,
      appliedHash: operation.appliedHash,
      note: operation.note,
    })),
    failure: journal.failure,
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}
