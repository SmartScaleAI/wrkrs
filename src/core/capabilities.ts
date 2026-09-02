/**
 * Workflows request capabilities rather than vendors. Increment 3 read
 * capabilities are bindable. Mutation identifiers stay in the vocabulary so a
 * binding can name what it does not do; they are not bindable.
 */
export const READ_CAPABILITY_IDS = [
  'source-control-context',
  'pull-request-context',
  'work-item-context',
  'design-file-context',
  'design-comment-context',
] as const

export const RESERVED_MUTATION_CAPABILITY_IDS = [
  'pull-request-comment',
  'work-item-update',
  'design-update',
] as const

export const CAPABILITY_IDS = [...READ_CAPABILITY_IDS, ...RESERVED_MUTATION_CAPABILITY_IDS] as const

export type ReadCapabilityId = (typeof READ_CAPABILITY_IDS)[number]
export type ReservedMutationCapabilityId = (typeof RESERVED_MUTATION_CAPABILITY_IDS)[number]
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export function isReadCapabilityId(value: string): value is ReadCapabilityId {
  return (READ_CAPABILITY_IDS as readonly string[]).includes(value)
}

export function isReservedMutationCapabilityId(
  value: string,
): value is ReservedMutationCapabilityId {
  return (RESERVED_MUTATION_CAPABILITY_IDS as readonly string[]).includes(value)
}

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value)
}

export function questionIdFor(capability: ReadCapabilityId): string {
  return `capability.${capability}`
}
