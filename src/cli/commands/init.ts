import type { ConnectionMap } from '../../core/configuration.js'
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, WrkrsError } from '../../core/errors.js'
import { isBlocked, mutatingOperations } from '../../core/plan.js'
import { applyPreparedInit, discoverInitQuestions, prepareInit } from '../../init/init.js'
import { parseAnswersBytes } from '../../init/answers.js'
import { connectionsFromAnswers, SKIP_CHOICE_ID, type SetupQuestion } from '../../init/questions.js'
import { ANSWERS_DOCUMENT_MAX_BYTES } from '../../platform/input-document.js'
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
  readonly questions: boolean
  readonly answers?: string | undefined
  readonly expectDigest?: string | undefined
  readonly cwd: string
}

function choiceJson(choice: SetupQuestion['choices'][number]): JsonValue {
  const body: Record<string, JsonValue> = { id: choice.id, kind: choice.kind }
  if (choice.provider) body['provider'] = choice.provider
  if (choice.server) body['server'] = choice.server
  if (choice.executable) body['executable'] = choice.executable
  if (choice.scope) body['scope'] = choice.scope
  if (choice.verification) body['verification'] = choice.verification
  return body
}

/** Thin command handler: orchestrates presentation around the init service. */
export async function runInitCommand(options: InitOptions, context: CliContext): Promise<number> {
  const { services, streams } = context
  const style = context.style
  const machine = options.json || options.questions
  const mode = options.questions ? 'questions' : options.dryRun ? 'dry-run' : 'apply'
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
    if (machine) emitJson({ error: errorToJson(error) })
    else streams.stderr.write(renderError(error, style))
    return error.exitCode
  }

  if (options.expectDigest && !options.answers) {
    return fail(
      new WrkrsError('INIT_USAGE', '--expect-digest requires --answers', { exitCode: EXIT_USAGE }),
    )
  }
  if (options.questions && (options.answers || options.yes)) {
    return fail(
      new WrkrsError('INIT_USAGE', '--questions cannot be combined with --answers or --yes', {
        exitCode: EXIT_USAGE,
      }),
    )
  }

  const deps = {
    wrkrsVersion: services.wrkrsVersion,
    preset: services.preset,
    adapters: services.adapters,
    providers: services.providers,
  }

  if (options.questions) {
    const discovered = await discoverInitQuestions(options.cwd, deps, services.ports)
    if (!discovered.ok) return fail(discovered.error)
    emitJson({
      repositoryRoot: discovered.value.repository.root,
      questionSetDigest: discovered.value.questionSet.questionSetDigest,
      questions: discovered.value.questionSet.questions.map((question) => ({
        id: question.id,
        capability: question.capability,
        prompt: question.prompt,
        default: question.default,
        choices: question.choices.map(choiceJson),
      })),
    })
    return EXIT_OK
  }

  let connections: ConnectionMap = {}
  if (options.answers) {
    const file = await services.inputDocument.read(options.answers, {
      cwd: options.cwd,
      maxBytes: ANSWERS_DOCUMENT_MAX_BYTES,
    })
    if (!file.ok) {
      return fail(new WrkrsError(file.error.code, file.error.message))
    }
    const parsed = parseAnswersBytes(file.value.bytes)
    if (!parsed.ok) return fail(new WrkrsError(parsed.error.code, parsed.error.message))
    const discovered = await discoverInitQuestions(options.cwd, deps, services.ports)
    if (!discovered.ok) return fail(discovered.error)
    if (parsed.value.questionSetDigest !== discovered.value.questionSet.questionSetDigest) {
      return fail(
        new WrkrsError(
          'QUESTION_SET_DIGEST_MISMATCH',
          'Answers questionSetDigest does not match the current question set',
        ),
      )
    }
    const mapped = connectionsFromAnswers(discovered.value.questionSet, parsed.value.answers)
    if (mapped.error === 'unknown question') {
      return fail(
        new WrkrsError('ANSWERS_UNKNOWN_QUESTION', 'Answers contain an unknown question id'),
      )
    }
    if (mapped.error === 'unknown choice') {
      return fail(new WrkrsError('ANSWERS_UNKNOWN_CHOICE', 'Answers contain an unknown choice id'))
    }
    if (mapped.error === 'duplicate answer') {
      return fail(new WrkrsError('ANSWERS_DUPLICATE', 'Answers contain a duplicate question id'))
    }
    connections = mapped.connections
  } else if (!options.yes && !options.json && services.prompt.interactive && !options.questions) {
    const discovered = await discoverInitQuestions(options.cwd, deps, services.ports)
    if (!discovered.ok) return fail(discovered.error)
    const answers: Record<string, string> = {}
    for (const question of discovered.value.questionSet.questions) {
      const selected = await services.prompt.choose(
        question.prompt,
        question.choices.map((choice) => ({ id: choice.id, label: choice.id })),
        SKIP_CHOICE_ID,
      )
      if (selected === null) {
        streams.stdout.write('Cancelled; nothing was written.\n')
        return EXIT_OK
      }
      answers[question.id] = selected
    }
    connections = connectionsFromAnswers(discovered.value.questionSet, answers).connections
  }

  const prepared = await prepareInit(options.cwd, deps, services.ports, { connections })
  if (!prepared.ok) return fail(prepared.error)

  const { plan, repository } = prepared.value
  if (options.expectDigest && plan.digest !== options.expectDigest) {
    return fail(
      new WrkrsError('PLAN_DIGEST_MISMATCH', 'The plan digest does not match --expect-digest'),
    )
  }

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

  const result = await applyPreparedInit(prepared.value, deps, services.ports)
  if (options.json) {
    emitJson({ repositoryRoot: repository.root, plan: planJson, result: applyResultToJson(result) })
  } else {
    streams.stdout.write(renderApplyResult(result, style, { command: 'init' }))
  }
  return result.status === 'applied' ? EXIT_OK : EXIT_ERROR
}
