import { parseConfigDocument } from '../../config/load.js'
import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { parseFrontmatter } from '../../core/frontmatter.js'
import { CONFIG_PATH } from '../../core/ownership.js'
import { toSystemPath } from '../../platform/paths.js'
import { readRepositoryText, type CheckContext } from '../context.js'

const INIT_REMEDIATION = 'Run `wrkrs init` to install wrkrs into this repository'

export async function checkConfig(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const systemPath = toSystemPath(context.root, CONFIG_PATH)
  const stat = await context.fs.lstat(systemPath)
  if (!stat) {
    diagnostics.push(
      createDiagnostic('CONFIG_MISSING', 'error', 'No .wrkrs/config.yaml was found', {
        path: CONFIG_PATH,
        remediation: INIT_REMEDIATION,
      }),
    )
    return diagnostics
  }
  if (stat.kind !== 'file') {
    diagnostics.push(
      createDiagnostic('CONFIG_NOT_A_FILE', 'error', `.wrkrs/config.yaml is a ${stat.kind}`, {
        path: CONFIG_PATH,
        remediation: 'Replace the path with a regular file',
      }),
    )
    return diagnostics
  }

  const parsed = parseConfigDocument(await readRepositoryText(context, systemPath))
  if (!parsed.ok) {
    if (parsed.error.issues.length === 0) {
      diagnostics.push(
        createDiagnostic(parsed.error.code, 'error', parsed.error.message, {
          path: CONFIG_PATH,
          remediation: 'Fix the configuration file; see .wrkrs/schema.json for the expected shape',
        }),
      )
    }
    for (const issue of parsed.error.issues) {
      diagnostics.push(
        createDiagnostic(
          parsed.error.code,
          'error',
          `${issue.location ? issue.location + ': ' : ''}${issue.message}`,
          {
            path: CONFIG_PATH,
            remediation:
              'Fix the configuration file; see .wrkrs/schema.json for the expected shape',
            details: { issue: issue.code, ...(issue.location ? { location: issue.location } : {}) },
          },
        ),
      )
    }
    return diagnostics
  }
  const config = parsed.value
  context.config = config

  if (!context.adapters.get(config.runtime.primary)) {
    diagnostics.push(
      createDiagnostic(
        'CONFIG_RUNTIME_UNSUPPORTED',
        'error',
        `Runtime "${config.runtime.primary}" is not supported by this wrkrs version`,
        {
          path: CONFIG_PATH,
          remediation: `Supported runtimes: ${context.adapters.ids.join(', ')}`,
        },
      ),
    )
  }
  for (const providerId of Object.keys(config.providers).sort()) {
    if (!context.providers.get(providerId)) {
      diagnostics.push(
        createDiagnostic(
          'CONFIG_PROVIDER_UNKNOWN',
          'warning',
          `Provider "${providerId}" is configured but not available in this wrkrs version`,
          {
            path: CONFIG_PATH,
            remediation: 'Remove the provider entry or upgrade wrkrs when the provider ships',
            details: { provider: providerId },
          },
        ),
      )
    }
  }

  for (const role of config.roster.roles) {
    const roleSystemPath = toSystemPath(context.root, role.source)
    const roleStat = await context.fs.lstat(roleSystemPath)
    if (!roleStat) {
      diagnostics.push(
        createDiagnostic(
          'CONFIG_ROLE_SOURCE_MISSING',
          'error',
          `Role "${role.id}" references a missing source file`,
          {
            path: role.source,
            remediation:
              'Restore the role file from version control or update roster.roles[].source',
            details: { role: role.id },
          },
        ),
      )
      continue
    }
    if (roleStat.kind !== 'file') {
      diagnostics.push(
        createDiagnostic(
          'CONFIG_ROLE_SOURCE_NOT_A_FILE',
          'error',
          `Role "${role.id}" source is a ${roleStat.kind}`,
          {
            path: role.source,
            remediation: 'Replace the path with a regular Markdown file',
            details: { role: role.id },
          },
        ),
      )
      continue
    }
    const frontmatter = parseFrontmatter(await readRepositoryText(context, roleSystemPath))
    const id = frontmatter?.fields.get('id') ?? ''
    if (id !== role.id) {
      diagnostics.push(
        createDiagnostic(
          'CONFIG_ROLE_SOURCE_ID_MISMATCH',
          'error',
          `Role file declares id "${id}" but the roster expects "${role.id}"`,
          {
            path: role.source,
            remediation: 'Set the frontmatter id to match the roster role id',
            details: { role: role.id, actual: id },
          },
        ),
      )
    }
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(
      createDiagnostic(
        'CONFIG_OK',
        'info',
        `Configuration is valid (schema version ${config.schemaVersion}, ${config.roster.roles.length} roles, primary ${config.roster.primaryRole})`,
        {
          path: CONFIG_PATH,
        },
      ),
    )
  }
  return diagnostics
}
