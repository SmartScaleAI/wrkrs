import type { CapabilityId } from './capabilities.js'
import type { WrkrsConfig } from './configuration.js'
import type { Diagnostic } from './diagnostics.js'
import type { Finding } from './findings.js'
import type { DesiredComponent } from './plan.js'
import type { FileSystemPort } from './ports.js'
import type { RepositorySnapshot } from './snapshot.js'

export interface ProviderProbeContext {
  readonly snapshot: RepositorySnapshot
}

export interface ProviderProbe {
  readonly available: boolean
  readonly findings: readonly Finding[]
}

export interface ProviderPlanInput {
  readonly config: WrkrsConfig
  readonly providerConfig: unknown
}

export interface ProviderCheckContext {
  readonly root: string
  readonly fs: FileSystemPort
  readonly config: WrkrsConfig
  readonly providerConfig: unknown
}

export interface ProviderAdapter {
  readonly id: string
  readonly capabilities: readonly CapabilityId[]
  probe(context: ProviderProbeContext): ProviderProbe
  planConfiguration(input: ProviderPlanInput): readonly DesiredComponent[]
  diagnose(context: ProviderCheckContext): Promise<readonly Diagnostic[]>
}

export interface ProviderRegistry {
  readonly ids: readonly string[]
  get(id: string): ProviderAdapter | undefined
}
