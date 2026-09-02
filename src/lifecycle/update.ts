import { runCheck } from '../check/check.js'
import { serializeConfig } from '../config/serialize.js'
import { migrateConfigDocumentToCurrent } from '../config/migrations/index.js'
import { CONFIG_SCHEMA_VERSION } from '../core/configuration.js'
import { configuredCliExecutables } from '../core/connections.js'
import { WrkrsError } from '../core/errors.js'
import { createFinding, sortFindings, type Finding } from '../core/findings.js'
import { CONFIG_PATH, MANIFEST_PATH } from '../core/ownership.js'
import type { DesiredComponent, InstallPlan } from '../core/plan.js'
import { resolveConnections } from '../core/provider.js'
import { err, ok, type Result } from '../core/result.js'
import type { RosterRecommendation } from '../core/roster.js'
import { isConnectionIdentifier } from '../core/sanitize.js'
import { compileCoreComponents, type InitDependencies, type InitPorts } from '../init/init.js'
import { buildUpdatePlan } from '../planner/lifecycle-plan.js'
import { findPresentExecutables } from '../platform/environment.js'
import { sha256 } from '../platform/hash.js'
import { compilePortableRoles } from '../presets/product-engineering/index.js'
import { snapshotTargets } from '../repository/analyze.js'
import { applyPlan, type ApplyResult } from '../writer/transaction.js'
import { loadInstallation, readContents, rosterFromConfig } from './common.js'
import type { LoadedInstallation } from './common.js'

export interface PreparedUpdate {
  readonly installation: LoadedInstallation
  readonly roster: RosterRecommendation
  readonly plan: InstallPlan
  /** Owned paths deliberately left alone because they changed since wrkrs applied them. */
  readonly preservedPaths: readonly string[]
}

/**
 * Plans an update from two owned inputs only: the packaged wrkrs version and
 * the repository's own .wrkrs/config.yaml. Repository detection runs, but
 * only to supply evidence for specializations config already declares.
 * Performs no write.
 */
