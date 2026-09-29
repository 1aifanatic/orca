import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { posix, win32 } from 'node:path'
import { lock } from 'proper-lockfile'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'

export type ClaudeTrustPathStyle = 'posix' | 'win32'

export type ClaudeFolderTrustOutcome =
  | 'granted'
  | 'revoked'
  | 'unchanged'
  | 'missing-config'
  | 'locked'
  | 'unreadable'

type ClaudeConfigEnv = {
  CLAUDE_CONFIG_DIR?: string
  CLAUDE_CODE_CUSTOM_OAUTH_URL?: string
}

// Why: Orca must never break a lock — a held one means "skip and let Claude ask".
// Large enough that proper-lockfile never judges it stale, small enough that its
// half-stale refresh timer stays inside setTimeout's 32-bit range.
const NEVER_STALE_MS = 2 ** 30
const LOCK_RETRIES = { retries: 4, factor: 2, minTimeout: 50, maxTimeout: 250 }

function pathApi(style: ClaudeTrustPathStyle): typeof posix {
  return style === 'win32' ? win32 : posix
}

/** Claude looks up NFC `path.normalize` output, with `/` separators on Windows. */
export function toClaudeTrustKey(folderPath: string, style: ClaudeTrustPathStyle): string {
  const normalized = pathApi(style).normalize(folderPath.normalize('NFC'))
  return style === 'win32' ? normalized.replaceAll('\\', '/') : normalized
}

/**
 * Mirrors Claude Code's global config lookup: a legacy `<configDir>/.config.json`
 * wins, otherwise `.claude.json` sits in `CLAUDE_CONFIG_DIR` or the home directory.
 */
export function resolveClaudeGlobalConfigFile(args: {
  env: ClaudeConfigEnv
  homeDir: string
  style: ClaudeTrustPathStyle
  exists: (filePath: string) => boolean
}): string {
  const { join } = pathApi(args.style)
  const legacyDir = (args.env.CLAUDE_CONFIG_DIR ?? join(args.homeDir, '.claude')).normalize('NFC')
  const legacyFile = join(legacyDir, '.config.json')
  if (args.exists(legacyFile)) {
    return legacyFile
  }
  const suffix = args.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
  return join(args.env.CLAUDE_CONFIG_DIR || args.homeDir, `.claude${suffix}.json`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The only entry shape Orca writes; Claude's own entries always carry its project defaults. */
function isOrcaOwnedTrustEntry(entry: unknown): boolean {
  return (
    isPlainObject(entry) && Object.keys(entry).length === 1 && entry.hasTrustDialogAccepted === true
  )
}

export type ClaudeFolderTrustChange =
  | { kind: 'unchanged' }
  | { kind: 'refuse' }
  | { kind: 'changed'; config: Record<string, unknown> }

export function applyClaudeFolderTrust(
  config: Record<string, unknown>,
  args: {
    folderKeys: readonly string[]
    /** Keys Claude checks before its folder walk (the canonical repo root). */
    inheritedTrustKeys: readonly string[]
    trusted: boolean
  }
): ClaudeFolderTrustChange {
  if (config.projects !== undefined && !isPlainObject(config.projects)) {
    return { kind: 'refuse' }
  }
  const projects: Record<string, unknown> = { ...config.projects }
  if (args.trusted) {
    const alreadyTrusted = [...args.folderKeys, ...args.inheritedTrustKeys].some((key) => {
      const entry = projects[key]
      return isPlainObject(entry) && entry.hasTrustDialogAccepted === true
    })
    if (alreadyTrusted) {
      return { kind: 'unchanged' }
    }
    for (const key of args.folderKeys) {
      const entry = projects[key]
      projects[key] = isPlainObject(entry)
        ? { ...entry, hasTrustDialogAccepted: true }
        : { hasTrustDialogAccepted: true }
    }
    return { kind: 'changed', config: { ...config, projects } }
  }
  const owned = args.folderKeys.filter((key) => isOrcaOwnedTrustEntry(projects[key]))
  if (owned.length === 0) {
    return { kind: 'unchanged' }
  }
  for (const key of owned) {
    delete projects[key]
  }
  return { kind: 'changed', config: { ...config, projects } }
}

function isMissingFileError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

type ConfigTarget = { kind: 'file'; path: string } | { kind: 'missing' } | { kind: 'unreadable' }

/** Resolves a symlinked config to its target so the rename keeps the link intact. */
function resolveConfigTarget(configFile: string): ConfigTarget {
  try {
    const entry = lstatSync(configFile)
    const path = entry.isSymbolicLink() ? realpathSync(configFile) : configFile
    return statSync(path).isFile() ? { kind: 'file', path } : { kind: 'unreadable' }
  } catch (error) {
    return { kind: isMissingFileError(error) ? 'missing' : 'unreadable' }
  }
}

/** Reads the config behind `target`, or says why it cannot be rewritten. */
function readConfigAt(
  target: ConfigTarget
): { path: string; config: Record<string, unknown> } | 'missing-config' | 'unreadable' {
  if (target.kind === 'missing') {
    return 'missing-config'
  }
  if (target.kind === 'unreadable') {
    return 'unreadable'
  }
  const config = readConfigObject(target.path)
  return config ? { path: target.path, config } : 'unreadable'
}

function readConfigObject(target: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf-8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeConfigAtomically(target: string, config: Record<string, unknown>): void {
  const mode = statSync(target).mode & 0o777
  const tmpPath = `${target}.orca-trust-${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode })
    if (process.platform !== 'win32') {
      // Why: umask may narrow the requested mode; the replacement must match the original exactly.
      chmodSync(tmpPath, mode)
    }
    renameFileWithWindowsRetry(tmpPath, target)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}

/**
 * Brings `projects[<folder>].hasTrustDialogAccepted` to the desired state in Claude's
 * global config. Never creates the file, never breaks Claude's lock, and never
 * rewrites a file it could not read and parse.
 */
export async function convergeClaudeFolderTrust(args: {
  configFile: string
  folderKeys: readonly string[]
  inheritedTrustKeys: readonly string[]
  trusted: boolean
}): Promise<ClaudeFolderTrustOutcome> {
  const probe = readConfigAt(resolveConfigTarget(args.configFile))
  if (typeof probe === 'string') {
    return probe
  }
  // Why: most launches need nothing, so skip Claude's lock unless a write is due.
  const planned = applyClaudeFolderTrust(probe.config, args).kind
  if (planned !== 'changed') {
    return planned === 'refuse' ? 'unreadable' : 'unchanged'
  }

  let release: () => Promise<void>
  try {
    release = await lock(args.configFile, {
      // Why: Claude locks the literal `<file>.lock`, not a realpath'd one.
      lockfilePath: `${args.configFile}.lock`,
      realpath: false,
      stale: NEVER_STALE_MS,
      retries: LOCK_RETRIES,
      onCompromised: () => {}
    })
  } catch {
    return 'locked'
  }
  try {
    // Why: read → rename stays synchronous so Orca's own synchronous auth writer to
    // this file cannot interleave and lose an update.
    const current = readConfigAt(resolveConfigTarget(args.configFile))
    if (typeof current === 'string') {
      return current
    }
    const change = applyClaudeFolderTrust(current.config, args)
    if (change.kind === 'refuse') {
      return 'unreadable'
    }
    if (change.kind === 'unchanged') {
      return 'unchanged'
    }
    writeConfigAtomically(current.path, change.config)
    return args.trusted ? 'granted' : 'revoked'
  } finally {
    await release().catch(() => {})
  }
}
