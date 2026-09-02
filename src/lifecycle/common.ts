import { parseConfigDocument } from '../config/load.js'
import type { WrkrsConfig } from '../core/configuration.js'
import { WrkrsError } from '../core/errors.js'
import { CONFIG_PATH, MANIFEST_PATH, type OwnershipManifest } from '../core/ownership.js'
import { err, ok, type Result } from '../core/result.js'
import { isRoleId, type RosterPreset, type RosterRecommendation } from '../core/roster.js'
import type { RecommendedRole, Specialization } from '../core/roster.js'
import type { ProjectSignal, RepositorySnapshot } from '../core/snapshot.js'
import { MINIMUM_NODE_VERSION, satisfiesMinimumVersion } from '../core/versions.js'
import { createRepositoryReader } from '../platform/contained-path.js'
import type { ContentIndex } from '../planner/lifecycle-plan.js'
import { analyzeRepository } from '../repository/analyze.js'
import { locateRepository, type LocatedRepository } from '../repository/locate.js'
import { locateErrorToWrkrsError, type InitDependencies, type InitPorts } from '../init/init.js'

/** An installation as the lifecycle commands read it: located, scanned, and validated. */
export interface LoadedInstallation {
  readonly repository: LocatedRepository
  readonly snapshot: RepositorySnapshot
  /**
   * Null only when configuration is genuinely absent and the command does not
   * need it. A partial uninstall removes config.yaml while the reduced
   * manifest remains, and a retry must still be able to finish the job.
   */
  readonly config: WrkrsConfig | null
  /** Original config.yaml bytes when the file was readable. */
  readonly configSourceText: string | null
  /** Schema version of config.yaml on disk, before in-memory migration. */
  readonly configSourceSchemaVersion: number | null
  readonly manifest: OwnershipManifest
  /** True when the manifest on disk predates the current schema version. */
  readonly manifestMigrated: boolean
}

const NOT_INSTALLED =
  'No wrkrs installation was found in this repository. Run `wrkrs init` to install one'

/**
 * Shared preflight for update and uninstall: the same environment gates init
 * uses, then a read-only scan and a validated configuration and manifest.
 * Nothing is written and nothing is repaired.
 */
export async function loadInstallation(
  cwd: string,
  dependencies: InitDependencies,
  ports: InitPorts,
  options: { requireConfig: boolean } = { requireConfig: true },
): Promise<Result<LoadedInstallation, WrkrsError>> {
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
  if (!gitVersion.ok) return err(new WrkrsError('ENV_GIT_MISSING', gitVersion.error.message))
  if (!ports.fs.containment.supported) {
    return err(
      new WrkrsError(
        'ENVIRONMENT_CONTAINMENT_UNSUPPORTED',
        `Strict repository containment is not available here: ${ports.fs.containment.reason}. Nothing in the repository was read or written; run wrkrs on macOS or Linux`,
        { details: { platform: ports.environment.platform } },
      ),
    )
  }
  const located = await locateRepository(cwd, ports)
  if (!located.ok) return err(locateErrorToWrkrsError(located.error))

  const snapshot = await analyzeRepository(
    located.value,
    ports.fs,
    dependencies.analyzeOptions ?? {},
  )
  const state = snapshot.wrkrs

  if (state.directoryKind === null) {
    return err(new WrkrsError('OWNERSHIP_MANIFEST_MISSING', NOT_INSTALLED))
  }
  if (state.directoryKind !== 'directory') {
    return err(
      new WrkrsError(
        'PATH_WRKRS_NOT_A_DIRECTORY',
        `.wrkrs exists but is a ${state.directoryKind}; wrkrs cannot read the installation`,
      ),
    )
  }
  if (state.journal) {
    return err(
      new WrkrsError(
        'OWNERSHIP_TRANSACTION_INTERRUPTED',
        `An interrupted wrkrs transaction (${state.journal.transactionId ?? 'unknown id'}, status ${state.journal.status ?? 'unknown'}) is present; resolve it before changing the installation`,
        { details: { journal: state.journal.path } },
      ),
    )
  }
  if (state.lockPresent) {
    return err(
      new WrkrsError(
        'OWNERSHIP_LOCK_PRESENT',
        'A wrkrs installation lock is present; ensure no other wrkrs process is running, then remove the stale lock file',
      ),
    )
  }
  if (!state.manifest) {
    return err(new WrkrsError('OWNERSHIP_MANIFEST_MISSING', NOT_INSTALLED))
  }
  if (!state.manifest.valid || !state.manifest.manifest) {
    return err(
      new WrkrsError(
        'OWNERSHIP_MANIFEST_INVALID',
        `The ownership manifest is invalid: ${state.manifest.error ?? 'unknown error'}. Restore it from version control before changing the installation`,
        { details: { path: MANIFEST_PATH } },
      ),
    )
  }

  const reader = await createRepositoryReader(located.value.root, ports.fs)
  const configText = await reader.readText(CONFIG_PATH)
  let config: WrkrsConfig | null = null
  let configSourceText: string | null = null
  let configSourceSchemaVersion: number | null = null
  if (!configText.ok || configText.value === null) {
    if (options.requireConfig) {
      return err(
        new WrkrsError(
          'CONFIG_MISSING',
          `${CONFIG_PATH} could not be read; restore it from version control before changing the installation`,
        ),
      )
    }
  } else {
    const parsedConfig = parseConfigDocument(configText.value)
    if (!parsedConfig.ok) {
      if (options.requireConfig) {
        return err(
          new WrkrsError(
            parsedConfig.error.code,
            `${parsedConfig.error.message}; correct it before changing the installation`,
            { details: { path: CONFIG_PATH } },
          ),
        )
      }
    } else {
      config = parsedConfig.value.config
      configSourceText = configText.value
      configSourceSchemaVersion = parsedConfig.value.sourceSchemaVersion
    }
  }

  return ok({
    repository: located.value,
    snapshot,
    config,
    configSourceText,
    configSourceSchemaVersion,
    manifest: state.manifest.manifest,
    manifestMigrated:
      state.manifest.sourceSchemaVersion !== null && state.manifest.sourceSchemaVersion < 2,
  })
}

