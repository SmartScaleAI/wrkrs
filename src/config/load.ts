import YAML from 'yaml'
import type { z } from 'zod'

import type { WrkrsConfig } from '../core/configuration.js'
import type { OwnershipManifest, TransactionJournal } from '../core/ownership.js'
import { err, ok, type Result } from '../core/result.js'
import { normalizeRelativePath } from '../platform/paths.js'
import {
  isSupportedConfigSchemaVersion,
  isSupportedManifestSchemaVersion,
  SUPPORTED_CONFIG_SCHEMA_VERSIONS,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
} from './migrations/index.js'
import { configSchemaV1, journalSchemaV1, manifestSchemaV1 } from './schema.js'

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
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment)))
    .join('.')
    .replace(/\.\[/g, '[')
}

function zodIssues(error: z.ZodError, code: string): DocumentIssue[] {
  return error.issues.map((issue) => ({
    code,
    message: issue.message,
    location: formatLocation(issue.path),
  }))
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

/** Parses and validates .wrkrs/config.yaml text. */
export function parseConfigDocument(text: string): Result<WrkrsConfig, DocumentError> {
  const document = YAML.parseDocument(text, { uniqueKeys: true, strict: true })
  if (document.errors.length > 0) {
    return err({
      code: 'CONFIG_PARSE_ERROR',
      message: 'config.yaml is not valid YAML',
      schemaVersion: null,
      issues: document.errors.map((issue) => ({
        code: 'YAML_' + issue.code,
        message: issue.message,
        location: issue.linePos ? `line ${issue.linePos[0]?.line ?? '?'}` : null,
      })),
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
  const parsed = configSchemaV1.safeParse(value)
  if (!parsed.success) {
    return err({
      code: 'CONFIG_INVALID',
      message: 'config.yaml does not match the schema',
      schemaVersion: version.value,
      issues: zodIssues(parsed.error, 'CONFIG_SCHEMA_VIOLATION'),
    })
  }
  const semantic = validateConfigSemantics(parsed.data)
  if (semantic.length > 0) {
    return err({
      code: 'CONFIG_INVALID',
      message: 'config.yaml contains inconsistent roster references',
      schemaVersion: version.value,
      issues: semantic,
    })
  }
  return ok(parsed.data)
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
      message: error instanceof Error ? error.message : 'invalid JSON',
      schemaVersion: null,
      issues: [],
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

/** Parses and validates .wrkrs/manifest.json text. */
export function parseManifestDocument(text: string): Result<OwnershipManifest, DocumentError> {
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
  const parsed = manifestSchemaV1.safeParse(object.value)
  if (!parsed.success) {
    return err({
      code: 'MANIFEST_INVALID',
      message: 'manifest.json does not match the schema',
      schemaVersion: version.value,
      issues: zodIssues(parsed.error, 'MANIFEST_SCHEMA_VIOLATION'),
    })
  }
  const semantic = validateManifestSemantics(parsed.data)
  if (semantic.length > 0) {
    return err({
      code: 'MANIFEST_INVALID',
      message: 'manifest.json contains unsafe or duplicate paths',
      schemaVersion: version.value,
      issues: semantic,
    })
  }
  return ok(parsed.data)
}

export function validateManifestSemantics(manifest: OwnershipManifest): DocumentIssue[] {
  const issues: DocumentIssue[] = []
  const seen = new Set<string>()
  manifest.entries.forEach((entry, index) => {
    const normalized = normalizeRelativePath(entry.path)
    if (!normalized.ok || normalized.value !== entry.path) {
      issues.push({
        code: 'MANIFEST_PATH_UNSAFE',
        message: `entry path "${entry.path}" is not a normalized repository-relative path`,
        location: `entries[${index}].path`,
      })
    }
    if (seen.has(entry.path)) {
      issues.push({
        code: 'MANIFEST_PATH_DUPLICATE',
        message: `entry path "${entry.path}" is owned more than once`,
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
        message: `created directory "${directory}" is not a normalized repository-relative path`,
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
