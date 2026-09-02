import type { RuntimeAdapterRegistry } from '../adapters/registry.js'
import { runCheck } from '../check/check.js'
import { renderConfigJsonSchema } from '../config/json-schema.js'
import { serializeConfig } from '../config/serialize.js'
import {
  CONFIG_SCHEMA_VERSION,
  PRESET_ID,
  RUNTIME_ID,
  type ConfiguredRole,
  type WrkrsConfig,
} from '../core/configuration.js'
import { WrkrsError } from '../core/errors.js'
import { sortFindings } from '../core/findings.js'
import { CONFIG_PATH, MANIFEST_PATH, SCHEMA_PATH } from '../core/ownership.js'
import type { DesiredComponent, InstallPlan } from '../core/plan.js'
import type { ClockPort, EnvironmentPort, FileSystemPort, IdPort } from '../core/ports.js'
import type { ProviderRegistry } from '../core/provider.js'
import { recommendRoster, type RosterPreset, type RosterRecommendation } from '../core/roster.js'
import type { CompiledRole } from '../core/runtime-adapter.js'
import { err, ok, type Result } from '../core/result.js'
import type { RepositorySnapshot } from '../core/snapshot.js'
import { MINIMUM_NODE_VERSION, satisfiesMinimumVersion } from '../core/versions.js'
import type { GitPort } from '../platform/git.js'
import { buildInitPlan } from '../planner/init-plan.js'
import { compilePortableRoles } from '../presets/product-engineering/index.js'
import { analyzeRepository, snapshotTargets, type AnalyzeOptions } from '../repository/analyze.js'
import { locateRepository, type LocatedRepository, type LocateError } from '../repository/locate.js'
import { applyPlan, type ApplyResult } from '../writer/transaction.js'

export interface InitPorts {
  readonly fs: FileSystemPort
  readonly git: GitPort
  readonly clock: ClockPort
  readonly ids: IdPort
  readonly environment: EnvironmentPort
}

export interface InitDependencies {
  readonly wrkrsVersion: string
  readonly preset: RosterPreset
  readonly adapters: RuntimeAdapterRegistry
  readonly providers: ProviderRegistry
  /** Scan bounds; tests lower them to exercise truncation behavior. */
  readonly analyzeOptions?: AnalyzeOptions
}

export interface PreparedInit {
  readonly repository: LocatedRepository
  readonly snapshot: RepositorySnapshot
  readonly roster: RosterRecommendation
  readonly config: WrkrsConfig
  readonly plan: InstallPlan
}

const CORE_COMPONENT = 'wrkrs'
const CORE_SOURCE_VERSION = 1

export function locateErrorToWrkrsError(error: LocateError): WrkrsError {
  const codes: Record<LocateError['code'], string> = {
    GIT_NOT_FOUND: 'ENV_GIT_MISSING',
    GIT_NOT_A_REPOSITORY: 'REPOSITORY_NOT_A_GIT_REPOSITORY',
    GIT_BARE_REPOSITORY: 'REPOSITORY_BARE',
    GIT_NOT_IN_WORKTREE: 'REPOSITORY_NOT_IN_WORKTREE',
    GIT_COMMAND_FAILED: 'REPOSITORY_GIT_FAILED',
    CWD_NOT_FOUND: 'REPOSITORY_CWD_INVALID',
    CWD_NOT_A_DIRECTORY: 'REPOSITORY_CWD_INVALID',
  }
  return new WrkrsError(codes[error.code], error.message, {
    details: { gitCode: error.code },
  })
}

/** Builds the seeded configuration from a roster recommendation. */
export function buildConfig(roster: RosterRecommendation): WrkrsConfig {
  const roles: ConfiguredRole[] = roster.roles.map((role) => {
    const isSpecializable = role.id === 'software-engineer'
    return isSpecializable
      ? {
          id: role.id,
          source: role.source,
          specializations: role.specializations.map((specialization) => specialization.id),
        }
      : { id: role.id, source: role.source }
  })
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    preset: { id: PRESET_ID, version: roster.presetVersion },
    runtime: { primary: RUNTIME_ID },
    roster: { primaryRole: roster.primaryRoleId, roles },
    governance: {
      requirePlanApproval: true,
      requireDesignApproval: true,
      requireOwnerTestForUserFacingOrNativeWork: true,
      requireExplicitReleaseApproval: true,
    },
    execution: { profile: 'adaptive' },
    providers: {},
    extensions: {},
  }
}

