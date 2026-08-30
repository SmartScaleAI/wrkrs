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

type Method = keyof FileSystemPort
type Interceptor<K extends Method> = (
  args: Parameters<FileSystemPort[K]>,
  next: FileSystemPort[K],
) => ReturnType<FileSystemPort[K]>

export type FileSystemInterceptors = { [K in Method]?: Interceptor<K> }

/**
 * Fault-injection seam: wraps a real filesystem port so tests can fail,
 * delay, or tamper with specific operations while every other call hits the
 * disk. Each interceptor receives the original arguments and the real method.
 */
export function interceptFileSystem(
  inner: FileSystemPort,
  interceptors: FileSystemInterceptors,
): FileSystemPort {
  const wrapped: Record<string, unknown> = {}
  for (const method of Object.keys(inner) as Method[]) {
    const original = inner[method] as (...args: unknown[]) => unknown
    const interceptor = interceptors[method] as
      ((args: unknown[], next: (...args: unknown[]) => unknown) => unknown) | undefined
    wrapped[method] = interceptor
      ? (...args: unknown[]) => interceptor(args, original.bind(inner))
      : (...args: unknown[]) => original.apply(inner, args)
  }
  return wrapped as unknown as FileSystemPort
}

/** Records every path passed to a read operation so tests can prove containment. */
export function recordReads(inner: FileSystemPort): { fs: FileSystemPort; reads: string[] } {
  const reads: string[] = []
  const fs = interceptFileSystem(inner, {
    readFile: (args, next) => {
      reads.push(args[0])
      return next(...args)
    },
    readDirectory: (args, next) => {
      reads.push(args[0])
      return next(...args)
    },
  })
  return { fs, reads }
}
