import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import { CONFIG_PATH, SCHEMA_PATH } from '../../core/ownership.js'
import { sha256 } from '../../platform/hash.js'
import { isWithinRoot, toSystemPath } from '../../platform/paths.js'
import type { CheckContext } from '../context.js'

const UPDATE_REMEDIATION =
  'Restore the generated content from version control, or wait for the planned `wrkrs update` command to reconcile it'

export async function checkOwnership(context: CheckContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const manifest = context.manifest
  if (!manifest) return diagnostics
  const realRoot = (await context.fs.realpath(context.root)) ?? context.root
  const ownedPaths = new Set(manifest.entries.map((entry) => entry.path))

  for (const entry of manifest.entries) {
    const systemPath = toSystemPath(context.root, entry.path)
    const stat = await context.fs.lstat(systemPath)
    if (!stat) {
      diagnostics.push(
        createDiagnostic(
          'OWNED_FILE_MISSING',
          'error',
          `Owned file is missing (${entry.management})`,
          {
            path: entry.path,
            remediation: 'Restore the file from version control or reinstall wrkrs',
            details: { management: entry.management, sourceId: entry.sourceId },
          },
        ),
      )
      continue
    }
    if (stat.kind !== 'file') {
      diagnostics.push(
        createDiagnostic(
          'OWNED_PATH_NOT_A_FILE',
          'error',
          `Owned path is a ${stat.kind}, not a regular file`,
          {
            path: entry.path,
            remediation: 'Replace the path with the regular file wrkrs installed',
            details: { management: entry.management, kind: stat.kind },
          },
        ),
      )
      continue
    }
    const real = await context.fs.realpath(systemPath)
    if (real === null || !isWithinRoot(realRoot, real)) {
      diagnostics.push(
        createDiagnostic(
          'OWNED_PATH_ESCAPES_ROOT',
          'error',
          'Owned path resolves outside the repository',
          {
            path: entry.path,
            remediation: 'Remove the symlinked ancestor so the path stays inside the repository',
          },
        ),
      )
      continue
    }
    if ((stat.mode & 0o111) !== 0) {
      diagnostics.push(
        createDiagnostic(
          'OWNED_FILE_EXECUTABLE',
          'warning',
          'Generated file has an executable mode bit set',
          {
            path: entry.path,
            remediation: 'Generated files should be non-executable (0644)',
            details: { mode: stat.mode.toString(8) },
          },
        ),
      )
    }
    const hash = sha256(await context.fs.readFile(systemPath))
    if (hash === entry.lastAppliedHash) continue
    switch (entry.management) {
      case 'managed':
        diagnostics.push(
          createDiagnostic(
            'MANAGED_FILE_DRIFT',
            'error',
            'Managed file differs from the content wrkrs last applied',
            {
              path: entry.path,
              remediation: UPDATE_REMEDIATION,
              details: { expected: entry.lastAppliedHash, actual: hash, sourceId: entry.sourceId },
            },
          ),
        )
        break
      case 'seeded':
        diagnostics.push(
          createDiagnostic(
            'SEEDED_FILE_CUSTOMIZED',
            'info',
            'Seeded file was customized after installation; customization is preserved',
            {
              path: entry.path,
              details: { sourceId: entry.sourceId },
            },
          ),
        )
        break
      case 'referenced':
        diagnostics.push(
          createDiagnostic(
            'REFERENCED_FILE_CHANGED',
            'warning',
            'Referenced pre-existing file changed since installation; wrkrs never modifies it',
            {
              path: entry.path,
              details: { sourceId: entry.sourceId },
            },
          ),
        )
        break
      case 'patched':
        diagnostics.push(
          createDiagnostic(
            'PATCHED_FILE_CHANGED',
            'warning',
            'Shared file with wrkrs-owned fields changed since installation',
            {
              path: entry.path,
              details: { sourceId: entry.sourceId },
            },
          ),
        )
        break
    }
  }

  for (const path of [CONFIG_PATH, SCHEMA_PATH]) {
    if (!ownedPaths.has(path)) {
      diagnostics.push(
        createDiagnostic(
          'OWNERSHIP_CORE_FILE_NOT_OWNED',
          'warning',
          'Core wrkrs file is not recorded in the manifest',
          {
            path,
            remediation: 'A future `wrkrs update` can adopt it',
          },
        ),
      )
    }
  }

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(
      createDiagnostic(
        'OWNERSHIP_OK',
        'info',
        `All ${manifest.entries.length} owned paths are present and inside the repository`,
      ),
    )
  }
  return diagnostics
}
