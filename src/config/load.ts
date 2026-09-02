import YAML from 'yaml'
import type { z } from 'zod'

import type { ConnectionMap, WrkrsConfig } from '../core/configuration.js'
import type { ConnectionBinding } from '../core/connections.js'
import { isReadCapabilityId, isReservedMutationCapabilityId } from '../core/capabilities.js'
import { identifierIssues } from '../core/connections.js'
import type { OwnershipManifest, TransactionJournal } from '../core/ownership.js'
import { err, ok, type Result } from '../core/result.js'
import { renderUntrusted } from '../core/sanitize.js'
import { normalizeRelativePath } from '../platform/paths.js'
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_MANIFEST_SCHEMA_VERSION,
  isSupportedConfigSchemaVersion,
  isSupportedManifestSchemaVersion,
  migrateConfigV1ToV2,
  migrateConfigV2ToV3,
  migrateManifestV1ToV2,
  SUPPORTED_CONFIG_SCHEMA_VERSIONS,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
} from './migrations/index.js'
import {
  configSchemaV1,
  configSchemaV2,
  configSchemaV3,
  journalSchemaV1,
  manifestSchemaV1,
  manifestSchemaV2,
} from './schema.js'

/**
 * Document issues and errors carry only controlled text. Parser messages are
 * never forwarded because YAML and JSON parsers quote excerpts of the source,
 * which may contain secrets; only line/column metadata survives.
 */
export interface DocumentIssue {
  readonly code: string
  readonly message: string
  readonly location: string | null
}

export interface DocumentError {
  readonly code: string
  readonly message: string
  readonly schemaVersion: number | null
  readonly issues: readonly DocumentIssue[]
}

