import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stripFrontmatter } from '../../core/frontmatter.js'
import type { DesiredComponent } from '../../core/plan.js'
import type { AdapterCompileInput } from '../../core/runtime-adapter.js'
import { renderTemplate } from '../../core/template.js'
import { describePresetRole } from '../../presets/product-engineering/index.js'
import type { RoleId } from '../../core/roster.js'
import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  agentName,
  agentPath,
  agentSourceId,
  SKILL_PATH,
  SKILL_SOURCE_ID,
} from './layout.js'

function loadTemplate(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`./templates/${relative}`, import.meta.url)), 'utf8')
}

function describeGovernance(input: AdapterCompileInput): string {
  const governance = input.config.governance
  const parts = [
    `plan approval ${governance.requirePlanApproval ? 'required' : 'not required'}`,
    `design approval ${governance.requireDesignApproval ? 'required' : 'not required'}`,
    `owner testing for user-facing or native work ${governance.requireOwnerTestForUserFacingOrNativeWork ? 'required' : 'not required'}`,
    `explicit release approval ${governance.requireExplicitReleaseApproval ? 'required' : 'not required'}`,
  ]
  return parts.join('; ')
}

function rosterList(input: AdapterCompileInput): string {
  return input.roster.roles
    .map((role) => `\`${agentName(role.id)}\`${role.primary ? ' (primary)' : ''}`)
    .join(', ')
}

/**
 * Compiles the namespaced Claude project agents and the explicit wrkrs skill.
 * Every projection is a managed file derived from the portable role content
 * passed in; nothing here reads or writes the target repository.
 */
export function compileClaudeCodeComponents(input: AdapterCompileInput): DesiredComponent[] {
  const agentTemplate = loadTemplate('agents/agent.md')
  const skillTemplate = loadTemplate('skills/SKILL.md')
  const roster = rosterList(input)
  const governance = describeGovernance(input)
  const components: DesiredComponent[] = []

  for (const role of input.roster.roles) {
    const compiledRole = input.roles.find((candidate) => candidate.id === role.id)
    if (!compiledRole) {
      throw new Error(`No compiled role content for "${role.id}"`)
    }
    const description = describePresetRole(role.id as RoleId)
    const specializationNote =
      role.specializations.length > 0
        ? ` Active specializations: ${role.specializations.map((item) => item.id).join(', ')}.`
        : role.id === 'software-engineer'
          ? ' No repository-specific specialization was detected.'
          : ''
    const body = stripFrontmatter(compiledRole.content).replace(/^\n+/, '').replace(/\n*$/, '\n')
    const content = renderTemplate(agentTemplate, {
      name: agentName(role.id),
      description: `${description.summary}${specializationNote}`,
      roleSource: compiledRole.path,
      roleBody: body,
      rosterList: roster,
      governance,
    })
    components.push({
      path: agentPath(role.id),
      content,
      management: 'managed',
      sourceId: agentSourceId(role.id),
      sourceVersion: ADAPTER_VERSION,
      component: ADAPTER_ID,
      reason: `Claude Code subagent projection of the ${role.title} role`,
    })
  }

  components.push({
    path: SKILL_PATH,
    content: renderTemplate(skillTemplate, {
      primaryAgent: agentName(input.roster.primaryRoleId),
      rosterList: roster,
    }),
    management: 'managed',
    sourceId: SKILL_SOURCE_ID,
    sourceVersion: ADAPTER_VERSION,
    component: ADAPTER_ID,
    reason: 'Explicit user-invoked entry point that delegates to the Product Manager worker',
  })

  return components
}
