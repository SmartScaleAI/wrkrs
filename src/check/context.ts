import type { WrkrsConfig } from '../core/configuration.js'
import type { OwnershipManifest } from '../core/ownership.js'
import type { EnvironmentPort, FileSystemPort } from '../core/ports.js'
import type { RuntimeAdapterRegistry } from '../adapters/registry.js'
import type { ProviderRegistry } from '../core/provider.js'

export interface CheckContext {
  readonly root: string
  readonly fs: FileSystemPort
  readonly environment: EnvironmentPort
  readonly adapters: RuntimeAdapterRegistry
  readonly providers: ProviderRegistry
  readonly wrkrsVersion: string
  /** Journal and lock belonging to this transaction are expected during post-apply validation. */
  readonly activeTransactionId: string | null
  config: WrkrsConfig | null
  manifest: OwnershipManifest | null
}

export async function readRepositoryText(
  context: CheckContext,
  systemPath: string,
): Promise<string> {
  return new TextDecoder().decode(await context.fs.readFile(systemPath))
}
