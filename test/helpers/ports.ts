import { createClaudeCodeAdapter } from '../../src/adapters/claude-code/adapter.js'
import { createRuntimeAdapterRegistry } from '../../src/adapters/registry.js'
import type { BoundDirectory, EnvironmentPort, FileSystemPort } from '../../src/core/ports.js'
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

type BoundMethod = Exclude<keyof BoundDirectory, 'relativePath'>

/** Interceptor for one bound-directory method: receives the arguments, the real method, and the bound directory. */
export type BoundInterceptor<K extends BoundMethod> = (
  args: Parameters<BoundDirectory[K]>,
  next: BoundDirectory[K],
  directory: BoundDirectory,
) => ReturnType<BoundDirectory[K]>

export type BoundInterceptors = { [K in BoundMethod]?: BoundInterceptor<K> }

export interface FileSystemInterceptors {
  lstat?: (
    args: Parameters<FileSystemPort['lstat']>,
    next: FileSystemPort['lstat'],
  ) => ReturnType<FileSystemPort['lstat']>
  realpath?: (
    args: Parameters<FileSystemPort['realpath']>,
    next: FileSystemPort['realpath'],
  ) => ReturnType<FileSystemPort['realpath']>
  /** Runs around every withinDirectory call (before binding); may inspect root and directory. */
  withinDirectory?: (
    context: { root: string; relativeDirectory: string },
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  /** Interceptors for operations inside the bound directory. */
  bound?: BoundInterceptors
}

function wrapBound(directory: BoundDirectory, interceptors: BoundInterceptors): BoundDirectory {
  const wrapped: Record<string, unknown> = { relativePath: directory.relativePath }
  for (const method of Object.keys(directory) as (keyof BoundDirectory)[]) {
    if (method === 'relativePath') continue
    const original = directory[method] as (...args: unknown[]) => unknown
    const interceptor = interceptors[method] as
      | ((
          args: unknown[],
          next: (...args: unknown[]) => unknown,
          directory: BoundDirectory,
        ) => unknown)
      | undefined
    wrapped[method] = interceptor
      ? (...args: unknown[]) => interceptor(args, original.bind(directory), directory)
      : (...args: unknown[]) => original.apply(directory, args)
  }
  return wrapped as unknown as BoundDirectory
}

/**
 * Fault-injection seam: wraps a real filesystem port so tests can fail,
 * delay, or tamper with specific operations while every other call hits the
 * disk. Bound-directory interceptors run inside the real binding, so a test
 * that swaps an ancestor from inside an interceptor exercises the genuine
 * containment mechanism.
 */
export function interceptFileSystem(
  inner: FileSystemPort,
  interceptors: FileSystemInterceptors,
): FileSystemPort {
  return {
    containment: inner.containment,
    lstat: (...args) =>
      interceptors.lstat ? interceptors.lstat(args, inner.lstat.bind(inner)) : inner.lstat(...args),
    realpath: (...args) =>
      interceptors.realpath
        ? interceptors.realpath(args, inner.realpath.bind(inner))
        : inner.realpath(...args),
    withinDirectory: <T>(
      root: string,
      relativeDirectory: string,
      operation: (directory: BoundDirectory) => Promise<T>,
    ): Promise<T> => {
      const run = () =>
        inner.withinDirectory(root, relativeDirectory, (directory) =>
          operation(interceptors.bound ? wrapBound(directory, interceptors.bound) : directory),
        )
      return interceptors.withinDirectory
        ? (interceptors.withinDirectory({ root, relativeDirectory }, run) as Promise<T>)
        : run()
    },
  }
}

/** Records every bound read (directory/name) so tests can prove containment. */
export function recordReads(inner: FileSystemPort): { fs: FileSystemPort; reads: string[] } {
  const reads: string[] = []
  const fs = interceptFileSystem(inner, {
    bound: {
      readFile: (args, next, directory) => {
        reads.push(directory.relativePath === '' ? args[0] : `${directory.relativePath}/${args[0]}`)
        return next(...args)
      },
      readDirectory: (args, next, directory) => {
        reads.push(directory.relativePath === '' ? '.' : `${directory.relativePath}/`)
        return next(...args)
      },
    },
  })
  return { fs, reads }
}
