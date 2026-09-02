import type { ReadCapabilityId } from './capabilities.js'
import type { Diagnostic } from './diagnostics.js'
import { createDiagnostic } from './diagnostics.js'
import {
  isBareExecutableName,
  isConnectionIdentifier,
  isConnectionNote,
  renderUntrusted,
} from './sanitize.js'

export const BINDING_KINDS = ['mcp-server', 'cli', 'manual'] as const
export type BindingKind = (typeof BINDING_KINDS)[number]

export const BINDING_SCOPES = ['project', 'user', 'local', 'cloud'] as const
export type BindingScope = (typeof BINDING_SCOPES)[number]

export const VERIFICATION_STATES = [
  'verified-project',
  'verified-environment',
  'declared-unverified',
  'absent',
  'manual',
] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

export const PROVIDER_IDS = ['github', 'linear', 'figma', 'mcp', 'manual'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

export interface McpServerBinding {
  readonly provider: Exclude<ProviderId, 'manual'>
  readonly kind: 'mcp-server'
  readonly server: string
  readonly scope: BindingScope
  readonly note?: string | undefined
}

export interface CliBinding {
  readonly provider: 'github'
  readonly kind: 'cli'
  readonly executable: string
  readonly note?: string | undefined
}

export interface ManualBinding {
  readonly provider: 'manual'
  readonly kind: 'manual'
  readonly note?: string | undefined
}

export type ConnectionBinding = McpServerBinding | CliBinding | ManualBinding

export interface ConnectionEvidence {
  readonly projectServers: ReadonlySet<string>
  readonly cliExecutables: ReadonlySet<string>
}

export interface ProviderGuidance {
  readonly summary: string
  readonly instructions: readonly string[]
}

export interface ResolvedBinding {
  readonly capability: ReadCapabilityId
  readonly binding: ConnectionBinding
  readonly verification: VerificationState
  readonly guidance: ProviderGuidance
}

export function verifyBinding(
  binding: ConnectionBinding,
  evidence: ConnectionEvidence,
): VerificationState {
  if (binding.kind === 'manual') return 'manual'
  if (binding.kind === 'cli') {
    return evidence.cliExecutables.has(binding.executable) ? 'verified-environment' : 'absent'
  }
  if (binding.scope !== 'project') return 'declared-unverified'
  return evidence.projectServers.has(binding.server) ? 'verified-project' : 'absent'
}

export function identifierIssues(binding: ConnectionBinding, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const reject = (field: string, value: string): void => {
    const shown = renderUntrusted(value)
    diagnostics.push(
      createDiagnostic(
        'CONNECTION_IDENTIFIER_REJECTED',
        'error',
        `Connection ${field} is not a permitted identifier (shown as "${shown}")`,
        {
          path,
          remediation:
            'Use a letter-led name of letters, digits, dots, and hyphens; no path, arguments, Markdown, or YAML-quoting characters',
          details: { field, value: shown },
        },
      ),
    )
  }
  if (binding.kind === 'mcp-server' && !isConnectionIdentifier(binding.server)) {
    reject('server', binding.server)
  }
  if (binding.kind === 'cli' && !isBareExecutableName(binding.executable)) {
    reject('executable', binding.executable)
  }
  if (binding.note !== undefined && !isConnectionNote(binding.note)) {
    reject('note', binding.note)
  }
  return diagnostics
}

export function connectionDiagnostic(
  capability: ReadCapabilityId,
  binding: ConnectionBinding,
  verification: VerificationState,
  path: string,
): Diagnostic {
  const location = `${path}#connections.${capability}`
  switch (verification) {
    case 'verified-project':
    case 'verified-environment':
    case 'manual':
      return createDiagnostic(
        'CONNECTION_OK',
        'info',
        `Capability "${capability}" is bound to ${binding.provider} (${verification})`,
        { path: location, details: { capability, provider: binding.provider, verification } },
      )
    case 'declared-unverified':
      return createDiagnostic(
        'CONNECTION_UNVERIFIED',
        'warning',
        `Capability "${capability}" names a ${binding.kind === 'mcp-server' ? binding.scope : 'cli'} connection repository files cannot confirm`,
        {
          path: location,
          remediation:
            'Confirm the server exists in that environment, or bind a project-scoped server',
          details: { capability, provider: binding.provider, verification },
        },
      )
    case 'absent':
      if (binding.kind === 'cli') {
        return createDiagnostic(
          'CONNECTION_CLI_UNAVAILABLE',
          'warning',
          `Capability "${capability}" names an executable that is not on PATH here`,
          {
            path: location,
            remediation:
              'Install the executable on this machine, or bind an MCP server; cloud sessions may still have it',
            details: { capability, provider: binding.provider, verification },
          },
        )
      }
      return createDiagnostic(
        'CONNECTION_SERVER_MISSING',
        'error',
        `Capability "${capability}" names a project MCP server that is not in .mcp.json`,
        {
          path: location,
          remediation: 'Add the server to .mcp.json, change scope, or bind a different server',
          details: { capability, provider: binding.provider, verification },
        },
      )
  }
}
