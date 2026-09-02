import { READ_CAPABILITY_IDS, type ReadCapabilityId } from './capabilities.js'
import type { ConnectionMap } from './configuration.js'
import {
  connectionDiagnostic,
  identifierIssues,
  verifyBinding,
  type BindingKind,
  type ConnectionBinding,
  type ConnectionEvidence,
  type ProviderGuidance,
  type ProviderId,
  type ResolvedBinding,
  type VerificationState,
} from './connections.js'
import type { Diagnostic } from './diagnostics.js'
import { createDiagnostic } from './diagnostics.js'
import type { Finding } from './findings.js'
import type { RepositorySnapshot } from './snapshot.js'

export type { ProviderGuidance, ProviderId } from './connections.js'

export interface ProviderProbeContext {
  readonly snapshot: RepositorySnapshot
  readonly projectServers: readonly string[]
  readonly cliExecutables: readonly string[]
}

export interface ProviderProbe {
  readonly available: boolean
  readonly findings: readonly Finding[]
}

export interface ProviderBindingContext {
  readonly capability: ReadCapabilityId
  readonly binding: ConnectionBinding
  readonly verification: VerificationState
}

export interface ProviderDefinition {
  readonly id: ProviderId
  readonly title: string
  readonly capabilities: readonly ReadCapabilityId[]
  readonly kinds: readonly BindingKind[]
  probe(context: ProviderProbeContext): ProviderProbe
  validate(context: ProviderBindingContext): readonly Diagnostic[]
  describe(context: ProviderBindingContext): ProviderGuidance
}

export interface ProviderRegistry {
  readonly ids: readonly ProviderId[]
  get(id: string): ProviderDefinition | undefined
}

export function resolveBinding(
  capability: ReadCapabilityId,
  binding: ConnectionBinding,
  provider: ProviderDefinition | undefined,
  evidence: ConnectionEvidence,
): { diagnostics: Diagnostic[]; resolved: ResolvedBinding | null } {
  const path = '.wrkrs/config.yaml'
  const location = `${path}#connections.${capability}`
  if (!provider) {
    return {
      diagnostics: [
        createDiagnostic(
          'CONNECTION_PROVIDER_UNKNOWN',
          'error',
          `Capability "${capability}" names an unknown provider`,
          {
            path: location,
            remediation: 'Use github, linear, figma, mcp, or manual',
            details: { capability },
          },
        ),
      ],
      resolved: null,
    }
  }
  const diagnostics = [...identifierIssues(binding, location)]
  if (!provider.capabilities.includes(capability)) {
    diagnostics.push(
      createDiagnostic(
        'CONNECTION_CAPABILITY_UNSUPPORTED',
        'error',
        `Provider "${provider.id}" cannot supply this capability`,
        {
          path: location,
          remediation: 'Bind a provider that declares the capability',
          details: { capability, provider: provider.id },
        },
      ),
    )
  }
  if (!provider.kinds.includes(binding.kind)) {
    diagnostics.push(
      createDiagnostic(
        'CONNECTION_BINDING_INVALID',
        'error',
        `Provider "${provider.id}" does not support this binding kind`,
        {
          path: location,
          remediation: `Allowed kinds: ${provider.kinds.join(', ')}`,
          details: { capability, provider: provider.id },
        },
      ),
    )
  }
  if (diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics, resolved: null }
  }
  const verification = verifyBinding(binding, evidence)
  const context: ProviderBindingContext = { capability, binding, verification }
  return {
    diagnostics: [
      ...diagnostics,
      ...provider.validate(context),
      connectionDiagnostic(capability, binding, verification, path),
    ],
    resolved: {
      capability,
      binding,
      verification,
      guidance: provider.describe(context),
    },
  }
}

export function resolveConnections(
  connections: ConnectionMap,
  providers: ProviderRegistry,
  evidence: ConnectionEvidence,
): { readonly resolved: readonly ResolvedBinding[]; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const resolved: ResolvedBinding[] = []
  for (const capability of READ_CAPABILITY_IDS) {
    const binding = connections[capability]
    if (!binding) {
      diagnostics.push(
        createDiagnostic(
          'CONNECTION_CAPABILITY_UNBOUND',
          'info',
          `Capability "${capability}" has no binding`,
          {
            path: '.wrkrs/config.yaml',
            remediation: 'Edit connections in .wrkrs/config.yaml, or re-run init with answers',
            details: { capability },
          },
        ),
      )
      continue
    }
    const outcome = resolveBinding(capability, binding, providers.get(binding.provider), evidence)
    diagnostics.push(...outcome.diagnostics)
    if (outcome.resolved) resolved.push(outcome.resolved)
  }
  return { resolved, diagnostics }
}
