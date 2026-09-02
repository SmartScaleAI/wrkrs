import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { parseFrontmatter } from '../../core/frontmatter.js'
import type { AdapterValidationContext } from '../../core/runtime-adapter.js'
import {
  createRepositoryReader,
  type ContainmentFailure,
  type RepositoryReader,
} from '../../platform/contained-path.js'
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

function unsafe(failure: ContainmentFailure, extra: Record<string, string> = {}): Diagnostic {
  return createDiagnostic(
    'CLAUDE_PATH_UNSAFE',
    'error',
    `${failure.message}; wrkrs did not read it`,
    {
      path: failure.ancestor ?? failure.path,
      remediation:
        'Replace the symlinked or unsafe path with a real path inside the repository, or move it aside',
      details: { reason: failure.code, requested: failure.path, ...extra },
    },
  )
}

type Read =
  | { kind: 'absent' }
  | { kind: 'unsafe'; diagnostic: Diagnostic }
  | { kind: 'not-a-file'; fileKind: string }
  | { kind: 'text'; text: string }

async function readComponent(reader: RepositoryReader, path: string): Promise<Read> {
  const resolved = await reader.resolve(path)
  if (!resolved.ok) return { kind: 'unsafe', diagnostic: unsafe(resolved.error) }
  const stat = resolved.value.stat
  if (!stat) return { kind: 'absent' }
  if (stat.kind === 'symlink') {
    return {
      kind: 'unsafe',
      diagnostic: unsafe({
        code: 'PATH_TARGET_SYMLINK',
        path,
        ancestor: null,
        message: `"${path}" is a symlink`,
      }),
    }
  }
  if (stat.kind !== 'file') return { kind: 'not-a-file', fileKind: stat.kind }
  const text = await reader.readText(path)
  if (!text.ok) return { kind: 'unsafe', diagnostic: unsafe(text.error) }
  return { kind: 'text', text: text.value ?? '' }
}

/**
 * Validates the generated Claude Code projections: presence, frontmatter,
 * names, skill wiring, and ownership. Read-only and contained: nothing is
 * read through a symlinked `.claude`, agent, or skill path.
 */
export async function validateClaudeCodeInstallation(
  context: AdapterValidationContext,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const config = context.config
  if (!config) return diagnostics
  const reader = await createRepositoryReader(context.root, context.fs)
  const owned = new Set(context.manifest?.entries.map((entry) => entry.path) ?? [])

  for (const role of config.roster.roles) {
    const path = agentPath(role.id)
    const expectedName = agentName(role.id)
    const read = await readComponent(reader, path)
    if (read.kind === 'unsafe') {
      diagnostics.push(read.diagnostic)
      continue
    }
    if (read.kind === 'absent') {
      diagnostics.push(
        createDiagnostic('CLAUDE_AGENT_MISSING', 'error', `Claude agent projection is missing`, {
          path,
          remediation: REMEDIATION_REINSTALL,
          details: { role: role.id },
        }),
      )
      continue
    }
    if (read.kind === 'not-a-file') {
      diagnostics.push(
        createDiagnostic(
          'CLAUDE_AGENT_NOT_A_FILE',
          'error',
          `Claude agent path is a ${read.fileKind}`,
          {
            path,
            remediation: 'Replace the path with the generated regular file',
          },
        ),
      )
      continue
    }
    const frontmatter = parseFrontmatter(read.text)
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
          `Claude agent name does not match "${expectedName}"`,
          {
            path,
            remediation: REMEDIATION_REINSTALL,
            details: { expected: expectedName },
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

  const skill = await readComponent(reader, SKILL_PATH)
  if (skill.kind === 'unsafe') {
    diagnostics.push(skill.diagnostic)
  } else if (skill.kind === 'absent') {
    diagnostics.push(
      createDiagnostic('CLAUDE_SKILL_MISSING', 'error', 'The wrkrs project skill is missing', {
        path: SKILL_PATH,
        remediation: REMEDIATION_REINSTALL,
      }),
    )
  } else if (skill.kind === 'not-a-file') {
    diagnostics.push(
      createDiagnostic(
        'CLAUDE_SKILL_NOT_A_FILE',
        'error',
        `The wrkrs skill path is a ${skill.fileKind}`,
        {
          path: SKILL_PATH,
          remediation: 'Replace the path with the generated regular file',
        },
      ),
    )
  } else {
    const frontmatter = parseFrontmatter(skill.text)
    const expectedAgent = agentName(config.roster.primaryRole)
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['name', SKILL_NAME],
      ['context', 'fork'],
      ['background', 'false'],
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
              `The wrkrs skill field "${field}" should be "${expected}"`,
              {
                path: SKILL_PATH,
                remediation: REMEDIATION_REINSTALL,
                details: { field, expected },
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

  const listing = await reader.listDirectory(AGENTS_DIRECTORY)
  if (!listing.ok) {
    diagnostics.push(unsafe(listing.error))
  } else if (listing.value) {
    const expected = new Set(config.roster.roles.map((role) => `${agentName(role.id)}.md`))
    for (const entry of listing.value) {
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
