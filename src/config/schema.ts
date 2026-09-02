import { z } from 'zod'

import { EXECUTION_PROFILES, type WrkrsConfig } from '../core/configuration.js'
import type { OwnershipManifest, TransactionJournal } from '../core/ownership.js'
import { INSTALLATION_STATES, MANAGEMENT_MODES } from '../core/ownership.js'

export const IDENTIFIER_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
const HASH_PATTERN = '^sha256:[0-9a-f]{64}$'
const RELATIVE_PATH_PATTERN = '^(?!/)(?!\\.\\.(/|$))(?!.*/\\.\\.(/|$))[^\\\\]+$'

const identifier = z
  .string()
  .regex(new RegExp(IDENTIFIER_PATTERN), 'must be a lowercase kebab-case identifier')

const relativePath = z
  .string()
  .min(1)
  .regex(new RegExp(RELATIVE_PATH_PATTERN), 'must be a POSIX repository-relative path')

const contentHash = z.string().regex(new RegExp(HASH_PATTERN), 'must be a sha256 content hash')

const timestamp = z.string().datetime({ offset: true })

export const configRoleSchema = z.strictObject({
  id: identifier.describe('Role identifier referenced by the runtime adapter.'),
  source: relativePath.describe('Repository-relative path of the portable role definition.'),
  specializations: z
    .array(identifier)
    .optional()
    .describe('Task-specific specializations attached to this role.'),
})

const sharedConfigBody = {
  preset: z.strictObject({
    id: z.literal('product-engineering').describe('Framework preset identifier.'),
    version: z.int().positive().describe('Preset version the roster was generated from.'),
  }),
  runtime: z.strictObject({
    primary: z.literal('claude-code').describe('Primary runtime adapter identifier.'),
  }),
  roster: z.strictObject({
    primaryRole: identifier.describe('Role that coordinates the others.'),
    roles: z.array(configRoleSchema).min(1),
  }),
  governance: z.strictObject({
    requirePlanApproval: z.boolean(),
    requireDesignApproval: z.boolean(),
    requireOwnerTestForUserFacingOrNativeWork: z.boolean(),
    requireExplicitReleaseApproval: z.boolean(),
  }),
  extensions: z
    .record(z.string(), z.unknown())
    .describe('Explicit extension data preserved by wrkrs but not interpreted by it.'),
}

const legacyProviders = z
  .record(z.string(), z.unknown())
  .describe('Legacy provider map. Empty records migrate to connections; non-empty records block.')

const connectionNote = z.string().max(120).optional()

const mcpServerBindingSchema = z.strictObject({
  provider: z.enum(['github', 'linear', 'figma', 'mcp']),
  kind: z.literal('mcp-server'),
  server: z.string().min(1).max(64),
  scope: z.enum(['project', 'user', 'local', 'cloud']),
  note: connectionNote,
})

const cliBindingSchema = z.strictObject({
  provider: z.literal('github'),
  kind: z.literal('cli'),
  executable: z.string().min(1).max(64),
  note: connectionNote,
})

const manualBindingSchema = z.strictObject({
  provider: z.literal('manual'),
  kind: z.literal('manual'),
  note: connectionNote,
})

export const connectionBindingSchema = z.discriminatedUnion('kind', [
  mcpServerBindingSchema,
  cliBindingSchema,
  manualBindingSchema,
])

/** Version 1: the first durable format. Read for migration; never written again. */
export const configSchemaV1 = z
  .strictObject({
    schemaVersion: z.literal(1).describe('Configuration schema version.'),
    ...sharedConfigBody,
    providers: legacyProviders,
  })
  .describe('wrkrs repository configuration (schema version 1)')

