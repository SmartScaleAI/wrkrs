/**
 * Portable configuration types. The Zod schema in src/config/schema.ts is the
 * runtime source of truth and is type-checked against these interfaces so the
 * core never depends on the validation library.
 */
import type { ReadCapabilityId } from './capabilities.js'
import type { ConnectionBinding } from './connections.js'

export const CONFIG_SCHEMA_VERSION = 3
export const PRESET_ID = 'product-engineering'
export const PRESET_VERSION = 1
export const RUNTIME_ID = 'claude-code'

export const EXECUTION_PROFILES = ['adaptive', 'fast', 'standard', 'full'] as const
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number]

export interface ConfiguredRole {
  readonly id: string
  readonly source: string
  readonly specializations?: readonly string[] | undefined
}

export interface Governance {
  readonly requirePlanApproval: boolean
  readonly requireDesignApproval: boolean
  readonly requireOwnerTestForUserFacingOrNativeWork: boolean
  readonly requireExplicitReleaseApproval: boolean
}

export interface Execution {
  readonly profile: ExecutionProfile
}

export type ConnectionMap = Readonly<Partial<Record<ReadCapabilityId, ConnectionBinding>>>

export interface WrkrsConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION
  readonly preset: { readonly id: typeof PRESET_ID; readonly version: number }
  readonly runtime: { readonly primary: typeof RUNTIME_ID }
  readonly roster: {
    readonly primaryRole: string
    readonly roles: readonly ConfiguredRole[]
  }
  readonly governance: Governance
  readonly execution: Execution
  readonly connections: ConnectionMap
  readonly extensions: Readonly<Record<string, unknown>>
}

/** Schema version 1 as it was written before the execution section existed. */
export interface WrkrsConfigV1 {
  readonly schemaVersion: 1
  readonly preset: WrkrsConfig['preset']
  readonly runtime: WrkrsConfig['runtime']
  readonly roster: WrkrsConfig['roster']
  readonly governance: Governance
  readonly providers: Readonly<Record<string, unknown>>
  readonly extensions: Readonly<Record<string, unknown>>
}

/** Schema version 2 added execution.profile and still carried providers. */
export interface WrkrsConfigV2 {
  readonly schemaVersion: 2
  readonly preset: WrkrsConfig['preset']
  readonly runtime: WrkrsConfig['runtime']
  readonly roster: WrkrsConfig['roster']
  readonly governance: Governance
  readonly execution: Execution
  readonly providers: Readonly<Record<string, unknown>>
  readonly extensions: Readonly<Record<string, unknown>>
}