/** Portable, runtime-independent components: config, schema, and role definitions. */
export function compileCoreComponents(
  config: WrkrsConfig,
  roles: readonly CompiledRole[],
  options: { readonly configYaml?: string; readonly schemaMigration?: true } = {},
): DesiredComponent[] {
  return [
    {
      path: CONFIG_PATH,
      content: options.configYaml ?? serializeConfig(config),
      management: 'seeded',
      sourceId: 'wrkrs/config',
      sourceVersion: CORE_SOURCE_VERSION,
      component: CORE_COMPONENT,
      reason: options.schemaMigration
        ? 'Comment-preserving schema migration of repository configuration'
        : 'Repository-owned wrkrs configuration (editable)',
      ...(options.schemaMigration ? { schemaMigration: true as const } : {}),
    },
    {
      path: SCHEMA_PATH,
      content: renderConfigJsonSchema(),
      management: 'managed',
      sourceId: 'wrkrs/schema',
      sourceVersion: CORE_SOURCE_VERSION,
      component: CORE_COMPONENT,
      reason: 'JSON Schema for config.yaml generated from the wrkrs schema definition',
    },
    ...roles.map((role): DesiredComponent => ({
      path: role.path,
      content: role.content,
      management: 'seeded',
      sourceId: `wrkrs/role/${role.id}`,
      sourceVersion: CORE_SOURCE_VERSION,
      component: CORE_COMPONENT,
      reason: `Portable ${role.title} role definition (editable)`,
    })),
  ]
}

/**
 * Steps 0-6 of the init flow: preflight, locate, read-only scan, findings,
 * roster recommendation, desired-state compilation, and planning. Performs
 * no write beneath the repository.
 */
export async function prepareInit(
  cwd: string,
  dependencies: InitDependencies,
  ports: InitPorts,
): Promise<Result<PreparedInit, WrkrsError>> {
  if (!satisfiesMinimumVersion(ports.environment.nodeVersion, MINIMUM_NODE_VERSION)) {
    return err(
      new WrkrsError(
        'ENV_NODE_VERSION_UNSUPPORTED',
        `Node.js ${ports.environment.nodeVersion} is below the minimum ${MINIMUM_NODE_VERSION}`,
        { details: { nodeVersion: ports.environment.nodeVersion, minimum: MINIMUM_NODE_VERSION } },
      ),
    )
  }
  const gitVersion = await ports.git.version()
  if (!gitVersion.ok) {
    return err(new WrkrsError('ENV_GIT_MISSING', gitVersion.error.message))
  }
  if (!ports.fs.containment.supported) {
    // Fail closed before any repository content is located or scanned.
    return err(
      new WrkrsError(
        'ENVIRONMENT_CONTAINMENT_UNSUPPORTED',
        `Strict repository containment is not available here: ${ports.fs.containment.reason}. Nothing in the repository was read or written; run wrkrs on macOS or Linux`,
        { details: { platform: ports.environment.platform } },
      ),
    )
  }
  const located = await locateRepository(cwd, ports)
  if (!located.ok) {
    return err(locateErrorToWrkrsError(located.error))
  }
  const repository = located.value
  const scanned = await analyzeRepository(repository, ports.fs, dependencies.analyzeOptions ?? {})
  const roster = recommendRoster(dependencies.preset, scanned.projectSignals)
  const config = buildConfig(roster)

  const adapter = dependencies.adapters.get(config.runtime.primary)
  if (!adapter) {
    return err(
      new WrkrsError(
        'CONFIG_RUNTIME_UNSUPPORTED',
        `Runtime "${config.runtime.primary}" is not registered`,
      ),
    )
  }
  const roles = compilePortableRoles(roster, config.execution)
  const analysis = adapter.analyze(scanned)
  const desired: DesiredComponent[] = [
    ...compileCoreComponents(config, roles),
    ...adapter.compile({ roster, config, roles }),
  ]
  for (const providerId of Object.keys(config.providers).sort()) {
    const provider = dependencies.providers.get(providerId)
    if (!provider) continue
    desired.push(
      ...provider.planConfiguration({ config, providerConfig: config.providers[providerId] }),
    )
  }

  // Every desired target (from the core, the runtime adapter, and any provider)
  // is snapshotted exactly, independently of the bounded generic index.
  const snapshot = await snapshotTargets(
    scanned,
    [...desired.map((component) => component.path), MANIFEST_PATH],
    ports.fs,
    dependencies.analyzeOptions ?? {},
  )

  const plan = buildInitPlan({
    snapshot,
    roster,
    desired,
    preserved: analysis.preserved,
    findings: sortFindings([...snapshot.findings, ...analysis.findings]),
    wrkrsVersion: dependencies.wrkrsVersion,
    runtimeAdapters: [{ id: adapter.id, version: adapter.version }],
    clock: ports.clock,
    ids: ports.ids,
  })
  return ok({ repository, snapshot, roster, config, plan })
}

/** Steps 9-12: lock, recheck, transactional apply, validation, commit or rollback. */
export function applyPreparedInit(
  prepared: PreparedInit,
  dependencies: InitDependencies,
  ports: InitPorts,
): Promise<ApplyResult> {
  return applyPlan(
    {
      plan: prepared.plan,
      validate: async ({ transactionId }) => {
        const report = await runCheck(
          {
            cwd: prepared.repository.root,
            wrkrsVersion: dependencies.wrkrsVersion,
            adapters: dependencies.adapters,
            providers: dependencies.providers,
            activeTransactionId: transactionId,
          },
          ports,
        )
        return report.diagnostics
      },
    },
    ports,
  )
}
