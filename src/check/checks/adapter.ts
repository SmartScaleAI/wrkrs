import { createDiagnostic, type Diagnostic } from '../../core/diagnostics.js'
import type { CheckContext } from '../context.js'

export async function checkAdapter(context: CheckContext): Promise<Diagnostic[]> {
  const config = context.config
  if (!config) return []
  const adapter = context.adapters.get(config.runtime.primary)
  if (!adapter) return []
  const diagnostics = [
    ...(await adapter.validate({
      root: context.root,
      fs: context.fs,
      config,
      manifest: context.manifest,
    })),
  ]
  if (
    context.manifest &&
    !context.manifest.runtimeAdapters.some((entry) => entry.id === adapter.id)
  ) {
    diagnostics.push(
      createDiagnostic(
        'MANIFEST_ADAPTER_NOT_RECORDED',
        'warning',
        `The configured runtime "${adapter.id}" is not recorded in the manifest`,
        {
          remediation: 'A future `wrkrs update` can record it',
        },
      ),
    )
  }
  return diagnostics
}
