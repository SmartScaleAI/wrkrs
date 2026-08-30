import { Command, CommanderError } from 'commander'

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, isWrkrsError } from '../core/errors.js'
import { runCheckCommand } from './commands/check.js'
import { runInitCommand } from './commands/init.js'
import type { CliContext, CliServices, CliStreams } from './context.js'
import { createStyler } from './output/human-reporter.js'

export interface RunCliOptions {
  readonly services: CliServices
  readonly streams: CliStreams
  readonly colors: boolean
  readonly defaultCwd: string
}

function buildProgram(options: RunCliOptions, exit: { code: number }): Command {
  const program = new Command()
  program
    .name('wrkrs')
    .description('Install a configurable AI development team into an existing Git repository.')
    .version(options.services.wrkrsVersion, '-V, --version', 'print the wrkrs version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => options.streams.stdout.write(text),
      writeErr: (text) => options.streams.stderr.write(text),
    })

  const context = (json: boolean): CliContext => ({
    services: options.services,
    streams: options.streams,
    style: createStyler(options.colors && !json),
  })

  program
    .command('init')
    .description(
      'Analyze the repository, show the exact installation plan, and install the roster after confirmation.',
    )
    .option('--dry-run', 'show the plan and diffs without writing anything', false)
    .option('-y, --yes', 'apply without an interactive confirmation', false)
    .option('--json', 'emit the semantic plan and result as JSON (no terminal styling)', false)
    .option('--cwd <directory>', 'directory inside the target Git worktree', options.defaultCwd)
    .action(async (flags: { dryRun: boolean; yes: boolean; json: boolean; cwd: string }) => {
      exit.code = await runInitCommand(
        { dryRun: flags.dryRun, yes: flags.yes, json: flags.json, cwd: flags.cwd },
        context(flags.json),
      )
    })

  program
    .command('check')
    .description(
      'Validate the environment, configuration, ownership manifest, drift, and Claude Code adapter (read-only).',
    )
    .option('--json', 'emit diagnostics as JSON (no terminal styling)', false)
    .option('--cwd <directory>', 'directory inside the target Git worktree', options.defaultCwd)
    .action(async (flags: { json: boolean; cwd: string }) => {
      exit.code = await runCheckCommand({ json: flags.json, cwd: flags.cwd }, context(flags.json))
    })

  return program
}

/** Runs the CLI and returns the process exit code. Never calls process.exit. */
export async function runCli(argv: readonly string[], options: RunCliOptions): Promise<number> {
  const exit = { code: EXIT_OK }
  const program = buildProgram(options, exit)
  try {
    await program.parseAsync([...argv], { from: 'user' })
    return exit.code
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      ) {
        return EXIT_OK
      }
      return EXIT_USAGE
    }
    if (isWrkrsError(error)) {
      options.streams.stderr.write(`error ${error.code}: ${error.message}\n`)
      return error.exitCode
    }
    // Unexpected errors never echo their message: a parser or filesystem error
    // could carry excerpts of repository content. Only the error class and the
    // code frames (no message line) are shown, and frames only on request.
    const name = error instanceof Error ? error.name : typeof error
    const frames =
      error instanceof Error && process.env['WRKRS_DEBUG'] && error.stack
        ? error.stack
            .split('\n')
            .filter((line) => /^\s+at /.test(line))
            .join('\n')
        : ''
    options.streams.stderr.write(
      `error UNEXPECTED: ${name} (message withheld; set WRKRS_DEBUG=1 for stack frames)\n${frames ? frames + '\n' : ''}`,
    )
    return EXIT_ERROR
  }
}
