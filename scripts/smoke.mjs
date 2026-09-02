// Packs the npm tarball, installs it into an isolated consumer project, and
// runs the compiled CLI against a temporary Git repository.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'wrkrs-smoke-'))
const failures = []

function step(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function runCli(bin, args, cwd) {
  try {
    return { code: 0, stdout: run(process.execPath, [bin, ...args], { cwd }) }
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

try {
  const packDir = path.join(work, 'pack')
  mkdirSync(packDir)
  const packOutput = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: root }),
  )
  const tarball = path.join(packDir, packOutput[0].filename)
  const files = packOutput[0].files.map((file) => file.path)

  step('tarball contains compiled JavaScript, templates, schema, license, and bin', () => {
    const required = [
      'dist/cli/index.js',
      'dist/presets/product-engineering/roles/product-manager.md',
      'dist/adapters/claude-code/templates/agents/agent.md',
      'dist/adapters/claude-code/templates/skills/SKILL.md',
      'schema/wrkrs-config.schema.json',
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
      'package.json',
    ]
    for (const file of required) {
      if (!files.includes(file)) throw new Error(`missing ${file}`)
    }
    if (files.some((file) => file.startsWith('src/') || file.startsWith('test/'))) {
      throw new Error('tarball contains source or test files')
    }
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (Object.keys(pkg.bin).join(',') !== 'wrkrs') throw new Error('expected a single wrkrs bin')
  })

  const consumer = path.join(work, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true }, null, 2),
  )
  run('npm', ['install', tarball, '--no-audit', '--no-fund', '--silent'], { cwd: consumer })
  const bin = path.join(consumer, 'node_modules', 'wrkrs', 'dist', 'cli', 'index.js')

  const target = path.join(work, 'target')
  cpSync(path.join(root, 'test', 'fixtures', 'clean-repository'), target, { recursive: true })
  run('git', ['init', '-q', '-b', 'main'], { cwd: target })

  step('wrkrs --help', () => {
    const result = runCli(bin, ['--help'], target)
    if (result.code !== 0 || !result.stdout.includes('init')) throw new Error(`exit ${result.code}`)
  })
  step('wrkrs init --dry-run', () => {
    const result = runCli(bin, ['init', '--dry-run'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr}`)
    if (existsSync(path.join(target, '.wrkrs'))) throw new Error('dry run created .wrkrs')
    if (!result.stdout.includes('Plan digest: sha256:')) throw new Error('no plan digest')
  })
  step('wrkrs init --yes', () => {
    const result = runCli(bin, ['init', '--yes'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr}`)
    for (const file of ['.wrkrs/manifest.json', '.claude/skills/wrkrs/SKILL.md']) {
      if (!existsSync(path.join(target, file))) throw new Error(`missing ${file}`)
    }
  })
  step('wrkrs check', () => {
    const result = runCli(bin, ['check'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stdout}${result.stderr}`)
  })
  step('wrkrs update --dry-run', () => {
    const before = readFileSync(path.join(target, '.wrkrs', 'manifest.json'), 'utf8')
    const result = runCli(bin, ['update', '--dry-run'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr}`)
    if (!result.stdout.includes('Plan digest: sha256:')) throw new Error('no plan digest')
    if (readFileSync(path.join(target, '.wrkrs', 'manifest.json'), 'utf8') !== before) {
      throw new Error('dry run changed the manifest')
    }
  })
  step('wrkrs update --yes applies a configuration edit', () => {
    const configPath = path.join(target, '.wrkrs', 'config.yaml')
    const config = readFileSync(configPath, 'utf8')
    if (!config.includes('        - typescript\n')) throw new Error('unexpected config shape')
    writeFileSync(
      configPath,
      config.replace('        - typescript\n', '        - typescript\n        - rust\n'),
    )
    const result = runCli(bin, ['update', '--yes'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr}`)
    const agent = readFileSync(
      path.join(target, '.claude', 'agents', 'wrkrs-software-engineer.md'),
      'utf8',
    )
    if (!agent.includes('rust')) throw new Error('the projection was not updated')
    const check = runCli(bin, ['check'], target)
    if (check.code !== 0) throw new Error(`check failed after update: ${check.stdout}`)
  })
  step('wrkrs uninstall --dry-run', () => {
    const result = runCli(bin, ['uninstall', '--dry-run'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr}`)
    if (!existsSync(path.join(target, '.wrkrs', 'manifest.json'))) {
      throw new Error('dry run removed the manifest')
    }
  })
  step('npx wrkrs check --json from the consumer', () => {
    const output = run('npx', ['wrkrs', 'check', '--json', '--cwd', target], { cwd: consumer })
    const parsed = JSON.parse(output)
    if (parsed.ok !== true) throw new Error('check reported failure')
  })
  step('wrkrs uninstall --yes leaves nothing wrkrs installed', () => {
    const result = runCli(bin, ['uninstall', '--yes'], target)
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr}`)
    for (const directory of ['.wrkrs', '.claude']) {
      if (existsSync(path.join(target, directory))) throw new Error(`${directory} still exists`)
    }
    // The application files the fixture shipped are untouched.
    for (const file of ['package.json', 'tsconfig.json', 'src/index.ts']) {
      if (!existsSync(path.join(target, file))) throw new Error(`uninstall removed ${file}`)
    }
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`smoke test failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('smoke test passed')
