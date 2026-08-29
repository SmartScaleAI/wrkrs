/**
 * Workflows request capabilities rather than vendors. Providers declare which
 * capabilities they satisfy. The first vertical slice registers no provider;
 * the contract exists so later increments do not change the core.
 */
export const CAPABILITY_IDS = [
  'source-control',
  'pull-requests',
  'work-items',
  'design-files',
  'design-comments',
  'tool-context',
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value)
}
