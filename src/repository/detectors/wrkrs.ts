import {
  parseConfigDocument,
  parseJournalDocument,
  parseManifestDocument,
} from '../../config/load.js'
import { createFinding, type Finding } from '../../core/findings.js'
import {
  CONFIG_PATH,
  JOURNAL_PATH,
  LOCK_PATH,
  MANIFEST_PATH,
  WRKRS_DIRECTORY,
} from '../../core/ownership.js'
import type { WrkrsSnapshot } from '../../core/snapshot.js'
import type { ScanContext } from '../snapshot.js'

export interface WrkrsDetection {
  readonly wrkrs: WrkrsSnapshot
  readonly findings: readonly Finding[]
}

/** Detects an existing .wrkrs directory, its manifest validity, and transaction residue. */
export async function detectWrkrs(context: ScanContext): Promise<WrkrsDetection> {
  const findings: Finding[] = []
  const directory = await context.stat(WRKRS_DIRECTORY)
  if (!directory) {
    return {
      wrkrs: {
        directoryKind: null,
        config: null,
        manifest: null,
        lockPresent: false,
        journal: null,
      },
      findings,
    }
  }

  const configText = await context.readText(CONFIG_PATH)
  let config: WrkrsSnapshot['config'] = null
  if (configText !== null) {
    const parsed = parseConfigDocument(configText)
    config = parsed.ok
      ? { path: CONFIG_PATH, valid: true, schemaVersion: parsed.value.schemaVersion, error: null }
      : {
          path: CONFIG_PATH,
          valid: false,
          schemaVersion: parsed.error.schemaVersion,
          error: `${parsed.error.code}: ${parsed.error.message}`,
        }
  }

  const manifestText = await context.readText(MANIFEST_PATH)
  let manifest: WrkrsSnapshot['manifest'] = null
  if (manifestText !== null) {
    const parsed = parseManifestDocument(manifestText)
    manifest = parsed.ok
      ? {
          path: MANIFEST_PATH,
          valid: true,
          manifest: parsed.value.manifest,
          sourceSchemaVersion: parsed.value.sourceSchemaVersion,
          error: null,
        }
      : {
          path: MANIFEST_PATH,
          valid: false,
          manifest: null,
          sourceSchemaVersion: parsed.error.schemaVersion,
          error: `${parsed.error.code}: ${parsed.error.message}`,
        }
  }

  const lock = await context.stat(LOCK_PATH)
  const lockPresent = lock !== null

  const journalText = await context.readText(JOURNAL_PATH)
  let journal: WrkrsSnapshot['journal'] = null
  if (journalText !== null) {
    const parsed = parseJournalDocument(journalText)
    journal = parsed.ok
      ? {
          path: JOURNAL_PATH,
          transactionId: parsed.value.transactionId,
          status: parsed.value.status,
        }
      : { path: JOURNAL_PATH, transactionId: null, status: null }
  }

  if (directory.kind !== 'directory') {
    findings.push(
      createFinding(
        'WRKRS_PATH_NOT_A_DIRECTORY',
        'warning',
        '.wrkrs exists but is not a directory',
        {
          path: WRKRS_DIRECTORY,
          evidence: [{ key: 'kind', value: directory.kind }],
        },
      ),
    )
  } else if (manifest?.valid) {
    findings.push(
      createFinding(
        'WRKRS_INSTALLATION_PRESENT',
        'info',
        'An existing wrkrs installation was found',
        {
          path: MANIFEST_PATH,
          evidence: [
            { key: 'wrkrsVersion', value: manifest.manifest?.wrkrsVersion ?? '' },
            { key: 'entries', value: manifest.manifest?.entries.length ?? 0 },
          ],
        },
      ),
    )
  } else if (manifest) {
    findings.push(
      createFinding(
        'WRKRS_MANIFEST_INVALID',
        'warning',
        `Existing manifest is invalid: ${manifest.error ?? ''}`,
        {
          path: MANIFEST_PATH,
        },
      ),
    )
  } else {
    findings.push(
      createFinding(
        'WRKRS_DIRECTORY_WITHOUT_MANIFEST',
        'warning',
        '.wrkrs exists without an ownership manifest',
        { path: WRKRS_DIRECTORY },
      ),
    )
  }
  if (config && !config.valid) {
    findings.push(
      createFinding(
        'WRKRS_CONFIG_INVALID',
        'warning',
        `Existing config is invalid: ${config.error ?? ''}`,
        {
          path: CONFIG_PATH,
        },
      ),
    )
  }
  if (journal) {
    findings.push(
      createFinding(
        'WRKRS_TRANSACTION_JOURNAL_PRESENT',
        'warning',
        'An interrupted wrkrs transaction journal is present',
        {
          path: JOURNAL_PATH,
          evidence: [
            { key: 'transactionId', value: journal.transactionId ?? '' },
            { key: 'status', value: journal.status ?? 'unparseable' },
          ],
        },
      ),
    )
  }
  if (lockPresent) {
    findings.push(
      createFinding('WRKRS_LOCK_PRESENT', 'warning', 'A wrkrs installation lock is present', {
        path: LOCK_PATH,
      }),
    )
  }

  return {
    wrkrs: { directoryKind: directory.kind, config, manifest, lockPresent, journal },
    findings,
  }
}
