import { builtinProviders } from './builtin.js'
import { createProviderRegistry } from './registry.js'

export function createBuiltinProviderRegistry() {
  return createProviderRegistry(builtinProviders())
}

export { builtinProviders, createProviderRegistry }