function formatLocation(path: readonly PropertyKey[]): string | null {
  if (path.length === 0) return null
  return path
    .map((segment) =>
      typeof segment === 'number' ? `[${segment}]` : renderUntrusted(String(segment)),
    )
    .join('.')
    .replace(/\.\[/g, '[')
}

/** Zod issue codes whose messages describe only the expected shape, never the received value. */
const SAFE_ZOD_MESSAGE_CODES = new Set([
  'invalid_type',
  'invalid_value',
  'too_small',
  'too_big',
  'invalid_format',
  'not_multiple_of',
])

function sanitizeZodIssue(issue: z.core.$ZodIssue, code: string): DocumentIssue {
  let message: string
  if (issue.code === 'unrecognized_keys') {
    const count = issue.keys.length
    message = `${count} unrecognized key${count === 1 ? '' : 's'} present`
  } else if (SAFE_ZOD_MESSAGE_CODES.has(issue.code)) {
    message = issue.message
  } else {
    message = `Invalid value (${issue.code})`
  }
  return { code, message, location: formatLocation(issue.path) }
}

function zodIssues(error: z.ZodError, code: string): DocumentIssue[] {
  return error.issues.map((issue) => sanitizeZodIssue(issue, code))
}

function sanitizeYamlIssue(issue: YAML.YAMLError): DocumentIssue {
  const position = issue.linePos?.[0]
  const location = position
    ? `line ${position.line}${position.col ? `, column ${position.col}` : ''}`
    : null
  return {
    code: `YAML_${issue.code}`,
    message: `YAML ${issue.name === 'YAMLWarning' ? 'warning' : 'syntax error'} (${issue.code})`,
    location,
  }
}

/** Keeps only positional metadata from a JSON.parse failure; the message text is discarded. */
function sanitizeJsonError(error: unknown): DocumentIssue {
  const raw = error instanceof Error ? error.message : ''
  const lineColumn = /line (\d+) column (\d+)/.exec(raw)
  const offset = /position (\d+)/.exec(raw)
  const location = lineColumn
    ? `line ${lineColumn[1]}, column ${lineColumn[2]}`
    : offset
      ? `offset ${offset[1]}`
      : null
  return { code: 'JSON_SYNTAX_ERROR', message: 'JSON syntax error', location }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identifySchemaVersion(
  value: Record<string, unknown>,
  prefix: string,
): Result<number, DocumentError> {
  const raw = value['schemaVersion']
  if (raw === undefined) {
    return err({
      code: `${prefix}_SCHEMA_VERSION_MISSING`,
      message: 'schemaVersion is required',
      schemaVersion: null,
      issues: [],
    })
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return err({
      code: `${prefix}_SCHEMA_VERSION_INVALID`,
      message: 'schemaVersion must be an integer',
      schemaVersion: null,
      issues: [],
    })
  }
  return ok(raw)
}

/**
 * A configuration as this wrkrs version understands it, plus the version it
 * was read from. Parsing migrates an older document in memory; it never writes.
 */
export interface ParsedConfig {
  readonly config: WrkrsConfig
  readonly sourceSchemaVersion: number
  /** True when the document on disk is older than the current format. */
  readonly migrated: boolean
}

/** Parses and validates .wrkrs/config.yaml text, migrating older versions in memory. */
export function parseConfigDocument(text: string): Result<ParsedConfig, DocumentError> {
  const document = YAML.parseDocument(text, { uniqueKeys: true, strict: true })
  if (document.errors.length > 0) {
    return err({
      code: 'CONFIG_PARSE_ERROR',
      message: 'config.yaml is not valid YAML',
      schemaVersion: null,
      issues: document.errors.map(sanitizeYamlIssue),
    })
  }
  const value: unknown = document.toJS()
  if (!isPlainObject(value)) {
    return err({
      code: 'CONFIG_NOT_AN_OBJECT',
      message: 'config.yaml must contain a mapping at the top level',
      schemaVersion: null,
      issues: [],
    })
  }
  const version = identifySchemaVersion(value, 'CONFIG')
  if (!version.ok) return version
  if (!isSupportedConfigSchemaVersion(version.value)) {
    return err({
      code: 'CONFIG_SCHEMA_VERSION_UNSUPPORTED',
      message: `config schemaVersion ${version.value} is not supported (supported: ${SUPPORTED_CONFIG_SCHEMA_VERSIONS.join(', ')})`,
      schemaVersion: version.value,
      issues: [],
    })
  }
  const invalid = (issues: readonly DocumentIssue[], message: string): DocumentError => ({
    code: 'CONFIG_INVALID',
    message,
    schemaVersion: version.value,
    issues,
  })

  let config: WrkrsConfig
  if (version.value === 1) {
    const parsed = configSchemaV1.safeParse(value)
    if (!parsed.success) {
      return err(
        invalid(
          zodIssues(parsed.error, 'CONFIG_SCHEMA_VIOLATION'),
          'config.yaml does not match the schema',
        ),
      )
    }
    const migrated = migrateConfigV2ToV3(migrateConfigV1ToV2(parsed.data))
    if (!migrated.ok) {
      return err({
        code: migrated.error.code,
        message: migrated.error.message,
        schemaVersion: version.value,
        issues: [],
      })
    }
    config = migrated.value
  } else if (version.value === 2) {
    const parsed = configSchemaV2.safeParse(value)
    if (!parsed.success) {
      return err(
        invalid(
          zodIssues(parsed.error, 'CONFIG_SCHEMA_VIOLATION'),
          'config.yaml does not match the schema',
        ),
      )
    }
    const migrated = migrateConfigV2ToV3(parsed.data)
    if (!migrated.ok) {
      return err({
        code: migrated.error.code,
        message: migrated.error.message,
        schemaVersion: version.value,
        issues: [],
      })
    }
    config = migrated.value
  } else {
    const reserved = reservedConnectionKey(value)
    if (reserved) return err(reserved)
    const parsed = configSchemaV3.safeParse(value)
    if (!parsed.success) {
      return err(
        connectionSchemaError(parsed.error, version.value) ??
          invalid(
            zodIssues(parsed.error, 'CONFIG_SCHEMA_VIOLATION'),
            'config.yaml does not match the schema',
          ),
      )
    }
    const connections = interpretConnections(parsed.data.connections)
    if (!connections.ok) return err({ ...connections.error, schemaVersion: version.value })
    config = { ...parsed.data, connections: connections.value }
  }
  const semantic = validateConfigSemantics(config)
  if (semantic.length > 0) {
    const connectionIssue = semantic.find((issue) => issue.code.startsWith('CONNECTION_'))
    return err({
      code: connectionIssue?.code ?? 'CONFIG_INVALID',
      message: connectionIssue
        ? connectionIssue.message
        : 'config.yaml contains inconsistent roster references',
      schemaVersion: version.value,
      issues: semantic,
    })
  }
  return ok({
    config,
    sourceSchemaVersion: version.value,
    migrated: version.value !== CURRENT_CONFIG_SCHEMA_VERSION,
  })
}

function reservedConnectionKey(value: Record<string, unknown>): DocumentError | null {
  const connections = value['connections']
  if (!isPlainObject(connections)) return null
  for (const key of Object.keys(connections)) {
    if (isReservedMutationCapabilityId(key)) {
      return {
        code: 'CONNECTION_CAPABILITY_RESERVED',
        message: 'Reserved mutation capabilities cannot be bound',
        schemaVersion: 3,
        issues: [
          {
            code: 'CONNECTION_CAPABILITY_RESERVED',
            message: 'Reserved mutation capabilities cannot be bound',
            location: `connections.${renderUntrusted(key)}`,
          },
        ],
      }
    }
  }
  return null
}

function connectionSchemaError(error: z.ZodError, schemaVersion: number): DocumentError | null {
  const capabilitiesList = error.issues.find(
    (issue) =>
      issue.code === 'unrecognized_keys' &&
      issue.path[0] === 'connections' &&
      issue.keys.includes('capabilities'),
  )
  if (capabilitiesList) {
    return {
      code: 'CONNECTION_BINDING_INVALID',
      message: 'A connection binding must not include a capabilities list',
      schemaVersion,
      issues: [
        {
          code: 'CONNECTION_BINDING_INVALID',
          message: 'A connection binding must not include a capabilities list',
          location: formatLocation(capabilitiesList.path),
        },
      ],
    }
  }
  const unknownProvider = error.issues.find(
    (issue) => issue.path[0] === 'connections' && issue.path.at(-1) === 'provider',
  )
  if (unknownProvider) {
    return {
      code: 'CONNECTION_PROVIDER_UNKNOWN',
      message: 'Connection names an unknown provider',
      schemaVersion,
      issues: [
        {
          code: 'CONNECTION_PROVIDER_UNKNOWN',
          message: 'Connection names an unknown provider',
          location: formatLocation(unknownProvider.path),
        },
      ],
    }
  }
  const connectionIssue = error.issues.find((issue) => issue.path[0] === 'connections')
  if (connectionIssue) {
    return {
      code: 'CONNECTION_BINDING_INVALID',
      message: 'Connection binding is invalid',
      schemaVersion,
      issues: zodIssues(error, 'CONNECTION_BINDING_INVALID'),
    }
  }
  return null
}

function interpretConnections(
  raw: Record<string, ConnectionBinding>,
): Result<ConnectionMap, DocumentError> {
  const connections: Record<string, ConnectionBinding> = {}
  const issues: DocumentIssue[] = []
  for (const [key, binding] of Object.entries(raw)) {
    if (!isReadCapabilityId(key)) {
      issues.push({
        code: 'CONNECTION_BINDING_INVALID',
        message: 'Connection key is not an Increment 3 read capability',
        location: `connections.${renderUntrusted(key)}`,
      })
      continue
    }
    connections[key] = binding
    for (const diagnostic of identifierIssues(binding, `connections.${key}`)) {
      issues.push({
        code: diagnostic.code,
        message: diagnostic.message,
        location: diagnostic.path,
      })
    }
  }
  if (issues.length > 0) {
    const code = issues.find((issue) => issue.code === 'CONNECTION_IDENTIFIER_REJECTED')?.code
    return err({
      code: code ?? 'CONNECTION_BINDING_INVALID',
      message: issues[0]?.message ?? 'Connection binding is invalid',
      schemaVersion: 3,
      issues,
    })
  }
  return ok(connections)
}

/** Cross-field rules that JSON Schema cannot express. */
export function validateConfigSemantics(config: WrkrsConfig): DocumentIssue[] {
  const issues: DocumentIssue[] = []
  const seen = new Set<string>()
  config.roster.roles.forEach((role, index) => {
    if (seen.has(role.id)) {
      issues.push({
        code: 'CONFIG_ROLE_DUPLICATE',
        message: `role "${role.id}" is declared more than once`,
        location: `roster.roles[${index}].id`,
      })
    }
    seen.add(role.id)
    const sourcePath = normalizeRelativePath(role.source)
    if (!sourcePath.ok || sourcePath.value !== role.source) {
      issues.push({
        code: 'CONFIG_ROLE_SOURCE_UNSAFE',
        message: `role "${role.id}" source must be a normalized repository-relative path`,
        location: `roster.roles[${index}].source`,
      })
    }
    const specializations = role.specializations ?? []
    const seenSpecializations = new Set<string>()
    specializations.forEach((specialization, specializationIndex) => {
      if (seenSpecializations.has(specialization)) {
        issues.push({
          code: 'CONFIG_SPECIALIZATION_DUPLICATE',
          message: `specialization "${specialization}" is listed more than once`,
          location: `roster.roles[${index}].specializations[${specializationIndex}]`,
        })
      }
      seenSpecializations.add(specialization)
    })
  })
  if (!seen.has(config.roster.primaryRole)) {
    issues.push({
      code: 'CONFIG_PRIMARY_ROLE_UNKNOWN',
      message: `primaryRole "${config.roster.primaryRole}" is not declared in roster.roles`,
      location: 'roster.primaryRole',
    })
  }
  return issues
}

function parseJsonObject(
  text: string,
  prefix: string,
): Result<Record<string, unknown>, DocumentError> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return err({
      code: `${prefix}_PARSE_ERROR`,
      message: 'document is not valid JSON',
      schemaVersion: null,
      issues: [sanitizeJsonError(error)],
    })
  }
  if (!isPlainObject(value)) {
    return err({
      code: `${prefix}_NOT_AN_OBJECT`,
      message: 'document must be a JSON object',
      schemaVersion: null,
      issues: [],
    })
  }
  return ok(value)
}

