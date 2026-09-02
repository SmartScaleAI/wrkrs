import type { ReadCapabilityId } from '../core/capabilities.js'
import type { ProviderDefinition, ProviderGuidance } from '../core/provider.js'
import type { ProviderBindingContext } from '../core/provider.js'

function guidance(summary: string, instructions: readonly string[]): ProviderGuidance {
  return { summary, instructions }
}

function describeDedicated(
  title: string,
  context: ProviderBindingContext,
  uses: string,
): ProviderGuidance {
  const { binding, verification, capability } = context
  if (binding.kind === 'manual') {
    return guidance(`${title} is not bound as a tool for ${capability}; use the manual fallback`, [
      `Gather ${uses} without a bound ${title} connection.`,
    ])
  }
  if (binding.kind === 'cli') {
    return guidance(`${title} CLI supplies ${capability} (${verification})`, [
      `Use the ${title} command-line tool bound for ${uses}.`,
      'wrkrs does not install, authenticate, or execute that tool.',
    ])
  }
  return guidance(`${title} MCP server supplies ${capability} (${verification})`, [
    `Use the existing ${title} MCP server bound for ${uses}.`,
    'Reference it by the configured server name only. wrkrs does not install or authenticate it.',
  ])
}

const github: ProviderDefinition = {
  id: 'github',
  title: 'GitHub',
  capabilities: ['source-control-context', 'pull-request-context'],
  kinds: ['mcp-server', 'cli'],
  probe(context) {
    const available = context.projectServers.length > 0 || context.cliExecutables.includes('gh')
    return { available, findings: [] }
  },
  validate: () => [],
  describe: (context) =>
    describeDedicated('GitHub', context, 'branches, commits, diffs, and pull requests'),
}

const linear: ProviderDefinition = {
  id: 'linear',
  title: 'Linear',
  capabilities: ['work-item-context'],
  kinds: ['mcp-server'],
  probe(context) {
    return { available: context.projectServers.length > 0, findings: [] }
  },
  validate: () => [],
  describe: (context) => describeDedicated('Linear', context, 'work items and acceptance criteria'),
}

const figma: ProviderDefinition = {
  id: 'figma',
  title: 'Figma',
  capabilities: ['design-file-context', 'design-comment-context'],
  kinds: ['mcp-server'],
  probe(context) {
    return { available: context.projectServers.length > 0, findings: [] }
  },
  validate: () => [],
  describe: (context) => describeDedicated('Figma', context, 'design files and design comments'),
}

const mcp: ProviderDefinition = {
  id: 'mcp',
  title: 'Existing MCP server',
  capabilities: [
    'source-control-context',
    'pull-request-context',
    'work-item-context',
    'design-file-context',
    'design-comment-context',
  ],
  kinds: ['mcp-server'],
  probe(context) {
    return { available: context.projectServers.length > 0, findings: [] }
  },
  validate: () => [],
  describe(context) {
    return guidance(
      `Existing MCP server supplies ${context.capability} (${context.verification})`,
      [
        `Use the existing MCP server bound for ${context.capability}.`,
        'Reference it by the configured server name only. wrkrs does not install or authenticate it.',
      ],
    )
  },
}

const manual: ProviderDefinition = {
  id: 'manual',
  title: 'Manual',
  capabilities: [
    'source-control-context',
    'pull-request-context',
    'work-item-context',
    'design-file-context',
    'design-comment-context',
  ],
  kinds: ['manual'],
  probe() {
    return { available: true, findings: [] }
  },
  validate: () => [],
  describe(context) {
    return guidance(`Manual fallback for ${context.capability}; no tool access`, [
      `Gather ${context.capability} without a bound tool.`,
      'Do not assume a ticket system, CLI, or remote integration is connected.',
    ])
  },
}

export function builtinProviders(): readonly ProviderDefinition[] {
  return [github, linear, figma, mcp, manual]
}

export type { ReadCapabilityId }