export async function prepareUpdate(
  cwd: string,
  dependencies: InitDependencies,
  ports: InitPorts,
): Promise<Result<PreparedUpdate, WrkrsError>> {
  const loaded = await loadInstallation(cwd, dependencies, ports)
  if (!loaded.ok) return loaded
  const installation = loaded.value
  const { manifest } = installation
  const config = installation.config
  if (!config) {
    return err(
      new WrkrsError(
        'CONFIG_MISSING',
        'Update needs .wrkrs/config.yaml; restore it from version control, or run `wrkrs init` to reinstall',
      ),
    )
  }

  const roster = rosterFromConfig(dependencies.preset, config, installation.snapshot.projectSignals)
  if (!roster.ok) return roster

  const adapter = dependencies.adapters.get(config.runtime.primary)
  if (!adapter) {
    return err(
      new WrkrsError(
        'CONFIG_RUNTIME_UNSUPPORTED',
        `Runtime "${config.runtime.primary}" is not registered`,
      ),
    )
  }

  const roles = compilePortableRoles(roster.value, config.execution)
  const projectServers = (
    installation.snapshot.claude.mcp?.servers.map((server) => server.name) ?? []
  ).filter(isConnectionIdentifier)
  const cliExecutables = await findPresentExecutables(
    configuredCliExecutables(Object.values(config.connections)),
    ports.environment,
    ports.fs,
  )
  const resolved = resolveConnections(config.connections, dependencies.providers, {
    projectServers: new Set(projectServers),
    cliExecutables,
  })
  const configEntry = manifest.entries.find((entry) => entry.path === CONFIG_PATH)
  let configYaml = serializeConfig(config)
  let schemaMigration: true | undefined
  if (
    installation.configSourceSchemaVersion !== null &&
    installation.configSourceSchemaVersion < CONFIG_SCHEMA_VERSION &&
    installation.configSourceText !== null
  ) {
    const migrated = migrateConfigDocumentToCurrent(
      installation.configSourceText,
      installation.configSourceSchemaVersion,
    )
    if (!migrated.ok) {
      return err(
        new WrkrsError(migrated.error.code, migrated.error.message, {
          details: migrated.error.details ?? {},
        }),
      )
    }
    configYaml = migrated.value
    schemaMigration = true
  } else if (
    installation.configSourceText !== null &&
    configEntry !== undefined &&
    sha256(installation.configSourceText) === configEntry.lastAppliedHash
  ) {
    // Keep the on-disk bytes, including owner comments and key order. A later
    // update must not re-serialize an undrifted migrated file.
    configYaml = installation.configSourceText
  }
  const desired: DesiredComponent[] = [
    ...compileCoreComponents(
      config,
      roles,
      schemaMigration ? { configYaml, schemaMigration } : { configYaml },
    ),
    ...adapter.compile({
      roster: roster.value,
      config,
      roles,
      connections: resolved.resolved,
    }),
  ]

  const touched = [
    ...desired.map((component) => component.path),
    ...manifest.entries.map((entry) => entry.path),
    MANIFEST_PATH,
  ]
  const snapshot = await snapshotTargets(
    installation.snapshot,
    touched,
    ports.fs,
    dependencies.analyzeOptions ?? {},
  )
  const contents = await readContents(installation.repository.root, touched, ports)

  // Detection is an evidence source only. A specialization configuration
  // declares without a current signal is kept and named, never dropped.
  const evidenceless: Finding[] = roster.value.roles.flatMap((role) =>
    role.specializations
      .filter((specialization) => specialization.evidence.length === 0)
      .map((specialization) =>
        createFinding(
          'SPECIALIZATION_WITHOUT_EVIDENCE',
          'info',
          `Specialization "${specialization.id}" is declared in configuration but no signal for it was detected; it is kept without evidence`,
          {
            path: CONFIG_PATH,
            evidence: [
              { key: 'role', value: role.id },
              { key: 'specialization', value: specialization.id },
            ],
          },
        ),
      ),
  )

  const plan = buildUpdatePlan({
    snapshot,
    manifest,
    contents,
    roster: roster.value,
    desired,
    findings: sortFindings([...snapshot.findings, ...evidenceless]),
    wrkrsVersion: dependencies.wrkrsVersion,
    runtimeAdapters: [{ id: adapter.id, version: adapter.version }],
    clock: ports.clock,
    ids: ports.ids,
  })

  return ok({
    installation: { ...installation, snapshot },
    roster: roster.value,
    plan,
    preservedPaths: plan.operations
      .filter((operation) => operation.outcome === 'preserve')
      .map((operation) => operation.path),
  })
}

/**
 * Applies a prepared update through the same journaled transaction init uses.
 * Post-apply validation is `wrkrs check`, except that drift on a path this
 * update deliberately preserved is expected rather than a failure.
 */
export function applyPreparedUpdate(
  prepared: PreparedUpdate,
  dependencies: InitDependencies,
  ports: InitPorts,
): Promise<ApplyResult> {
  const preserved = new Set(prepared.preservedPaths)
  return applyPlan(
    {
      plan: prepared.plan,
      validate: async ({ transactionId }) => {
        const report = await runCheck(
          {
            cwd: prepared.installation.repository.root,
            wrkrsVersion: dependencies.wrkrsVersion,
            adapters: dependencies.adapters,
            providers: dependencies.providers,
            activeTransactionId: transactionId,
          },
          ports,
        )
        // Drift the update chose to preserve is the expected outcome here, so
        // it is reported as a warning rather than failing the transaction.
        return report.diagnostics.map((diagnostic) =>
          diagnostic.code === 'MANAGED_FILE_DRIFT' &&
          diagnostic.path !== null &&
          preserved.has(diagnostic.path)
            ? { ...diagnostic, severity: 'warning' as const }
            : diagnostic,
        )
      },
    },
    ports,
  )
}
