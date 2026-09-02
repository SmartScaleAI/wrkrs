import type { ProjectSignal } from './snapshot.js'

export const ROLE_IDS = [
  'product-manager',
  'product-designer',
  'software-engineer',
  'qa-engineer',
] as const

export type RoleId = (typeof ROLE_IDS)[number]

export function isRoleId(value: string): value is RoleId {
  return (ROLE_IDS as readonly string[]).includes(value)
}

export interface RecommendationEvidence {
  readonly signal: string
  readonly path: string
  readonly detail: string
}

export interface Specialization {
  readonly id: string
  readonly title: string
  readonly evidence: readonly RecommendationEvidence[]
}

export interface RecommendedRole {
  readonly id: RoleId
  readonly title: string
  readonly primary: boolean
  readonly source: string
  readonly reason: string
  readonly specializations: readonly Specialization[]
}

export interface RosterRecommendation {
  readonly presetId: 'product-engineering'
  readonly presetVersion: number
  /** The coordinating role; the preset chooses it and configuration may change it. */
  readonly primaryRoleId: RoleId
  readonly roles: readonly RecommendedRole[]
  readonly evidence: readonly RecommendationEvidence[]
}

export interface PresetRole {
  readonly id: RoleId
  readonly title: string
  readonly reason: string
  /** True for the single role that receives detected specializations. */
  readonly specializable: boolean
}

export interface SpecializationRule {
  readonly id: string
  readonly title: string
  /** Any of these signal ids activates the specialization. */
  readonly signals: readonly string[]
}

export interface RosterPreset {
  readonly id: 'product-engineering'
  readonly version: number
  readonly primaryRoleId: RoleId
  readonly roles: readonly PresetRole[]
  readonly specializationRules: readonly SpecializationRule[]
  roleSourcePath(roleId: RoleId): string
}

function compareEvidence(a: RecommendationEvidence, b: RecommendationEvidence): number {
  if (a.signal !== b.signal) return a.signal < b.signal ? -1 : 1
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
}

/**
 * Deterministic roster recommendation. The four preset roles are always
 * returned in preset order; detected signals only add specializations with
 * evidence to the specializable role.
 */
export function recommendRoster(
  preset: RosterPreset,
  signals: readonly ProjectSignal[],
): RosterRecommendation {
  const sortedSignals = [...signals].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
  })

  const specializations: Specialization[] = []
  for (const rule of preset.specializationRules) {
    const evidence = sortedSignals
      .filter((signal) => rule.signals.includes(signal.id))
      .map((signal) => ({ signal: signal.id, path: signal.path, detail: signal.detail }))
      .sort(compareEvidence)
    if (evidence.length > 0) {
      specializations.push({ id: rule.id, title: rule.title, evidence })
    }
  }

  const roles: RecommendedRole[] = preset.roles.map((role) => ({
    id: role.id,
    title: role.title,
    primary: role.id === preset.primaryRoleId,
    source: preset.roleSourcePath(role.id),
    reason: role.reason,
    specializations: role.specializable ? specializations : [],
  }))

  const evidence = specializations
    .flatMap((specialization) => specialization.evidence)
    .sort(compareEvidence)

  return {
    presetId: preset.id,
    presetVersion: preset.version,
    primaryRoleId: preset.primaryRoleId,
    roles,
    evidence,
  }
}
