import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MANIFEST_PATH } from '../../../src/core/ownership.js'
import { FileSystemError, type FileSystemPort } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { applyPreparedUninstall, prepareUninstall } from '../../../src/lifecycle/uninstall.js'
import { applyPreparedUpdate, prepareUpdate } from '../../../src/lifecycle/update.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
} from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, readTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENT = '.claude/agents/wrkrs-software-engineer.md'

async function install(): Promise<{ root: string; ports: InitPorts }> {
  const root = createFixtureRepository('clean-repository', { commit: true })
  cleanup.push(root)
  const ports = createTestPorts()
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  const result = await applyPreparedInit(prepared.value, createTestDependencies(), ports)
  if (result.status !== 'applied') throw new Error(`install failed: ${result.status}`)
  return { root, ports }
}

function editConfig(root: string, edit: (text: string) => string): void {
  const file = path.join(root, '.wrkrs', 'config.yaml')
  writeFileSync(file, edit(readFileSync(file, 'utf8')))
}

/** Adds a specialization so an update has several files to replace. */
function widenRoster(root: string): void {
  editConfig(root, (text) =>
    text.replace('        - web-frontend\n', '        - web-frontend\n        - rust\n'),
  )
}

async function updateWith(root: string, fs: FileSystemPort) {
  const ports = createTestPorts({ fs })
  const prepared = await prepareUpdate(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
}

async function uninstallWith(root: string, fs: FileSystemPort) {
  const ports = createTestPorts({ fs })
  const prepared = await prepareUninstall(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return applyPreparedUninstall(prepared.value, createTestDependencies(), ports)
}

describe('lifecycle rollback', () => {
  it('65: a failure during update restores every replaced file byte for byte', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const before = readTree(root)
    const beforeHash = hashTree(root)

    // Fail while publishing the manifest, after the content files were
    // replaced and verified.
    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json' && !failed) {
            failed = true
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })

    const result = await updateWith(root, fs)
    expect(failed).toBe(true)
    expect(result.status).toBe('rolled-back')
    expect(hashTree(root)).toBe(beforeHash)
    expect(readTree(root)).toEqual(before)
  })

  it('65: a failure during update restores a removed file byte for byte', async () => {
    const { root, ports } = await install()
    // Removing a role makes the update both replace and remove files.
    editConfig(root, (text) =>
      text.replace('    - id: qa-engineer\n      source: .wrkrs/roles/qa-engineer.md\n', ''),
    )
    const before = readTree(root)

    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json' && !failed) {
            failed = true
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })

    const result = await updateWith(root, fs)
    expect(result.status).toBe('rolled-back')
    expect(readTree(root)).toEqual(before)
  })

  it('66: a failure during uninstall restores every removed file byte for byte', async () => {
    const { root, ports } = await install()
    const before = readTree(root)

    // Fail on the last removal, after several files are already gone.
    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        unlink: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[0] === 'manifest.json' && !failed) {
            failed = true
            throw new FileSystemError('EIO', args[0], 'injected removal failure')
          }
          return next(...args)
        },
      },
    })

    const result = await uninstallWith(root, fs)
    expect(failed).toBe(true)
    expect(result.status).toBe('rolled-back')
    expect(readTree(root)).toEqual(before)
  })

  it('67: a precondition change between planning and apply aborts before any mutation', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    // The repository changes after the plan was built.
    appendFileSync(path.join(root, AGENT), '\nchanged after planning\n')
    const before = readTree(root)

    const result = await applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') return
    expect(result.conflicts.some((conflict) => conflict.path === AGENT)).toBe(true)
    expect(readTree(root)).toEqual(before)
  })

  it('67: an uninstall aborts when an owned file changes between planning and apply', async () => {
    const { root, ports } = await install()
    const prepared = await prepareUninstall(root, createTestDependencies(), ports)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    appendFileSync(path.join(root, AGENT), '\nchanged after planning\n')
    const before = readTree(root)

    const result = await applyPreparedUninstall(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('aborted')
    expect(readTree(root)).toEqual(before)
  })

  it('68: rollback never clobbers a file changed externally after wrkrs wrote it', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const external = 'EXTERNAL CONTENT WRITTEN DURING APPLY\n'

    // Replace the agent, then have an external writer overwrite it before the
    // transaction fails, so rollback finds content wrkrs did not write.
    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json' && !failed) {
            failed = true
            writeFileSync(path.join(root, AGENT), external)
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })

    const result = await updateWith(root, fs)
    expect(failed).toBe(true)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    // The external content is preserved and the exact path is reported.
    expect(readFileSync(path.join(root, AGENT), 'utf8')).toBe(external)
    expect(result.retained.map((item) => item.path)).toContain(AGENT)
    expect(result.journalPath).toBe('.wrkrs/.journal.json')
  })

  it('68: rollback never clobbers a removed file that reappeared during apply', async () => {
    const { root, ports } = await install()
    const external = 'RECREATED BY SOMEONE ELSE\n'

    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        unlink: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[0] === 'manifest.json' && !failed) {
            failed = true
            writeFileSync(path.join(root, AGENT), external)
            throw new FileSystemError('EIO', args[0], 'injected removal failure')
          }
          return next(...args)
        },
      },
    })

    const result = await uninstallWith(root, fs)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    expect(readFileSync(path.join(root, AGENT), 'utf8')).toBe(external)
    expect(result.retained.map((item) => item.path)).toContain(AGENT)
  })

  it('reports the exact path when the backup it needs to restore is gone', async () => {
    const { root, ports } = await install()
    widenRoster(root)

    // The backup is deleted by someone else after the target was replaced, so
    // rollback can no longer prove what the original content was.
    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json' && !failed) {
            failed = true
            for (const entry of readTree(root)) {
              if (entry.path.startsWith('.claude/agents/') && entry.path.endsWith('.bak')) {
                rmSync(path.join(root, entry.path))
              }
            }
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })

    const result = await updateWith(root, fs)
    expect(failed).toBe(true)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const retained = result.retained.find((item) => item.path === AGENT)
    expect(retained).toBeDefined()
    expect(retained?.reason).toContain('backup')
    // The replaced content is left in place rather than guessed at.
    expect(readFileSync(path.join(root, AGENT), 'utf8')).toContain('rust')
  })

  it('never restores from a backup whose content is not what wrkrs linked', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const originalAgent = readFileSync(path.join(root, AGENT), 'utf8')

    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json' && !failed) {
            failed = true
            for (const entry of readTree(root)) {
              if (entry.path.startsWith('.claude/agents/') && entry.path.endsWith('.bak')) {
                writeFileSync(path.join(root, entry.path), 'SOMEONE ELSE OWNS THIS NOW\n')
              }
            }
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })

    const result = await updateWith(root, fs)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    // Both the tampered backup and the target it could not restore are named.
    expect(result.retained.some((item) => item.path.endsWith('.bak'))).toBe(true)
    expect(readFileSync(path.join(root, AGENT), 'utf8')).not.toBe(originalAgent)
  })

  it('leaves no backup file behind after a successful lifecycle transaction', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const update = await updateWith(root, ports.fs)
    expect(update.status).toBe('applied')
    const stray = readTree(root).filter((entry) => entry.path.includes('.bak'))
    expect(stray).toEqual([])

    const uninstall = await uninstallWith(root, ports.fs)
    expect(uninstall.status).toBe('applied')
    expect(readTree(root).filter((entry) => entry.path.includes('.bak'))).toEqual([])
  })

  it('never replaces a target when the backup name is already taken', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const before = readTree(root)

    // Claim the backup name the transaction is about to use.
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        linkExclusive: async (args, next) => {
          if (args[1].endsWith('.bak')) {
            throw new FileSystemError('EEXIST', args[1], 'entry already exists')
          }
          return next(...args)
        },
      },
    })

    const result = await updateWith(root, fs)
    expect(result.status).toBe('rolled-back')
    if (result.status !== 'rolled-back') return
    expect(result.conflict?.code).toBe('PRECONDITION_BACKUP_NAME_TAKEN')
    expect(readTree(root)).toEqual(before)
  })

  it('an interrupted lifecycle transaction is reported by the manifest path it names', async () => {
    const { root, ports } = await install()
    widenRoster(root)
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json') {
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })
    const result = await updateWith(root, fs)
    expect(result.status).toBe('rolled-back')
    // The manifest is the last operation, so a failure there proves the whole
    // content set was already applied and then reversed.
    expect(readFileSync(path.join(root, MANIFEST_PATH), 'utf8')).toContain('"state": "installed"')
  })
})
