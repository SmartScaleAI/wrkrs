#!/usr/bin/env node
import { createClaudeCodeAdapter } from '../adapters/claude-code/adapter.js'
import { createRuntimeAdapterRegistry } from '../adapters/registry.js'
import { systemClock } from '../platform/clock.js'
import { createNodeEnvironment } from '../platform/environment.js'
import { createNodeFileSystem } from '../platform/filesystem.js'
import { createGit } from '../platform/git.js'
import { systemIds } from '../platform/ids.js'
import { readPackageInfo } from '../platform/package-info.js'
import { createNodeProcess } from '../platform/process.js'
import { productEngineeringPreset } from '../presets/product-engineering/index.js'
import { createProviderRegistry } from '../providers/registry.js'
import { runCli } from './program.js'
import { createReadlinePrompt } from './prompt.js'

/** Composition root: assembles ports, registries, and streams; contains no logic. */
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
const colors =
  Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb'

const fs = createNodeFileSystem()
const code = await runCli(process.argv.slice(2), {
  services: {
    wrkrsVersion: readPackageInfo().version,
    ports: {
      fs,
      git: createGit(createNodeProcess()),
      clock: systemClock,
      ids: systemIds,
      environment: createNodeEnvironment(),
    },
    prompt: createReadlinePrompt({ input: process.stdin, output: process.stdout, interactive }),
    preset: productEngineeringPreset,
    adapters: createRuntimeAdapterRegistry([createClaudeCodeAdapter()]),
    providers: createProviderRegistry([]),
  },
  streams: { stdout: process.stdout, stderr: process.stderr },
  colors,
  defaultCwd: process.cwd(),
})
process.exitCode = code
