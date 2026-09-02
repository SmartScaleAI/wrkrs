import type { RuntimeAdapterRegistry } from '../adapters/registry.js'
import {
  sortDiagnostics,
  summarizeDiagnostics,
  type Diagnostic,
  type DiagnosticSummary,
  createDiagnostic,
} from '../core/diagnostics.js'
import type { EnvironmentPort, FileSystemPort } from '../core/ports.js'
import type { ProviderRegistry } from '../core/provider.js'
import { createRepositoryReader } from '../platform/contained-path.js'
import type { GitPort } from '../platform/git.js'
import { locateRepository, type LocateError } from '../repository/locate.js'
import { checkAdapter } from './checks/adapter.js'
import { checkConfig } from './checks/config.js'
import { checkConnections } from './checks/connections.js'
import { checkEnvironment } from './checks/environment.js'
import { checkManifest } from './checks/manifest.js'
import { checkOwnership } from './checks/ownership.js'
import { checkTransaction } from './checks/transaction.js'
import type { CheckContext } from './context.js'

export interface CheckPorts {
  readonly fs: FileSystemPort
  readonly git: GitPort
  readonly environment: EnvironmentPort
}

export interface CheckInput {
  readonly cwd: string
  readonly wrkrsVersion: string
  readonly adapters: RuntimeAdapterRegistry
  readonly providers: ProviderRegistry
  /** When set, the journal and lock of this transaction are not reported. */
  readonly activeTransactionId?: string
}

export interface CheckReport {
  readonly repositoryRoot: string | null
  readonly diagnostics: readonly Diagnostic[]
  readonly summary: DiagnosticSummary
  readonly ok: boolean
}

function repositoryDiagnostic(error: LocateError): Diagnostic {
  const remediation = 'Run wrkrs from inside a non-bare Git worktree, or pass --cwd <directory>'
  switch (error.code) {
    case 'GIT_NOT_FOUND':
      return createDiagnostic('ENV_GIT_MISSING', 'error', error.message, {
        remediation: 'Install Git and ensure it is on PATH',
      })
    case 'GIT_NOT_A_REPOSITORY':
      return createDiagnostic('REPOSITORY_NOT_A_GIT_REPOSITORY', 'error', error.message, {
        remediation,
      })
    case 'GIT_BARE_REPOSITORY':
      return createDiagnostic('REPOSITORY_BARE', 'error', error.message, { remediation })
    case 'GIT_NOT_IN_WORKTREE':
      return createDiagnostic('REPOSITORY_NOT_IN_WORKTREE', 'error', error.message, { remediation })
    case 'CWD_NOT_FOUND':
    case 'CWD_NOT_A_DIRECTORY':
      return createDiagnostic('REPOSITORY_CWD_INVALID', 'error', error.message, { remediation })
    default:
      return createDiagnostic('REPOSITORY_GIT_FAILED', 'error', error.message, { remediation })
  }
}

/**
 * Read-only installation health check. Composes independent validations and
 * never writes, repairs, or contacts the network.
 */
export async function runCheck(input: CheckInput, ports: CheckPorts): Promise<CheckReport> {
  const diagnostics: Diagnostic[] = []
  diagnostics.push(...(await checkEnvironment(ports)))

  const located = await locateRepository(input.cwd, ports)
  if (!located.ok) {
    diagnostics.push(repositoryDiagnostic(located.error))
    return finish(null, diagnostics)
  }
  diagnostics.push(
    createDiagnostic('REPOSITORY_OK', 'info', `Git worktree root: ${located.value.root}`, {
      details: { dirty: located.value.dirty },
    }),
  )

  if (!ports.fs.containment.supported) {
    // Environment and worktree detection are complete; repository content is never read here.
    diagnostics.push(
      createDiagnostic(
        'ENVIRONMENT_CONTAINMENT_UNSUPPORTED',
        'error',
        `Strict repository containment is not available here: ${ports.fs.containment.reason}`,
        {
          remediation:
            'Run wrkrs check on macOS or Linux; configuration, manifest, and adapter files were not read',
          details: { platform: ports.environment.platform },
        },
      ),
    )
    return finish(located.value.root, diagnostics)
  }

  const context: CheckContext = {
    root: located.value.root,
    fs: ports.fs,
    reader: await createRepositoryReader(located.value.root, ports.fs),
    environment: ports.environment,
    adapters: input.adapters,
    providers: input.providers,
    wrkrsVersion: input.wrkrsVersion,
    activeTransactionId: input.activeTransactionId ?? null,
    config: null,
    configSchemaVersion: null,
    manifest: null,
    manifestSchemaVersion: null,
  }

  // The manifest is read first: its state decides how a missing
  // configuration is judged, because a partial uninstall removes config.yaml
  // deliberately.
  diagnostics.push(...(await checkManifest(context)))
  diagnostics.push(...(await checkConfig(context)))
  diagnostics.push(...(await checkConnections(context)))
  diagnostics.push(...(await checkOwnership(context)))
  diagnostics.push(...(await checkTransaction(context)))
  diagnostics.push(...(await checkAdapter(context)))
  return finish(context.root, diagnostics)
}

function finish(root: string | null, diagnostics: readonly Diagnostic[]): CheckReport {
  const sorted = sortDiagnostics(diagnostics)
  const summary = summarizeDiagnostics(sorted)
  return { repositoryRoot: root, diagnostics: sorted, summary, ok: summary.errors === 0 }
}
