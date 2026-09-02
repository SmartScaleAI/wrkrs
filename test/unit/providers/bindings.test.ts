import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  READ_CAPABILITY_IDS,
  RESERVED_MUTATION_CAPABILITY_IDS,
} from '../../../src/core/capabilities.js'
import { resolveBinding } from '../../../src/core/provider.js'
import { builtinProviders } from '../../../src/providers/builtin.js'
import { createBuiltinProviderRegistry } from '../../../src/providers/index.js'
import { mcpServerMatchesProvider } from '../../../src/core/connections.js'
import { REPOSITORY_ROOT } from '../../helpers/temp.js'

describe('Increment 3B registered providers', () => {
  it('86: every provider declares only Increment 3 read capabilities and no reserved mutation capability', () => {
    const providers = builtinProviders()
    expect(providers.map((provider) => provider.id).sort()).toEqual(
      ['figma', 'github', 'linear', 'manual', 'mcp'].sort(),
    )
    for (const provider of providers) {
      expect(provider.capabilities.length).toBeGreaterThan(0)
      for (const capability of provider.capabilities) {
        expect(READ_CAPABILITY_IDS).toContain(capability)
        expect(RESERVED_MUTATION_CAPABILITY_IDS).not.toContain(capability)
      }
    }
    const mcp = providers.find((provider) => provider.id === 'mcp')!
    const manual = providers.find((provider) => provider.id === 'manual')!
    expect([...mcp.capabilities].sort()).toEqual([...READ_CAPABILITY_IDS].sort())
    expect([...manual.capabilities].sort()).toEqual([...READ_CAPABILITY_IDS].sort())
    expect(mcp.kinds).toEqual(['mcp-server'])
    expect(manual.kinds).toEqual(['manual'])
  })

  it('90/142: no provider claims unimplemented behavior or a credential field', () => {
    for (const provider of builtinProviders()) {
      const described = provider.describe({
        capability: provider.capabilities[0]!,
        binding:
          provider.id === 'manual'
            ? { provider: 'manual', kind: 'manual' }
            : provider.id === 'github'
              ? { provider: 'github', kind: 'cli', executable: 'gh' }
              : {
                  provider:
                    provider.id === 'mcp' ? 'mcp' : provider.id === 'linear' ? 'linear' : 'figma',
                  kind: 'mcp-server',
                  server: 'example-server',
                  scope: 'project',
                },
        verification: 'manual',
      })
      expect(described.summary.includes('\n')).toBe(false)
      for (const line of described.instructions) {
        expect(line.includes('\n')).toBe(false)
        expect(line.toLowerCase()).not.toMatch(/token|password|secret|api[_-]?key/)
      }
    }
  })

  it('96: manual guidance has no server reference', () => {
    const manual = builtinProviders().find((provider) => provider.id === 'manual')!
    const described = manual.describe({
      capability: 'work-item-context',
      binding: { provider: 'manual', kind: 'manual' },
      verification: 'manual',
    })
    expect(described.summary.toLowerCase()).not.toMatch(/\bserver\b/)
    expect(described.instructions.join(' ').toLowerCase()).not.toMatch(/\bserver\b/)
  })

  it('103: provider modules perform no network I/O', () => {
    const directory = path.join(REPOSITORY_ROOT, 'src', 'providers')
    const files = ['builtin.ts', 'registry.ts', 'index.ts'].map((name) =>
      readFileSync(path.join(directory, name), 'utf8'),
    )
    for (const text of files) {
      expect(text).not.toMatch(/from ['"]node:(http|https|net|dgram|dns|tls|undici)['"]/)
      expect(text).not.toMatch(/\bfetch\s*\(/)
    }
  })

  it('104: jsonc-parser is absent from the dependency set', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['jsonc-parser']).toBeUndefined()
    expect(pkg.devDependencies?.['jsonc-parser']).toBeUndefined()
  })

  it('143: Node engine floor is unchanged', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      engines: { node: string }
    }
    expect(pkg.engines.node).toBe('>=22.12')
  })

  it('registers the five providers through the composition helper', () => {
    const registry = createBuiltinProviderRegistry()
    expect(registry.ids).toHaveLength(5)
    expect(registry.get('github')?.title).toBe('GitHub')
  })

  it('dedicated MCP names match provider tokens; unmatched names stay generic mcp', () => {
    expect(mcpServerMatchesProvider('github', 'github')).toBe(true)
    expect(mcpServerMatchesProvider('github', 'github.com')).toBe(true)
    expect(mcpServerMatchesProvider('github', 'my-gh-mcp')).toBe(true)
    expect(mcpServerMatchesProvider('linear', 'linear')).toBe(true)
    expect(mcpServerMatchesProvider('figma', 'figma-dev')).toBe(true)
    expect(mcpServerMatchesProvider('github', 'fake-tracker')).toBe(false)
    expect(mcpServerMatchesProvider('linear', 'fake-tracker')).toBe(false)
    expect(mcpServerMatchesProvider('figma', 'github')).toBe(false)
    expect(mcpServerMatchesProvider('mcp', 'fake-tracker')).toBe(true)

    const github = builtinProviders().find((provider) => provider.id === 'github')!
    expect(
      github.probe({ snapshot: {} as never, projectServers: ['fake-tracker'], cliExecutables: [] })
        .available,
    ).toBe(false)
    expect(
      github.probe({ snapshot: {} as never, projectServers: ['github'], cliExecutables: [] })
        .available,
    ).toBe(true)
    expect(
      github.probe({ snapshot: {} as never, projectServers: [], cliExecutables: ['gh'] }).available,
    ).toBe(true)
    const mismatch = github.validate({
      capability: 'source-control-context',
      binding: { provider: 'github', kind: 'mcp-server', server: 'fake-tracker', scope: 'project' },
      verification: 'verified-project',
    })
    expect(mismatch.map((item) => item.code)).toEqual(['CONNECTION_SERVER_PROVIDER_MISMATCH'])

    const registry = createBuiltinProviderRegistry()
    const outcome = resolveBinding(
      'source-control-context',
      {
        provider: 'github',
        kind: 'mcp-server',
        server: 'fake-tracker',
        scope: 'project',
      },
      registry.get('github'),
      {
        projectServers: new Set(['fake-tracker']),
        cliExecutables: new Set(),
      },
    )
    expect(outcome.resolved).toBeNull()
    expect(outcome.diagnostics.map((item) => item.code)).toEqual([
      'CONNECTION_SERVER_PROVIDER_MISMATCH',
    ])
    expect(JSON.stringify(outcome.diagnostics)).not.toContain('fake-tracker')
  })
})
