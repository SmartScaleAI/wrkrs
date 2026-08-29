import type { ProviderAdapter, ProviderRegistry } from '../core/provider.js'

/**
 * Explicit provider registry. The first vertical slice registers no provider;
 * GitHub, Linear, Figma, generic MCP, and manual providers arrive in a later
 * increment through this same contract.
 */
export function createProviderRegistry(providers: readonly ProviderAdapter[]): ProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider] as const))
  return {
    ids: [...byId.keys()],
    get: (id) => byId.get(id),
  }
}
