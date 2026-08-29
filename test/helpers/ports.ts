import { createClaudeCodeAdapter } from '../../src/adapters/claude-code/adapter.js'
import { createRuntimeAdapterRegistry } from '../../src/adapters/registry.js'
import type { EnvironmentPort, FileSystemPort } from '../../src/core/ports.js'
import type { InitDependencies, InitPorts } from '../../src/init/init.js'
import { createFixedClock } from '../../src/platform/clock.js'
import { createNodeEnvironment } from '../../src/platform/environment.js'
import { createNodeFileSystem } from '../../src/platform/filesystem.js'
import { createGit } from '../../src/platform/git.js'
import { createSequentialIds } from '../../src/platform/ids.js'
import { createNodeProcess } from '../../src/platform/process.js'
import { productEngineeringPreset } from '../../src/presets/product-engineering/index.js'
import { createProviderRegistry } from '../../src/providers/registry.js'

export const TEST_VERSION = '0.1.0-test'
export const FIXED_TIME = '2026-08-29T12:00:00.000Z'

export function createTestEnvironment(overrides: Partial<EnvironmentPort> = {}): EnvironmentPort {
  return { ...createNodeEnvironment(), ...overrides }
}

export function createTestPorts(overrides: Partial<InitPorts> = {}): InitPorts {
  return {
    fs: createNodeFileSystem(),
    git: createGit(createNodeProcess()),
    clock: createFixedClock(FIXED_TIME),
    ids: createSequentialIds(),
    environment: createTestEnvironment(),
    ...overrides,
  }
}

export function createTestDependencies(
  overrides: Partial<InitDependencies> = {},
): InitDependencies {
  return {
    wrkrsVersion: TEST_VERSION,
    preset: productEngineeringPreset,
    adapters: createRuntimeAdapterRegistry([createClaudeCodeAdapter()]),
    providers: createProviderRegistry([]),
    ...overrides,
  }
}

type Next<K extends keyof FileSystemPort> = FileSystemPort[K]

export interface FileSystemInterceptors {
  writeFileExclusive?: (
    args: Parameters<FileSystemPort['writeFileExclusive']>,
    next: Next<'writeFileExclusive'>,
  ) => Promise<void>
  rename?: (args: Parameters<FileSystemPort['rename']>, next: Next<'rename'>) => Promise<void>
  unlink?: (args: Parameters<FileSystemPort['unlink']>, next: Next<'unlink'>) => Promise<void>
  makeDirectory?: (
    args: Parameters<FileSystemPort['makeDirectory']>,
    next: Next<'makeDirectory'>,
  ) => Promise<void>
}

/**
 * Fault-injection seam: wraps a real filesystem port so tests can fail or
 * tamper with specific operations while every other call hits the disk.
 */
export function interceptFileSystem(
  inner: FileSystemPort,
  interceptors: FileSystemInterceptors,
): FileSystemPort {
  return {
    ...inner,
    writeFileExclusive: (...args) =>
      interceptors.writeFileExclusive
        ? interceptors.writeFileExclusive(args, inner.writeFileExclusive.bind(inner))
        : inner.writeFileExclusive(...args),
    rename: (...args) =>
      interceptors.rename
        ? interceptors.rename(args, inner.rename.bind(inner))
        : inner.rename(...args),
    unlink: (...args) =>
      interceptors.unlink
        ? interceptors.unlink(args, inner.unlink.bind(inner))
        : inner.unlink(...args),
    makeDirectory: (...args) =>
      interceptors.makeDirectory
        ? interceptors.makeDirectory(args, inner.makeDirectory.bind(inner))
        : inner.makeDirectory(...args),
  }
}
