import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { createStyler, renderCheck, renderPlan } from '../../../src/cli/output/human-reporter.js'
import { checkToJson, planToJson } from '../../../src/cli/output/json-reporter.js'
import { runCli } from '../../../src/cli/program.js'
import { createNonInteractivePrompt } from '../../../src/cli/prompt.js'
import { createNodeInputDocument } from '../../../src/platform/input-document.js'
import {
  parseConfigDocument,
  parseJournalDocument,
  parseManifestDocument,
} from '../../../src/config/load.js'
import { prepareInit } from '../../../src/init/init.js'
import { createGit } from '../../../src/platform/git.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { createFixtureRepository, FIXTURES_ROOT, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const MALFORMED = path.join(FIXTURES_ROOT, 'malformed-documents')
const SENTINELS = [
  'ZQX_CONF_A',
  'ZQX_CONF_B',
  'ZQX_CONF_C',
  'ZQX_MANI_A',
  'ZQX_MANI_B',
  'ZQX_JOUR_A',
  'ZQX_JOUR_B',
  'ZQX_JOUR_C',
]
const style = createStyler(false)

function expectRedacted(text: string): void {
  for (const sentinel of SENTINELS) {
    expect(text).not.toContain(sentinel)
    expect(text).not.toContain(sentinel.slice(0, 6))
  }
  expect(text).not.toContain('ZQX')
}

function read(name: string): string {
  return readFileSync(path.join(MALFORMED, name), 'utf8')
}

describe('parser diagnostics are sanitized', () => {
  it('config, manifest, and journal parse errors carry only controlled text and positions', () => {
    const config = parseConfigDocument(read('config.yaml'))
    expect(config.ok).toBe(false)
    if (!config.ok) {
      expect(config.error.code).toBe('CONFIG_PARSE_ERROR')
      expect(config.error.issues.length).toBeGreaterThan(0)
      for (const issue of config.error.issues) {
        expect(issue.code.startsWith('YAML_')).toBe(true)
        expect(issue.location === null || /^line \d+(, column \d+)?$/.test(issue.location)).toBe(
          true,
        )
      }
      expectRedacted(JSON.stringify(config.error))
    }
    const manifest = parseManifestDocument(read('manifest.json'))
    expect(manifest.ok).toBe(false)
    if (!manifest.ok) {
      expect(manifest.error.code).toBe('MANIFEST_PARSE_ERROR')
      expect(manifest.error.issues[0]?.code).toBe('JSON_SYNTAX_ERROR')
      expectRedacted(JSON.stringify(manifest.error))
    }
    const journal = parseJournalDocument(read('journal.json'))
    expect(journal.ok).toBe(false)
    if (!journal.ok) {
      expect(journal.error.code).toBe('JOURNAL_PARSE_ERROR')
      expectRedacted(JSON.stringify(journal.error))
    }
  })

  it('schema violations do not echo unrecognized keys or untrusted values', () => {
    const config = parseConfigDocument('schemaVersion: 1\nZQX_CONF_A: ZQX_CONF_B\n')
    expect(config.ok).toBe(false)
    if (!config.ok) {
      expect(config.error.code).toBe('CONFIG_INVALID')
      expectRedacted(JSON.stringify(config.error))
    }
    const manifest = parseManifestDocument('{"schemaVersion": 1, "installationId": "ZQX_MANI_A"}')
    expect(manifest.ok).toBe(false)
    if (!manifest.ok) expectRedacted(JSON.stringify(manifest.error))
  })

  it('check, dry-run findings and blockers, and their human and JSON renderings stay redacted', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    mkdirSync(path.join(root, '.wrkrs'))
    writeFileSync(path.join(root, '.wrkrs', 'config.yaml'), read('config.yaml'))
    writeFileSync(path.join(root, '.wrkrs', 'manifest.json'), read('manifest.json'))
    writeFileSync(path.join(root, '.wrkrs', '.journal.json'), read('journal.json'))
    const deps = createTestDependencies()
    const ports = createTestPorts()

    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    expect(report.ok).toBe(false)
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code)
    expect(codes).toEqual(
      expect.arrayContaining([
        'CONFIG_PARSE_ERROR',
        'MANIFEST_PARSE_ERROR',
        'TRANSACTION_JOURNAL_UNREADABLE',
      ]),
    )
    expectRedacted(renderCheck(report, style, deps.wrkrsVersion))
    expectRedacted(JSON.stringify(checkToJson(report, deps.wrkrsVersion)))

    const prepared = await prepareInit(root, deps, ports)
    if (!prepared.ok) throw prepared.error
    const plan = prepared.value.plan
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['OWNERSHIP_MANIFEST_INVALID', 'OWNERSHIP_TRANSACTION_INTERRUPTED']),
    )
    expect(plan.findings.map((finding) => finding.code)).toContain('WRKRS_CONFIG_INVALID')
    expectRedacted(renderPlan(plan, style, { dryRun: true }))
    expectRedacted(JSON.stringify(planToJson(plan)))
  })

  it('unexpected errors never echo their message on the CLI', async () => {
    let stderr = ''
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        stderr += String(chunk)
        callback()
      },
    })
    const deps = createTestDependencies()
    const git = createGit({
      run: async () => ({
        started: true,
        exitCode: 0,
        stdout: 'git version 2',
        stderr: '',
        errorCode: null,
      }),
    })
    const throwing = {
      ...git,
      resolveWorktree: async () => {
        throw new SyntaxError('Unexpected token ZQX_CONF_A in JSON at position 3')
      },
    }
    const code = await runCli(['check', '--cwd', process.cwd()], {
      services: {
        wrkrsVersion: deps.wrkrsVersion,
        ports: { ...createTestPorts(), git: throwing },
        prompt: createNonInteractivePrompt(),
        inputDocument: createNodeInputDocument(),
        preset: deps.preset,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      streams: { stdout: sink, stderr: sink },
      colors: false,
      defaultCwd: process.cwd(),
    })
    expect(code).toBe(1)
    expect(stderr).toContain('UNEXPECTED: SyntaxError')
    expectRedacted(stderr)
  })
})
