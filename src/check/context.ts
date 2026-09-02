import type { RuntimeAdapterRegistry } from '../adapters/registry.js'
import type { WrkrsConfig } from '../core/configuration.js'
import { createDiagnostic, type Diagnostic, type DiagnosticSeverity } from '../core/diagnostics.js'
import type { OwnershipManifest } from '../core/ownership.js'
import type { EnvironmentPort, FileSystemPort } from '../core/ports.js'
import type { ProviderRegistry } from '../core/provider.js'
import type { ContainmentFailure, RepositoryReader } from '../platform/contained-path.js'

export interface CheckContext {
  readonly root: string
  readonly fs: FileSystemPort
  /** Contained read boundary shared by every check; nothing is read through a symlinked ancestor. */
  readonly reader: RepositoryReader
  readonly environment: EnvironmentPort
  readonly adapters: RuntimeAdapterRegistry
  readonly providers: ProviderRegistry
  readonly wrkrsVersion: string
  /** Journal and lock belonging to this transaction are expected during post-apply validation. */
  readonly activeTransactionId: string | null
  config: WrkrsConfig | null
  /** Schema version of the configuration as it exists on disk, before migration. */
  configSchemaVersion: number | null
  manifest: OwnershipManifest | null
  /** Schema version of the manifest as it exists on disk, before migration. */
  manifestSchemaVersion: number | null
}

/** Turns a containment failure into a stable diagnostic that never echoes file content. */
export function containmentDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  failure: ContainmentFailure,
  extra: Record<string, string | number | boolean> = {},
): Diagnostic {
  return createDiagnostic(code, severity, `${failure.message}; wrkrs did not read it`, {
    path: failure.ancestor ?? failure.path,
    remediation:
      'Replace the symlinked or unsafe path with a real path inside the repository, or move it aside',
    details: { reason: failure.code, requested: failure.path, ...extra },
  })
}
