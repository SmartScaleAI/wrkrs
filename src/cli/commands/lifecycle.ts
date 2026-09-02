import { EXIT_ERROR, EXIT_OK, WrkrsError } from '../../core/errors.js'
import { isBlocked, mutatingOperations, type InstallPlan } from '../../core/plan.js'
import type { Result } from '../../core/result.js'
import type { InitDependencies, InitPorts } from '../../init/init.js'
import { applyPreparedUninstall, prepareUninstall } from '../../lifecycle/uninstall.js'
import { applyPreparedUpdate, prepareUpdate } from '../../lifecycle/update.js'
import type { ApplyResult } from '../../writer/transaction.js'
import type { CliContext } from '../context.js'
import { renderApplyResult, renderError, renderPlan } from '../output/human-reporter.js'
import {
  applyResultToJson,
  errorToJson,
  planToJson,
  renderJson,
  type JsonValue,
} from '../output/json-reporter.js'

export interface LifecycleOptions {
  readonly dryRun: boolean
  readonly yes: boolean
  readonly json: boolean
  readonly cwd: string
}

interface Prepared {
  readonly plan: InstallPlan
  readonly repositoryRoot: string
  apply(): Promise<ApplyResult>
}

interface CommandShape {
  readonly command: 'update' | 'uninstall'
  /** Sentence case noun used in failure headlines, e.g. "Update failed…". */
  readonly verb: string
  readonly nothingToDo: string
  confirmation(prepared: Prepared): string
  prepare(
    cwd: string,
    dependencies: InitDependencies,
    ports: InitPorts,
  ): Promise<Result<Prepared, WrkrsError>>
}

/**
 * Shared presentation for the lifecycle commands. Identical in shape to init:
 * plan, show, confirm, apply, report — the differences are which service
 * builds the plan and what the messages say.
 */
async function runLifecycle(
  shape: CommandShape,
  options: LifecycleOptions,
  context: CliContext,
): Promise<number> {
  const { services, streams, style } = context
  const mode = options.dryRun ? 'dry-run' : 'apply'
  const dependencies: InitDependencies = {
    wrkrsVersion: services.wrkrsVersion,
    preset: services.preset,
    adapters: services.adapters,
    providers: services.providers,
  }
  const emitJson = (body: Record<string, JsonValue>): void => {
    streams.stdout.write(
      renderJson({
        schemaVersion: 1,
        command: shape.command,
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

  const prepared = await shape.prepare(options.cwd, dependencies, services.ports)
  if (!prepared.ok) return fail(prepared.error)

  const { plan, repositoryRoot } = prepared.value
  const blocked = isBlocked(plan)
  const mutations = mutatingOperations(plan)
  const planJson = planToJson(plan)

  if (options.dryRun) {
    if (options.json) {
      emitJson({
        repositoryRoot,
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
    if (options.json) emitJson({ repositoryRoot, plan: planJson, result: { status: 'blocked' } })
    else
      streams.stderr.write(
        style.red(
          `Blocked: ${plan.blockers.length} conflict(s) prevent this change; nothing was written.\n`,
        ),
      )
    return EXIT_ERROR
  }

  if (mutations.length === 0 && plan.removedDirectories.length === 0) {
    if (options.json) emitJson({ repositoryRoot, plan: planJson, result: { status: 'no-op' } })
    else streams.stdout.write(shape.nothingToDo)
    return EXIT_OK
  }

  if (!options.yes) {
    if (options.json || !services.prompt.interactive) {
      return fail(
        new WrkrsError(
          shape.command === 'update'
            ? 'UPDATE_CONFIRMATION_REQUIRED'
            : 'UNINSTALL_CONFIRMATION_REQUIRED',
          options.json
            ? 'Applying with --json requires --yes; nothing was written'
            : 'Confirmation is required to apply and stdin is not interactive; re-run with --yes or in a terminal. Nothing was written',
        ),
      )
    }
    const confirmed = await services.prompt.confirm(shape.confirmation(prepared.value))
    if (!confirmed) {
      streams.stdout.write('Cancelled; nothing was written.\n')
      return EXIT_OK
    }
  }

  const result = await prepared.value.apply()
  if (options.json) {
    emitJson({ repositoryRoot, plan: planJson, result: applyResultToJson(result) })
  } else {
    streams.stdout.write(
      renderApplyResult(result, style, { command: shape.command, verb: shape.verb }),
    )
  }
  return result.status === 'applied' ? EXIT_OK : EXIT_ERROR
}

export function runUpdateCommand(options: LifecycleOptions, context: CliContext): Promise<number> {
  return runLifecycle(
    {
      command: 'update',
      verb: 'Update',
      nothingToDo: 'The wrkrs installation is already current; nothing to do.\n',
      confirmation: (prepared) => {
        const counts = countChanges(prepared.plan)
        return `Apply ${counts} in ${prepared.repositoryRoot}? (plan ${prepared.plan.digest.slice(0, 19)}…)`
      },
      prepare: async (cwd, dependencies, ports) => {
        const result = await prepareUpdate(cwd, dependencies, ports)
        if (!result.ok) return result
        return {
          ok: true,
          value: {
            plan: result.value.plan,
            repositoryRoot: result.value.installation.repository.root,
            apply: () => applyPreparedUpdate(result.value, dependencies, ports),
          },
        }
      },
    },
    options,
    context,
  )
}

export function runUninstallCommand(
  options: LifecycleOptions,
  context: CliContext,
): Promise<number> {
  return runLifecycle(
    {
      command: 'uninstall',
      verb: 'Uninstall',
      nothingToDo: 'Nothing owned by wrkrs remains to remove.\n',
      confirmation: (prepared) => {
        const counts = countChanges(prepared.plan)
        return `Remove ${counts} from ${prepared.repositoryRoot}? (plan ${prepared.plan.digest.slice(0, 19)}…)`
      },
      prepare: async (cwd, dependencies, ports) => {
        const result = await prepareUninstall(cwd, dependencies, ports)
        if (!result.ok) return result
        return {
          ok: true,
          value: {
            plan: result.value.plan,
            repositoryRoot: result.value.installation.repository.root,
            apply: () => applyPreparedUninstall(result.value, dependencies, ports),
          },
        }
      },
    },
    options,
    context,
  )
}

function countChanges(plan: InstallPlan): string {
  const parts: string[] = []
  const count = (outcome: string): number =>
    plan.operations.filter((operation) => operation.outcome === outcome).length
  const created = count('create')
  const replaced = count('replace')
  const removed = count('remove')
  if (created > 0) parts.push(`${created} new file(s)`)
  if (replaced > 0) parts.push(`${replaced} changed file(s)`)
  if (removed > 0) parts.push(`${removed} removed file(s)`)
  if (plan.removedDirectories.length > 0) {
    parts.push(`${plan.removedDirectories.length} directory(ies)`)
  }
  return parts.length === 0 ? 'no changes' : parts.join(', ')
}