/**
 * A manifest as this wrkrs version understands it, plus the version it was
 * read from. Parsing migrates an older document in memory; it never writes.
 * `sourceSchemaVersion` is what a reader must report so the owner knows the
 * file on disk is still in the older format.
 */
export interface ParsedManifest {
  readonly manifest: OwnershipManifest
  readonly sourceSchemaVersion: number
  /** True when the document on disk is older than the current format. */
  readonly migrated: boolean
}

/** Parses and validates .wrkrs/manifest.json text, migrating older versions in memory. */
export function parseManifestDocument(text: string): Result<ParsedManifest, DocumentError> {
  const object = parseJsonObject(text, 'MANIFEST')
  if (!object.ok) return object
  const version = identifySchemaVersion(object.value, 'MANIFEST')
  if (!version.ok) return version
  if (!isSupportedManifestSchemaVersion(version.value)) {
    return err({
      code: 'MANIFEST_SCHEMA_VERSION_UNSUPPORTED',
      message: `manifest schemaVersion ${version.value} is not supported (supported: ${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(', ')})`,
      schemaVersion: version.value,
      issues: [],
    })
  }
  const invalid = (issues: readonly DocumentIssue[], message: string): DocumentError => ({
    code: 'MANIFEST_INVALID',
    message,
    schemaVersion: version.value,
    issues,
  })

  let manifest: OwnershipManifest
  if (version.value === 1) {
    const parsed = manifestSchemaV1.safeParse(object.value)
    if (!parsed.success) {
      return err(
        invalid(
          zodIssues(parsed.error, 'MANIFEST_SCHEMA_VIOLATION'),
          'manifest.json does not match the schema',
        ),
      )
    }
    manifest = migrateManifestV1ToV2(parsed.data)
  } else {
    const parsed = manifestSchemaV2.safeParse(object.value)
    if (!parsed.success) {
      return err(
        invalid(
          zodIssues(parsed.error, 'MANIFEST_SCHEMA_VIOLATION'),
          'manifest.json does not match the schema',
        ),
      )
    }
    manifest = parsed.data
  }

  const semantic = validateManifestSemantics(manifest)
  if (semantic.length > 0) {
    return err(invalid(semantic, 'manifest.json contains unsafe or duplicate paths'))
  }
  return ok({
    manifest,
    sourceSchemaVersion: version.value,
    migrated: version.value !== CURRENT_MANIFEST_SCHEMA_VERSION,
  })
}

