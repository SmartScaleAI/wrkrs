// Proves Windows fail-closed behavior: help and version work, init never
// locates or writes a repository because containment is unsupported.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('skip: windows fail-closed check is for win32 only')
  process.exit(0)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'dist', 'cli', 'index.js')
const work = mkdtempSync(path.join(tmpdir(), 'wrkrs-win-'))

function run(args) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [cli, ...args], {
        cwd: work,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    }
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

try {
  execFileSync('git', ['init', '-q'], { cwd: work })
  writeFileSync(path.join(work, 'README.md'), 'fixture\n')
  const help = run(['--help'])
  if (help.code !== 0) throw new Error(`--help failed: ${help.stderr}`)
  const version = run(['--version'])
  if (version.code !== 0) throw new Error(`--version failed: ${version.stderr}`)
  const init = run(['init', '--json', '--dry-run'])
  if (init.code === 0) {
    throw new Error('init --dry-run must fail closed on Windows')
  }
  const text = `${init.stdout}${init.stderr}`
  if (!text.includes('ENVIRONMENT_CONTAINMENT_UNSUPPORTED')) {
    throw new Error(`expected ENVIRONMENT_CONTAINMENT_UNSUPPORTED, got: ${text}`)
  }
  console.log('ok   windows fail-closed')
} finally {
  rmSync(work, { recursive: true, force: true })
}
