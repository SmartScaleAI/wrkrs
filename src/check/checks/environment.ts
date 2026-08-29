import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import type { EnvironmentPort, FileSystemPort } from '../../core/ports.js'
import { MINIMUM_NODE_VERSION, satisfiesMinimumVersion } from '../../core/versions.js'
import { findExecutable } from '../../platform/environment.js'
import type { GitPort } from '../../platform/git.js'

export async function checkEnvironment(ports: {
  environment: EnvironmentPort
  fs: FileSystemPort
  git: GitPort
}): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const nodeVersion = ports.environment.nodeVersion
  if (satisfiesMinimumVersion(nodeVersion, MINIMUM_NODE_VERSION)) {
    diagnostics.push(
      createDiagnostic(
        'ENV_NODE_VERSION_OK',
        'info',
        `Node.js ${nodeVersion} satisfies the minimum ${MINIMUM_NODE_VERSION}`,
        {
          details: { nodeVersion },
        },
      ),
    )
  } else {
    diagnostics.push(
      createDiagnostic(
        'ENV_NODE_VERSION_UNSUPPORTED',
        'error',
        `Node.js ${nodeVersion} is below the minimum ${MINIMUM_NODE_VERSION}`,
        {
          remediation: `Install Node.js ${MINIMUM_NODE_VERSION} or newer`,
          details: { nodeVersion, minimum: MINIMUM_NODE_VERSION },
        },
      ),
    )
  }

  const git = await ports.git.version()
  if (git.ok) {
    diagnostics.push(createDiagnostic('ENV_GIT_OK', 'info', git.value))
  } else {
    diagnostics.push(
      createDiagnostic('ENV_GIT_MISSING', 'error', git.error.message, {
        remediation: 'Install Git and ensure it is on PATH',
      }),
    )
  }

  const claude = await findExecutable('claude', ports.environment, ports.fs)
  if (claude) {
    diagnostics.push(
      createDiagnostic(
        'ENV_CLAUDE_EXECUTABLE_FOUND',
        'info',
        'A local Claude Code executable is available',
      ),
    )
  } else {
    diagnostics.push(
      createDiagnostic(
        'ENV_CLAUDE_EXECUTABLE_MISSING',
        'warning',
        'No local Claude Code executable was found on PATH; the repository configuration still works in Claude Code cloud sessions',
        {
          remediation: 'Install Claude Code locally if you want to run workers from this machine',
        },
      ),
    )
  }
  return diagnostics
}
