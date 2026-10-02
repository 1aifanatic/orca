import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareOpenCodeClaimPriority,
  listOpenCodeDatabases
} from '../opencode-usage/opencode-database-discovery'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readOpenCodeGoKeyFromDatabases } from '../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import {
  isRecord,
  keyFromCredentialRecord,
  OPENCODE_GO_INTEGRATION_ID,
  trimmedKey
} from './opencode-go-credential-record'

/** models.dev declares this env var for both `opencode` and `opencode-go`. */
const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'
const AUTH_FILE_NAME = 'auth.json'
const MAX_AUTH_FILE_BYTES = 1_000_000

/** Where the key came from. Safe to log — never carries the key itself. */
export type OpenCodeGoApiKeyTier =
  | 'settings'
  | 'environment'
  | 'opencode-auth-file'
  | 'opencode-credential-database'

export type OpenCodeGoApiKeyResolution =
  | { status: 'found'; key: string; tier: OpenCodeGoApiKeyTier }
  | { status: 'missing' }

export function getOpenCodeAuthFilePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string
): string {
  return join(resolveOpenCodeDataDirectory(environment, homeDirectory), AUTH_FILE_NAME)
}

/**
 * Read the `opencode-go` API key OpenCode 1.x writes on `/connect`.
 *
 * Shape (opencode `packages/opencode/src/auth/index.ts`, `Api` schema):
 * `{ "opencode-go": { "type": "api", "key": "…" } }`.
 * @returns The key, or null when the file, the entry, or the key is absent.
 */
export function readOpenCodeAuthFileGoKey(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string
): string | null {
  const path = getOpenCodeAuthFilePath(environment, homeDirectory)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    if (raw.length > MAX_AUTH_FILE_BYTES) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return null
    }
    return keyFromCredentialRecord(parsed[OPENCODE_GO_INTEGRATION_ID], 'api')
  } catch {
    // Why: a malformed or unreadable auth file is "no key here", not a fetch
    // failure — later tiers and the cookie path still deserve their turn.
    return null
  }
}

/**
 * Read the `opencode-go` key from OpenCode's `credential` table.
 *
 * OpenCode 2 imports `auth.json` into SQLite once (migration
 * `20260805200742_import_legacy_credentials`) and every later `/connect` writes
 * only there, so a fresh OpenCode 2 install has no `auth.json` entry at all.
 * The table itself is not a version marker — 1.18.x creates it too (verified
 * empty on a real 1.18.16 install), so probe it regardless of version.
 * @returns The key, or null when no database, table, or row carries one.
 */
export async function readOpenCodeCredentialDatabaseGoKey(): Promise<string | null> {
  let paths: string[]
  try {
    paths = [...(await listOpenCodeDatabases())].sort(compareOpenCodeClaimPriority)
  } catch {
    return null
  }
  // Why skip UNC paths even off-thread: a 9p/UNC open can hang its reader thread for
  // the whole timeout, and the status bar is never worth that; the other tiers still apply.
  const localPaths = paths.filter((path) => !isWslUncPath(path))
  if (localPaths.length === 0) {
    return null
  }
  // Runs on the foreign SQLite reader worker; `unreadable` stays "no key" here.
  const read = await readOpenCodeGoKeyFromDatabases(localPaths)
  return read.status === 'found' ? read.key : null
}

/**
 * Resolve the OpenCode Go API key in the documented precedence order.
 *
 * Settings override, then whatever OpenCode itself stored on `/connect` —
 * `auth.json`, then the `credential` table — then `OPENCODE_API_KEY`. Both
 * stores are probed on every version: 1.18.x creates the `credential` table too,
 * so its presence is not a 2.x marker, and a 2.x install that never ran the
 * legacy import has no `auth.json` at all.
 * The stored key outranks the env var because OpenCode applies it after env,
 * and the env var is shared with the Zen provider.
 * @param input.settingsOverride - The key a user pasted into Orca's settings.
 * @param input.environment - Process environment to read; injectable for tests.
 * @returns The first key found and the tier it came from, or `missing`.
 */
export async function resolveOpenCodeGoApiKey(input: {
  settingsOverride?: string
  environment?: NodeJS.ProcessEnv
}): Promise<OpenCodeGoApiKeyResolution> {
  const environment = input.environment ?? process.env
  const override = trimmedKey(input.settingsOverride)
  if (override) {
    return { status: 'found', key: override, tier: 'settings' }
  }
  const fromAuthFile = readOpenCodeAuthFileGoKey(environment)
  if (fromAuthFile) {
    return { status: 'found', key: fromAuthFile, tier: 'opencode-auth-file' }
  }
  const fromDatabase = await readOpenCodeCredentialDatabaseGoKey()
  if (fromDatabase) {
    return { status: 'found', key: fromDatabase, tier: 'opencode-credential-database' }
  }
  const fromEnvironment = trimmedKey(environment[OPENCODE_API_KEY_ENV])
  if (fromEnvironment) {
    return { status: 'found', key: fromEnvironment, tier: 'environment' }
  }
  return { status: 'missing' }
}
