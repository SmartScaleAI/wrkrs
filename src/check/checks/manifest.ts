import { parseManifestDocument } from '../../config/load.js'
import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { MANIFEST_PATH, MANIFEST_SCHEMA_VERSION } from '../../core/ownership.js'
import { containmentDiagnostic, type CheckContext } from '../context.js'

export async function checkManifest(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const resolved = await context.reader.resolve(MANIFEST_PATH)
  if (!resolved.ok) {
    diagnostics.push(containmentDiagnostic('MANIFEST_PATH_UNSAFE', 'error', resolved.error))
    return diagnostics
  }
  const stat = resolved.value.stat
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
      createDiagnostic(
        stat.kind === 'symlink' ? 'MANIFEST_PATH_UNSAFE' : 'MANIFEST_NOT_A_FILE',
        'error',
        `.wrkrs/manifest.json is a ${stat.kind}; wrkrs did not read it`,
        {
          path: MANIFEST_PATH,
          remediation: 'Replace the path with a regular file',
        },
      ),
    )
    return diagnostics
  }
  const text = await context.reader.readText(MANIFEST_PATH)
  if (!text.ok) {
    diagnostics.push(containmentDiagnostic('MANIFEST_PATH_UNSAFE', 'error', text.error))
    return diagnostics
  }
  const parsed = parseManifestDocument(text.value ?? '')
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
  const manifest = parsed.value.manifest
  context.manifest = manifest
  context.manifestSchemaVersion = parsed.value.sourceSchemaVersion

  if (parsed.value.migrated) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_MIGRATION_AVAILABLE',
        'warning',
        `Ownership manifest is schema version ${parsed.value.sourceSchemaVersion}; this wrkrs version writes version ${MANIFEST_SCHEMA_VERSION}`,
        {
          path: MANIFEST_PATH,
          remediation:
            'Run `wrkrs update` to rewrite the manifest in the current format; check never migrates it',
          details: {
            found: parsed.value.sourceSchemaVersion,
            current: MANIFEST_SCHEMA_VERSION,
          },
        },
      ),
    )
  }
  if (manifest.state === 'partial-uninstall') {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_PARTIAL_UNINSTALL',
        'warning',
        `A previous uninstall preserved ${manifest.entries.length} entr${manifest.entries.length === 1 ? 'y' : 'ies'}; this installation is partially removed`,
        {
          path: MANIFEST_PATH,
          remediation:
            'Review the remaining files, then run `wrkrs uninstall` again to remove what is now removable, or `wrkrs init` to reinstall',
          details: { state: manifest.state, entries: manifest.entries.length },
        },
      ),
    )
  }

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
  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_OK',
        'info',
        `Ownership manifest is valid (wrkrs ${manifest.wrkrsVersion}, state ${manifest.state}, ${manifest.entries.length} entries, installation ${manifest.installationId})`,
        {
          path: MANIFEST_PATH,
        },
      ),
    )
  }
  return diagnostics
}
