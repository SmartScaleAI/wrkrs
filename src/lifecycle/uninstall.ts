import { createDiagnostic, type Diagnostic } from '../core/diagnostics.js'
import type { WrkrsError } from '../core/errors.js'
import { sortFindings } from '../core/findings.js'
import { MANIFEST_PATH } from '../core/ownership.js'
import type { InstallPlan } from '../core/plan.js'
import { ok, type Result } from '../core/result.js'
import type { RosterRecommendation } from '../core/roster.js'
import { createRepositoryReader } from '../platform/contained-path.js'
import { sha256 } from '../platform/hash.js'
import type { InitDependencies, InitPorts } from '../init/init.js'
import { buildUninstallPlan } from '../planner/lifecycle-plan.js'
import { snapshotTargets } from '../repository/analyze.js'
import { applyPlan, type ApplyResult } from '../writer/transaction.js'
import { loadInstallation, readContents, rosterFromConfig, rosterFromManifest } from './common.js'
import type { LoadedInstallation } from './common.js'

export interface PreparedUninstall {
  readonly installation: LoadedInstallation
  readonly plan: InstallPlan
  readonly roster: RosterRecommendation
  /** Owned paths that will remain, with the exact hash planning observed. */
  readonly preserved: readonly { readonly path: string; readonly hash: string }[]
  /** True when nothing owned remains and the manifest itself is removed. */
  readonly complete: boolean
}

/**
 * Plans an uninstall from the validated manifest and current bytes alone.
 * Packaged templates are never consulted, so what wrkrs offers to remove is
 * exactly what it recorded installing and still recognizes byte for byte.
 */
export async function prepareUninstall(
  cwd: string,
  dependencies: InitDependencies,
  ports: InitPorts,
): Promise<Result<PreparedUninstall, WrkrsError>> {
  // Uninstall plans from the manifest alone, so a missing or unreadable
  // configuration never blocks it: a partial uninstall has already removed
  // config.yaml, and the retry that finishes the job must still work.
  const loaded = await loadInstallation(cwd, dependencies, ports, { requireConfig: false })
  if (!loaded.ok) return loaded
  const installation = loaded.value
  const { manifest } = installation

  const config = installation.config
  const rosterResult = config
    ? rosterFromConfig(dependencies.preset, config, installation.snapshot.projectSignals)
    : null
  const roster = rosterResult && rosterResult.ok ? rosterResult.value : rosterFromManifest(manifest)

  const touched = [...manifest.entries.map((entry) => entry.path), MANIFEST_PATH]
  const snapshot = await snapshotTargets(
    installation.snapshot,
    touched,
    ports.fs,
    dependencies.analyzeOptions ?? {},
  )
  const contents = await readContents(installation.repository.root, touched, ports)

  const plan = buildUninstallPlan({
    snapshot,
    manifest,
    contents,
    roster,
    findings: sortFindings([...snapshot.findings]),
    wrkrsVersion: dependencies.wrkrsVersion,
    clock: ports.clock,
    ids: ports.ids,
  })

  const preserved = plan.operations
    .filter((operation) => operation.outcome === 'preserve' || operation.outcome === 'block')
    .flatMap((operation) =>
      operation.expected.kind === 'file'
        ? [{ path: operation.path, hash: operation.expected.hash }]
        : [],
    )
  const complete = plan.operations.some(
    (operation) => operation.path === MANIFEST_PATH && operation.outcome === 'remove',
  )

  return ok({ installation: { ...installation, snapshot }, plan, roster, preserved, complete })
}

/**
 * Applies a prepared uninstall. Validation cannot be `wrkrs check`: a
 * completed uninstall deliberately leaves no configuration or manifest
 * behind. It proves the two things that matter instead — everything planned
 * for removal is gone, and everything preserved is byte-for-byte untouched.
 */
export function applyPreparedUninstall(
  prepared: PreparedUninstall,
  _dependencies: InitDependencies,
  ports: InitPorts,
): Promise<ApplyResult> {
  const root = prepared.installation.repository.root
  const removedPaths = prepared.plan.operations
    .filter((operation) => operation.outcome === 'remove')
    .map((operation) => operation.path)

  return applyPlan(
    {
      plan: prepared.plan,
      validate: async () => {
        const diagnostics: Diagnostic[] = []
        const reader = await createRepositoryReader(root, ports.fs)
        for (const path of removedPaths) {
          const resolved = await reader.resolve(path)
          if (!resolved.ok) {
            diagnostics.push(
              createDiagnostic('UNINSTALL_PATH_UNSAFE', 'error', resolved.error.message, {
                path,
                remediation: 'Inspect the path; wrkrs did not read through it',
              }),
            )
            continue
          }
          if (resolved.value.stat) {
            diagnostics.push(
              createDiagnostic(
                'UNINSTALL_FILE_PRESENT',
                'error',
                'A file planned for removal is still present after the removal ran',
                { path, remediation: 'Inspect the path and remove it manually' },
              ),
            )
          }
        }
        for (const item of prepared.preserved) {
          const bytes = await reader.readBytes(item.path)
          if (!bytes.ok || bytes.value === null) {
            diagnostics.push(
              createDiagnostic(
                'UNINSTALL_PRESERVED_MISSING',
                'error',
                'A file uninstall promised to preserve is no longer readable',
                { path: item.path, remediation: 'Restore the file from version control' },
              ),
            )
            continue
          }
          if (sha256(bytes.value) !== item.hash) {
            diagnostics.push(
              createDiagnostic(
                'UNINSTALL_PRESERVED_CHANGED',
                'error',
                'A file uninstall promised to preserve changed during the transaction',
                { path: item.path, remediation: 'Restore the file from version control' },
              ),
            )
          }
        }
        return diagnostics
      },
    },
    ports,
  )
}
