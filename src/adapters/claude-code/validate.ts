import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { parseFrontmatter } from '../../core/frontmatter.js'
import type { AdapterValidationContext } from '../../core/runtime-adapter.js'
import { toSystemPath } from '../../platform/paths.js'
import {
  AGENT_PREFIX,
  AGENTS_DIRECTORY,
  agentName,
  agentPath,
  SKILL_NAME,
  SKILL_PATH,
} from './layout.js'

const REMEDIATION_REINSTALL =
  'Restore the file from version control or remove the wrkrs installation and run `wrkrs init` again'

async function readText(context: AdapterValidationContext, path: string): Promise<string | null> {
  const systemPath = toSystemPath(context.root, path)
  const stat = await context.fs.lstat(systemPath)
  if (!stat || stat.kind !== 'file') return null
  return new TextDecoder().decode(await context.fs.readFile(systemPath))
}

/**
 * Validates the generated Claude Code projections: presence, frontmatter,
 * names, skill wiring, and ownership. Read-only.
 */
export async function validateClaudeCodeInstallation(
  context: AdapterValidationContext,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const config = context.config
  if (!config) return diagnostics
  const owned = new Set(context.manifest?.entries.map((entry) => entry.path) ?? [])

  for (const role of config.roster.roles) {
    const path = agentPath(role.id)
    const expectedName = agentName(role.id)
    const stat = await context.fs.lstat(toSystemPath(context.root, path))
    if (!stat) {
      diagnostics.push(
        createDiagnostic('CLAUDE_AGENT_MISSING', 'error', `Claude agent projection is missing`, {
          path,
          remediation: REMEDIATION_REINSTALL,
          details: { role: role.id },
        }),
      )
      continue
    }
    if (stat.kind !== 'file') {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_AGENT_NOT_A_FILE',
          'error',
          `Claude agent path is a ${stat.kind}`,
          {
            path,
            remediation: 'Replace the path with the generated regular file',
          },
        ),
      )
      continue
    }
    const text = await readText(context, path)
    const frontmatter = text === null ? null : parseFrontmatter(text)
    if (!frontmatter) {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_AGENT_FRONTMATTER_INVALID',
          'error',
          'Claude agent frontmatter is missing or malformed',
          {
            path,
            remediation: REMEDIATION_REINSTALL,
          },
        ),
      )
      continue
    }
    const name = frontmatter.fields.get('name') ?? ''
    if (name !== expectedName) {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_AGENT_NAME_MISMATCH',
          'error',
          `Claude agent name "${name}" does not match "${expectedName}"`,
          {
            path,
            remediation: REMEDIATION_REINSTALL,
            details: { expected: expectedName, actual: name },
          },
        ),
      )
    }
    if ((frontmatter.fields.get('description') ?? '').trim() === '') {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_AGENT_DESCRIPTION_MISSING',
          'error',
          'Claude agent description is empty',
          {
            path,
            remediation: REMEDIATION_REINSTALL,
          },
        ),
      )
    }
    if (context.manifest && !owned.has(path)) {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_COMPONENT_UNOWNED',
          'warning',
          'Namespaced Claude agent is not recorded in the ownership manifest',
          {
            path,
            remediation:
              'A future `wrkrs update` can adopt it; until then it is treated as external',
          },
        ),
      )
    }
  }

  const skillStat = await context.fs.lstat(toSystemPath(context.root, SKILL_PATH))
  if (!skillStat) {
    diagnostics.push(
      createDiagnostic('CLAUDE_SKILL_MISSING', 'error', 'The wrkrs project skill is missing', {
        path: SKILL_PATH,
        remediation: REMEDIATION_REINSTALL,
      }),
    )
  } else if (skillStat.kind !== 'file') {
    diagnostics.push(
      createDiagnostic(
        'CLAUDE_SKILL_NOT_A_FILE',
        'error',
        `The wrkrs skill path is a ${skillStat.kind}`,
        {
          path: SKILL_PATH,
          remediation: 'Replace the path with the generated regular file',
        },
      ),
    )
  } else {
    const text = await readText(context, SKILL_PATH)
    const frontmatter = text === null ? null : parseFrontmatter(text)
    const expectedAgent = agentName(config.roster.primaryRole)
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['name', SKILL_NAME],
      ['context', 'fork'],
      ['agent', expectedAgent],
      ['disable-model-invocation', 'true'],
    ]
    if (!frontmatter) {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_SKILL_FRONTMATTER_INVALID',
          'error',
          'The wrkrs skill frontmatter is missing or malformed',
          {
            path: SKILL_PATH,
            remediation: REMEDIATION_REINSTALL,
          },
        ),
      )
    } else {
      for (const [field, expected] of expectations) {
        const actual = frontmatter.fields.get(field) ?? ''
        if (actual !== expected) {
          diagnostics.push(
            createDiagnostic(
              'CLAUDE_SKILL_FRONTMATTER_INVALID',
              'error',
              `The wrkrs skill field "${field}" is "${actual}" but should be "${expected}"`,
              {
                path: SKILL_PATH,
                remediation: REMEDIATION_REINSTALL,
                details: { field, expected, actual },
              },
            ),
          )
        }
      }
      if ((frontmatter.fields.get('description') ?? '').trim() === '') {
        diagnostics.push(
          createDiagnostic(
            'CLAUDE_SKILL_FRONTMATTER_INVALID',
            'error',
            'The wrkrs skill description is empty',
            {
              path: SKILL_PATH,
              remediation: REMEDIATION_REINSTALL,
              details: { field: 'description' },
            },
          ),
        )
      }
    }
    if (context.manifest && !owned.has(SKILL_PATH)) {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_COMPONENT_UNOWNED',
          'warning',
          'The wrkrs skill is not recorded in the ownership manifest',
          {
            path: SKILL_PATH,
            remediation:
              'A future `wrkrs update` can adopt it; until then it is treated as external',
          },
        ),
      )
    }
  }

  const agentsDirectory = toSystemPath(context.root, AGENTS_DIRECTORY)
  const agentsStat = await context.fs.lstat(agentsDirectory)
  if (agentsStat?.kind === 'directory') {
    const expected = new Set(config.roster.roles.map((role) => `${agentName(role.id)}.md`))
    for (const entry of await context.fs.readDirectory(agentsDirectory)) {
      if (!entry.name.startsWith(AGENT_PREFIX) || expected.has(entry.name)) continue
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_COMPONENT_UNEXPECTED',
          'warning',
          'A wrkrs-namespaced agent does not correspond to any configured role',
          {
            path: `${AGENTS_DIRECTORY}/${entry.name}`,
            remediation: 'Remove it or add the matching role to .wrkrs/config.yaml',
          },
        ),
      )
    }
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(
      createDiagnostic(
        'CLAUDE_ADAPTER_OK',
        'info',
        'Claude Code agent projections and the wrkrs skill are valid',
      ),
    )
  }
  return diagnostics
}
