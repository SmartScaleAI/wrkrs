import type { RuntimeAdapter } from '../core/runtime-adapter.js'

export interface RuntimeAdapterRegistry {
  readonly ids: readonly string[]
  get(id: string): RuntimeAdapter | undefined
}

/** Explicit registry assembled by the composition root; no dynamic loading. */
export function createRuntimeAdapterRegistry(
  adapters: readonly RuntimeAdapter[],
): RuntimeAdapterRegistry {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter] as const))
  return {
    ids: [...byId.keys()],
    get: (id) => byId.get(id),
  }
}
