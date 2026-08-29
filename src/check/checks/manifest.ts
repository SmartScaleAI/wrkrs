import { parseManifestDocument } from '../../config/load.js'
import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { MANIFEST_PATH } from '../../core/ownership.js'
import { toSystemPath } from '../../platform/paths.js'
import { readRepositoryText, type CheckContext } from '../context.js'

export async function checkManifest(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const systemPath = toSystemPath(context.root, MANIFEST_PATH)
  const stat = await context.fs.lstat(systemPath)
  if (!stat) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_MISSING',
        'error',
        'No .wrkrs/manifest.json ownership manifest was found',
        {
          path: MANIFEST_PATH,
          remediation:
            'Run `wrkrs init` to install wrkrs, or restore the manifest from version control',
        },
      ),
    )
    return diagnostics
  }
  if (stat.kind !== 'file') {
    diagnostics.push(
      createDiagnostic('MANIFEST_NOT_A_FILE', 'error', `.wrkrs/manifest.json is a ${stat.kind}`, {
        path: MANIFEST_PATH,
        remediation: 'Replace the path with a regular file',
      }),
    )
    return diagnostics
  }
  const parsed = parseManifestDocument(await readRepositoryText(context, systemPath))
  if (!parsed.ok) {
    if (parsed.error.issues.length === 0) {
      diagnostics.push(
        createDiagnostic(parsed.error.code, 'error', parsed.error.message, {
          path: MANIFEST_PATH,
          remediation: 'Restore the manifest from version control',
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
            path: MANIFEST_PATH,
            remediation: 'Restore the manifest from version control',
            details: { issue: issue.code, ...(issue.location ? { location: issue.location } : {}) },
          },
        ),
      )
    }
    return diagnostics
  }
  const manifest = parsed.value
  context.manifest = manifest

  for (const adapter of manifest.runtimeAdapters) {
    if (!context.adapters.get(adapter.id)) {
      diagnostics.push(
        createDiagnostic(
          'MANIFEST_ADAPTER_UNKNOWN',
          'error',
          `Manifest references runtime adapter "${adapter.id}" which this wrkrs version does not provide`,
          {
            path: MANIFEST_PATH,
            remediation: `Supported runtime adapters: ${context.adapters.ids.join(', ')}`,
            details: { adapter: adapter.id },
          },
        ),
      )
    }
  }
  if (context.config && context.config.preset.id !== manifest.preset.id) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_PRESET_MISMATCH',
        'warning',
        `Manifest preset "${manifest.preset.id}" differs from config preset "${context.config.preset.id}"`,
        {
          path: MANIFEST_PATH,
          remediation: 'Align the preset in config.yaml and manifest.json',
        },
      ),
    )
  }
  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_OK',
        'info',
        `Ownership manifest is valid (wrkrs ${manifest.wrkrsVersion}, ${manifest.entries.length} entries, installation ${manifest.installationId})`,
        {
          path: MANIFEST_PATH,
        },
      ),
    )
  }
  return diagnostics
}
