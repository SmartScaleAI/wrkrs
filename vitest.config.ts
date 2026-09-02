import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Node filesystem port binds the process working directory to a
    // verified repository directory for each contained operation, which
    // requires process.chdir; worker threads cannot change directory.
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/build.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/index.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