/** Version 2 adds the execution profile floor the Product Manager may raise and must never lower. */
export const configSchemaV2 = z
  .strictObject({
    schemaVersion: z.literal(2).describe('Configuration schema version.'),
    ...sharedConfigBody,
    execution: z.strictObject({
      profile: z
        .enum(EXECUTION_PROFILES)
        .describe(
          'Execution profile floor: adaptive lets the Product Manager triage; fast, standard, and full set a floor that may be raised and never lowered.',
        ),
    }),
    providers: legacyProviders,
  })
  .describe('wrkrs repository configuration (schema version 2)')

/** Version 3 replaces providers with capability-keyed connections. */
export const configSchemaV3 = z
  .strictObject({
    schemaVersion: z.literal(3).describe('Configuration schema version.'),
    ...sharedConfigBody,
    execution: z.strictObject({
      profile: z
        .enum(EXECUTION_PROFILES)
        .describe(
          'Execution profile floor: adaptive lets the Product Manager triage; fast, standard, and full set a floor that may be raised and never lowered.',
        ),
    }),
    connections: z
      .record(z.string(), connectionBindingSchema)
      .describe('Primary capability bindings. One route per Increment 3 read capability.'),
  })
  .describe('wrkrs repository configuration')

export const manifestEntrySchema = z.strictObject({
  path: relativePath,
  kind: z.literal('file'),
  management: z.enum(MANAGEMENT_MODES),
  sourceId: z.string().min(1),
  sourceVersion: z.int().positive(),
  lastAppliedHash: contentHash,
})

const manifestBody = {
  installationId: z.string().uuid(),
  wrkrsVersion: z.string().min(1),
  installedAt: timestamp,
  updatedAt: timestamp,
  preset: z.strictObject({ id: identifier, version: z.int().positive() }),
  runtimeAdapters: z.array(z.strictObject({ id: identifier, version: z.int().positive() })).min(1),
  entries: z.array(manifestEntrySchema),
  createdDirectories: z.array(relativePath),
}

/** Version 1: the first durable format. Read for migration; never written again. */
export const manifestSchemaV1 = z.strictObject({
  schemaVersion: z.literal(1),
  ...manifestBody,
})

/** Version 2 adds the explicit installation state that partial uninstall records. */
export const manifestSchemaV2 = z.strictObject({
  schemaVersion: z.literal(2),
  state: z.enum(INSTALLATION_STATES),
  ...manifestBody,
})

export const journalOperationSchema = z.strictObject({
  path: relativePath,
  kind: z.enum([
    'create-file',
    'create-directory',
    'replace-file',
    'remove-file',
    'remove-directory',
  ]),
  status: z.enum([
    'planned',
    'staging',
    'staged',
    'backed-up',
    'published',
    'applied',
    'removed',
    'reverted',
    'retained',
  ]),
  stagingPath: relativePath.nullable(),
  // Defaulted so a journal written by a version that only created files still
  // parses: those operations never had a backup.
  backupPath: relativePath.nullable().default(null),
  backupHash: contentHash.nullable().default(null),
  expectedHash: contentHash.nullable(),
  appliedHash: contentHash.nullable(),
  note: z.string().nullable(),
})

export const journalSchemaV1 = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  command: z.enum(['init', 'update', 'uninstall']),
  planDigest: contentHash,
  startedAt: timestamp,
  updatedAt: timestamp,
  status: z.enum([
    'pending',
    'applying',
    'validating',
    'committed',
    'rolling-back',
    'rolled-back',
    'rollback-incomplete',
  ]),
  durability: z.enum(['strict', 'best-effort']),
  operations: z.array(journalOperationSchema),
  failure: z.string().nullable(),
})

// Compile-time guarantees that the runtime schemas produce the core contracts.
type Extends<A, B> = A extends B ? true : false
type Assert<T extends true> = T
export type ConfigSchemaMatchesCore = Assert<Extends<z.output<typeof configSchemaV3>, WrkrsConfig>>
export type ManifestSchemaMatchesCore = Assert<
  Extends<z.output<typeof manifestSchemaV2>, OwnershipManifest>
>
export type JournalSchemaMatchesCore = Assert<
  Extends<z.output<typeof journalSchemaV1>, TransactionJournal>
>
