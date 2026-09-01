import { EXIT_ERROR, EXIT_OK, WrkrsError } from '../../core/errors.js'
import { isBlocked, mutatingOperations } from '../../core/plan.js'
import { applyPreparedInit, prepareInit } from '../../init/init.js'
import { renderApplyResult, renderError, renderPlan } from '../output/human-reporter.js'
import {
  applyResultToJson,
  errorToJson,
  planToJson,
  renderJson,
  type JsonValue,
} from '../output/json-reporter.js'
import type { CliContext } from '../context.js'

export interface InitOptions {
  readonly dryRun: boolean
  readonly yes: boolean
  readonly json: boolean
  readonly cwd: string
}

/** Thin command handler: orchestrates presentation around the init service. */
export async function runInitCommand(options: InitOptions, context: CliContext): Promise<number> {
  const { services, streams } = context
  const style = context.style
  const mode = options.dryRun ? 'dry-run' : 'apply'
  const emitJson = (body: Record<string, JsonValue>) => {
    streams.stdout.write(
      renderJson({
        schemaVersion: 1,
        command: 'init',
        wrkrsVersion: services.wrkrsVersion,
        mode,
        ...body,
      }),
    )
  }
  const fail = (error: WrkrsError): number => {
    if (options.json) emitJson({ error: errorToJson(error) })
    else streams.stderr.write(renderError(error, style))
    return error.exitCode
  }

  const prepared = await prepareInit(
    options.cwd,
    {
      wrkrsVersion: services.wrkrsVersion,
      preset: services.preset,
      adapters: services.adapters,
      providers: services.providers,
    },
    services.ports,
  )
  if (!prepared.ok) return fail(prepared.error)

  const { plan, repository } = prepared.value
  const blocked = isBlocked(plan)
  const mutations = mutatingOperations(plan)
  const planJson = planToJson(plan)

  if (options.dryRun) {
    if (options.json) {
      emitJson({
        repositoryRoot: repository.root,
        plan: planJson,
        result: { status: blocked ? 'blocked' : 'planned' },
      })
    } else {
      streams.stdout.write(renderPlan(plan, style, { dryRun: true }))
      streams.stdout.write(
        blocked
          ? style.red('Dry run: the plan is blocked; nothing would be written.\n')
          : 'Dry run: nothing was written.\n',
      )
    }
    return blocked ? EXIT_ERROR : EXIT_OK
  }

  if (!options.json) streams.stdout.write(renderPlan(plan, style, { dryRun: false }))

  if (blocked) {
    if (options.json)
      emitJson({ repositoryRoot: repository.root, plan: planJson, result: { status: 'blocked' } })
    else
      streams.stderr.write(
        style.red(
          `Blocked: ${plan.blockers.length} conflict(s) prevent installation; nothing was written.\n`,
        ),
      )
    return EXIT_ERROR
  }

  if (mutations.length === 0) {
    if (options.json)
      emitJson({ repositoryRoot: repository.root, plan: planJson, result: { status: 'no-op' } })
    else
      streams.stdout.write(
        'wrkrs is already installed and unchanged; nothing to do. Use `wrkrs update` to change an installation.\n',
      )
    return EXIT_OK
  }

  if (!options.yes) {
    if (options.json || !services.prompt.interactive) {
      return fail(
        new WrkrsError(
          'INIT_CONFIRMATION_REQUIRED',
          options.json
            ? 'Applying with --json requires --yes; nothing was written'
            : 'Confirmation is required to apply and stdin is not interactive; re-run with --yes or in a terminal. Nothing was written',
        ),
      )
    }
    const confirmed = await services.prompt.confirm(
      `Create ${mutations.length} file(s) in ${repository.root}? (plan ${plan.digest.slice(0, 19)}…)`,
    )
    if (!confirmed) {
      streams.stdout.write('Cancelled; nothing was written.\n')
      return EXIT_OK
    }
  }

  const result = await applyPreparedInit(
    prepared.value,
    {
      wrkrsVersion: services.wrkrsVersion,
      preset: services.preset,
      adapters: services.adapters,
      providers: services.providers,
    },
    services.ports,
  )
  if (options.json) {
    emitJson({ repositoryRoot: repository.root, plan: planJson, result: applyResultToJson(result) })
  } else {
    streams.stdout.write(renderApplyResult(result, style, { command: 'init' }))
  }
  return result.status === 'applied' ? EXIT_OK : EXIT_ERROR
}