export function validateManifestSemantics(manifest: OwnershipManifest): DocumentIssue[] {
  const issues: DocumentIssue[] = []
  const seen = new Set<string>()
  manifest.entries.forEach((entry, index) => {
    const normalized = normalizeRelativePath(entry.path)
    if (!normalized.ok || normalized.value !== entry.path) {
      issues.push({
        code: 'MANIFEST_PATH_UNSAFE',
        message: 'entry path is not a normalized repository-relative path',
        location: `entries[${index}].path`,
      })
    }
    if (seen.has(entry.path)) {
      issues.push({
        code: 'MANIFEST_PATH_DUPLICATE',
        message: 'entry path is owned more than once',
        location: `entries[${index}].path`,
      })
    }
    seen.add(entry.path)
  })
  manifest.createdDirectories.forEach((directory, index) => {
    const normalized = normalizeRelativePath(directory)
    if (!normalized.ok || normalized.value !== directory) {
      issues.push({
        code: 'MANIFEST_PATH_UNSAFE',
        message: 'created directory is not a normalized repository-relative path',
        location: `createdDirectories[${index}]`,
      })
    }
  })
  return issues
}

/** Parses a transaction journal left inside .wrkrs. */
export function parseJournalDocument(text: string): Result<TransactionJournal, DocumentError> {
  const object = parseJsonObject(text, 'JOURNAL')
  if (!object.ok) return object
  const parsed = journalSchemaV1.safeParse(object.value)
  if (!parsed.success) {
    return err({
      code: 'JOURNAL_INVALID',
      message: 'transaction journal does not match the schema',
      schemaVersion: null,
      issues: zodIssues(parsed.error, 'JOURNAL_SCHEMA_VIOLATION'),
    })
  }
  return ok(parsed.data)
}
