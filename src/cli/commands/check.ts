import { runCheck } from '../../check/check.js'
import { EXIT_ERROR, EXIT_OK } from '../../core/errors.js'
import { renderCheck } from '../output/human-reporter.js'
import { checkToJson, renderJson } from '../output/json-reporter.js'
import type { CliContext } from '../context.js'

export interface CheckOptions {
  readonly json: boolean
  readonly cwd: string
}

export async function runCheckCommand(options: CheckOptions, context: CliContext): Promise<number> {
  const { services, streams } = context
  const report = await runCheck(
    {
      cwd: options.cwd,
      wrkrsVersion: services.wrkrsVersion,
      adapters: services.adapters,
      providers: services.providers,
    },
    services.ports,
  )
  if (options.json) {
    streams.stdout.write(renderJson(checkToJson(report, services.wrkrsVersion)))
  } else {
    streams.stdout.write(renderCheck(report, context.style, services.wrkrsVersion))
  }
  return report.ok ? EXIT_OK : EXIT_ERROR
}
