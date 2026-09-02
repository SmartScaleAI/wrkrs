import type { ProviderDefinition, ProviderRegistry } from '../core/provider.js'
import type { ProviderId } from '../core/connections.js'

/**
 * Explicit provider registry. The composition root registers the five Increment 3
 * capability descriptors; there is no dynamic loading.
 */
export function createProviderRegistry(providers: readonly ProviderDefinition[]): ProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider] as const))
  return {
    ids: [...byId.keys()] as ProviderId[],
    get: (id) => byId.get(id as ProviderId),
  }
}
