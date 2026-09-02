import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type {
  RoleId,
  RosterPreset,
  RosterRecommendation,
  Specialization,
} from '../../core/roster.js'
import { PRESET_ID, PRESET_VERSION, type Execution } from '../../core/configuration.js'
import { ROLES_DIRECTORY } from '../../core/ownership.js'
import type { CompiledRole } from '../../core/runtime-adapter.js'
import { renderTemplate } from '../../core/template.js'

export interface PresetRoleDescription {
  readonly id: RoleId
  readonly title: string
  /** Short "when to use" description projected into runtime adapter frontmatter. */
  readonly summary: string
}

export const PRODUCT_ENGINEERING_ROLE_DESCRIPTIONS: readonly PresetRoleDescription[] = [
  {
    id: 'product-manager',
    title: 'Product Manager',
    summary:
      'Primary coordinator of the wrkrs Product Engineering team. Use to clarify a requested outcome, produce a plan for approval, sequence the other workers, and report status.',
  },
  {
    id: 'product-designer',
    title: 'Product Designer',
    summary:
      'Designs user-facing flows, interfaces, and content within existing product patterns. Use for design proposals that require owner approval before implementation.',
  },
  {
    id: 'software-engineer',
    title: 'Software Engineer',
    summary:
      'Implements approved plans in this repository with task-specific specializations. Use for code changes, refactors, and technical investigation.',
  },
  {
    id: 'qa-engineer',
    title: 'QA Engineer',
    summary:
      'Verifies delivered work against the approved plan and acceptance criteria. Use for test strategy, regression review, and release readiness evidence.',
  },
]

/**
 * The approved Product Engineering preset. Detected stack signals attach
 * specializations to the single Software Engineer role; they never introduce
 * additional permanent roles.
 */
export const productEngineeringPreset: RosterPreset = {
  id: PRESET_ID,
  version: PRESET_VERSION,
  primaryRoleId: 'product-manager',
  roles: [
    {
      id: 'product-manager',
      title: 'Product Manager',
      reason: 'Locked preset role; coordinates the roster and owns approval requests.',
      specializable: false,
    },
    {
      id: 'product-designer',
      title: 'Product Designer',
      reason: 'Locked preset role; owns user-facing design proposals.',
      specializable: false,
    },
    {
      id: 'software-engineer',
      title: 'Software Engineer',
      reason: 'Locked preset role; receives repository-specific specializations.',
      specializable: true,
    },
    {
      id: 'qa-engineer',
      title: 'QA Engineer',
      reason: 'Locked preset role; verifies delivered work.',
      specializable: false,
    },
  ],
  specializationRules: [
    {
      id: 'javascript',
      title: 'JavaScript and npm ecosystem',
      signals: ['node.package', 'node.lockfile'],
    },
    {
      id: 'typescript',
      title: 'TypeScript',
      signals: ['typescript.tsconfig', 'typescript.dependency'],
    },
    {
      id: 'web-frontend',
      title: 'Web frontend (React, Next.js)',
      signals: ['web.react', 'web.nextjs'],
    },
    { id: 'node-backend', title: 'Node.js backend services', signals: ['backend.node'] },
    {
      id: 'apple-platforms',
      title: 'Apple platforms (Swift, Xcode)',
      signals: ['apple.swift-package', 'apple.xcodeproj', 'apple.xcworkspace'],
    },
    {
      id: 'python-backend',
      title: 'Python services',
      signals: ['python.pyproject', 'python.requirements'],
    },
    { id: 'go-services', title: 'Go services', signals: ['go.module'] },
    { id: 'rust', title: 'Rust', signals: ['rust.cargo'] },
    {
      id: 'monorepo-tooling',
      title: 'Monorepo tooling',
      signals: ['monorepo.workspaces', 'monorepo.marker'],
    },
  ],
  roleSourcePath(roleId) {
    return `${ROLES_DIRECTORY}/${roleId}.md`
  },
}

export function describePresetRole(roleId: RoleId): PresetRoleDescription {
  const description = PRODUCT_ENGINEERING_ROLE_DESCRIPTIONS.find((role) => role.id === roleId)
  if (!description) throw new Error(`Unknown preset role "${roleId}"`)
  return description
}

/** Reads a packaged role template. Templates ship inside the npm package. */
export function loadRoleTemplate(roleId: RoleId): string {
  const templatePath = fileURLToPath(new URL(`./roles/${roleId}.md`, import.meta.url))
  return readFileSync(templatePath, 'utf8')
}

export function renderSpecializationSection(specializations: readonly Specialization[]): string {
  if (specializations.length === 0) {
    return [
      'No repository-specific specialization was detected during installation.',
      'Add identifiers under `roster.roles[].specializations` in `.wrkrs/config.yaml` when the codebase gains a stack worth naming.',
    ].join('\n')
  }
  return specializations
    .map((specialization) => {
      const evidence = specialization.evidence
        .map((item) => `${item.path} (${item.detail})`)
        .join(', ')
      // A specialization can be declared in configuration without a current
      // signal in the repository. It is kept and named honestly rather than
      // dropped or given invented evidence.
      return evidence === ''
        ? `- **${specialization.title}** (\`${specialization.id}\`) — declared in \`.wrkrs/config.yaml\`; no supporting signal detected in this repository`
        : `- **${specialization.title}** (\`${specialization.id}\`) — evidence: ${evidence}`
    })
    .join('\n')
}

/** Renders every portable role definition for a recommendation. */
export function compilePortableRoles(
  recommendation: RosterRecommendation,
  execution: Execution = { profile: 'adaptive' },
): CompiledRole[] {
  return recommendation.roles.map((role) => {
    const template = loadRoleTemplate(role.id)
    const variables: Record<string, string> = {}
    if (role.id === 'software-engineer') {
      variables['specializations'] = renderSpecializationSection(role.specializations)
    }
    if (role.id === 'product-manager') {
      variables['executionProfile'] = execution.profile
    }
    return {
      id: role.id,
      title: role.title,
      path: role.source,
      content: renderTemplate(template, variables),
    }
  })
}
