import type { RuntimeAdapter } from '../../core/runtime-adapter.js'
import { analyzeClaudeCodeSnapshot } from './analyze.js'
import { compileClaudeCodeComponents } from './compile.js'
import { ADAPTER_ID, ADAPTER_VERSION } from './layout.js'
import { validateClaudeCodeInstallation } from './validate.js'

/** The first fully supported runtime adapter. */
export function createClaudeCodeAdapter(): RuntimeAdapter {
  return {
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    analyze: analyzeClaudeCodeSnapshot,
    compile: compileClaudeCodeComponents,
    validate: validateClaudeCodeInstallation,
  }
}
