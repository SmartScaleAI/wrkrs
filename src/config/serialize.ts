import YAML from 'yaml'

import type { WrkrsConfig } from '../core/configuration.js'
import type { OwnershipManifest, TransactionJournal } from '../core/ownership.js'

const CONFIG_HEADER = [
  '# wrkrs repository configuration (schema version 1).',
  '# Validate with `wrkrs check`. JSON Schema: .wrkrs/schema.json',
  '# Portable role definitions live under .wrkrs/roles and may be edited.',
  '',
].join('\n')

/** Serializes configuration with a stable key order, comments, and a final newline. */
export function serializeConfig(config: WrkrsConfig): string {
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
    providers: { ...config.providers },
    extensions: { ...config.extensions },
  }
  const body = YAML.stringify(ordered, { indent: 2, lineWidth: 0 })
  return CONFIG_HEADER + body
}

/** Strict, stable-key JSON with a trailing newline. */
export function serializeManifest(manifest: OwnershipManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
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
      expectedHash: operation.expectedHash,
      appliedHash: operation.appliedHash,
      note: operation.note,
    })),
    failure: journal.failure,
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}
