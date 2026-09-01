import { parseConfigDocument } from '../../config/load.js'
import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { parseFrontmatter } from '../../core/frontmatter.js'
import { CONFIG_PATH } from '../../core/ownership.js'
import { containmentDiagnostic, type CheckContext } from '../context.js'

const INIT_REMEDIATION = 'Run `wrkrs init` to install wrkrs into this repository'

export async function checkConfig(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const resolved = await context.reader.resolve(CONFIG_PATH)
  if (!resolved.ok) {
    diagnostics.push(containmentDiagnostic('CONFIG_PATH_UNSAFE', 'error', resolved.error))
    return diagnostics
  }
  const partial = context.manifest?.state === 'partial-uninstall'
  const stat = resolved.value.stat
  if (!stat) {
    // A partial uninstall removes configuration on purpose and records that
    // in the manifest, so its absence is expected rather than a fault.
    diagnostics.push(
      partial
        ? createDiagnostic(
            'CONFIG_REMOVED_BY_UNINSTALL',
            'warning',
            'No .wrkrs/config.yaml is present; a previous uninstall removed it and left a reduced manifest',
            {
              path: CONFIG_PATH,
              remediation:
                'Run `wrkrs uninstall` again to remove what remains, or `wrkrs init` to reinstall',
            },
          )
        : createDiagnostic('CONFIG_MISSING', 'error', 'No .wrkrs/config.yaml was found', {
            path: CONFIG_PATH,
            remediation: INIT_REMEDIATION,
          }),
    )
    return diagnostics
  }
  if (stat.kind !== 'file') {
    diagnostics.push(
      createDiagnostic(
        stat.kind === 'symlink' ? 'CONFIG_PATH_UNSAFE' : 'CONFIG_NOT_A_FILE',
        'error',
        `.wrkrs/config.yaml is a ${stat.kind}; wrkrs did not read it`,
        {
          path: CONFIG_PATH,
          remediation: 'Replace the path with a regular file',
        },
      ),
    )
    return diagnostics
  }
  const text = await context.reader.readText(CONFIG_PATH)
  if (!text.ok) {
    diagnostics.push(containmentDiagnostic('CONFIG_PATH_UNSAFE', 'error', text.error))
    return diagnostics
  }

  const parsed = parseConfigDocument(text.value ?? '')
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
    const roleResolved = await context.reader.resolve(role.source)
    if (!roleResolved.ok) {
      diagnostics.push(
        containmentDiagnostic('CONFIG_ROLE_SOURCE_UNSAFE', 'error', roleResolved.error, {
          role: role.id,
        }),
      )
      continue
    }
    const roleStat = roleResolved.value.stat
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
          roleStat.kind === 'symlink'
            ? 'CONFIG_ROLE_SOURCE_UNSAFE'
            : 'CONFIG_ROLE_SOURCE_NOT_A_FILE',
          'error',
          `Role "${role.id}" source is a ${roleStat.kind}; wrkrs did not read it`,
          {
            path: role.source,
            remediation: 'Replace the path with a regular Markdown file',
            details: { role: role.id },
          },
        ),
      )
      continue
    }
    const roleText = await context.reader.readText(role.source)
    if (!roleText.ok) {
      diagnostics.push(
        containmentDiagnostic('CONFIG_ROLE_SOURCE_UNSAFE', 'error', roleText.error, {
          role: role.id,
        }),
      )
      continue
    }
    const frontmatter = parseFrontmatter(roleText.value ?? '')
    const id = frontmatter?.fields.get('id') ?? ''
    if (id !== role.id) {
      diagnostics.push(
        createDiagnostic(
          'CONFIG_ROLE_SOURCE_ID_MISMATCH',
          'error',
          `Role file does not declare the roster role id "${role.id}"`,
          {
            path: role.source,
            remediation: 'Set the frontmatter id to match the roster role id',
            details: { role: role.id },
          },
        ),
      )
    }
  }

  if (context.manifest && context.manifest.preset.id !== config.preset.id) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_PRESET_MISMATCH',
        'warning',
        `Manifest preset "${context.manifest.preset.id}" differs from config preset "${config.preset.id}"`,
        {
          path: CONFIG_PATH,
          remediation: 'Align the preset in config.yaml and manifest.json',
        },
      ),
    )
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