/**
 * Exact current bytes of every path a lifecycle plan may replace or remove.
 * Content is needed for diffs only; the hashes that gate every mutation come
 * from the target snapshots.
 */
export async function readContents(
  root: string,
  paths: readonly string[],
  ports: InitPorts,
): Promise<ContentIndex> {
  const reader = await createRepositoryReader(root, ports.fs)
  const contents = new Map<string, string>()
  for (const path of [...new Set(paths)].sort()) {
    const text = await reader.readText(path)
    if (text.ok && text.value !== null) contents.set(path, text.value)
  }
  return contents
}

/**
 * The roster an uninstall reports when configuration is already gone: the
 * preset the manifest recorded, with no roles, because nothing is being
 * projected. Uninstall plans from the manifest alone.
 */
export function rosterFromManifest(manifest: OwnershipManifest): RosterRecommendation {
  return {
    presetId: 'product-engineering',
    presetVersion: manifest.preset.version,
    primaryRoleId: 'product-manager',
    roles: [],
    evidence: [],
  }
}

/**
 * Rebuilds the roster from the repository's own configuration. Detection is
 * used only to attach evidence to specializations config already declares: it
 * never adds a role, removes a role, or changes the specialization set.
 */
export function rosterFromConfig(
  preset: RosterPreset,
  config: WrkrsConfig,
  signals: readonly ProjectSignal[],
): Result<RosterRecommendation, WrkrsError> {
  const unknown = config.roster.roles.filter((role) => !isRoleId(role.id))
  if (unknown.length > 0) {
    return err(
      new WrkrsError(
        'CONFIG_ROLE_UNKNOWN',
        `Configuration declares role(s) this wrkrs version does not provide: ${unknown.map((role) => role.id).join(', ')}`,
        { details: { supported: preset.roles.map((role) => role.id).join(', ') } },
      ),
    )
  }
  if (!isRoleId(config.roster.primaryRole)) {
    return err(
      new WrkrsError(
        'CONFIG_PRIMARY_ROLE_UNKNOWN',
        `Configuration names an unknown primary role "${config.roster.primaryRole}"`,
      ),
    )
  }

  const specializationFor = (id: string): Specialization => {
    const rule = preset.specializationRules.find((candidate) => candidate.id === id)
    const evidence = rule
      ? signals
          .filter((signal) => rule.signals.includes(signal.id))
          .map((signal) => ({ signal: signal.id, path: signal.path, detail: signal.detail }))
          .sort((a, b) =>
            a.signal !== b.signal
              ? a.signal < b.signal
                ? -1
                : 1
              : a.path !== b.path
                ? a.path < b.path
                  ? -1
                  : 1
                : a.detail < b.detail
                  ? -1
                  : a.detail > b.detail
                    ? 1
                    : 0,
          )
      : []
    return { id, title: rule?.title ?? id, evidence }
  }

  const roles: RecommendedRole[] = config.roster.roles.map((role) => {
    const presetRole = preset.roles.find((candidate) => candidate.id === role.id)
    return {
      id: role.id as RecommendedRole['id'],
      title: presetRole?.title ?? role.id,
      primary: role.id === config.roster.primaryRole,
      source: role.source,
      reason: presetRole?.reason ?? 'Role declared in .wrkrs/config.yaml',
      specializations: (role.specializations ?? []).map(specializationFor),
    }
  })

  return ok({
    presetId: preset.id,
    presetVersion: config.preset.version,
    primaryRoleId: config.roster.primaryRole,
    roles,
    evidence: roles.flatMap((role) => role.specializations.flatMap((item) => item.evidence)),
  })
}
