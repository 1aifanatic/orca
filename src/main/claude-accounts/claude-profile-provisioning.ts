import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  resolveClaudeGlobalConfigFile,
  updateClaudeGlobalConfig
} from '../claude/claude-folder-trust-file'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'
import { readClaudeProfileObject, resolveClaudeDefaultHome } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import {
  ClaudeProfileSurfaceError,
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'
import { copyClaudeProfileFile, linkClaudeProfileDirectory } from './claude-profile-sharing'

const CLAUDE_PROFILE_MEMORY_IMPORT = '@~/.claude/CLAUDE.md\n'

/**
 * Top-level default-home entries a profile never shares: Claude's per-folder daemon, jobs and
 * live-process registry, the login and account-bound files, per-install throwaways, the two
 * config files copied below, and history, which setup links the other way.
 */
const UNSHARED_ENTRIES: ReadonlySet<string> = new Set([
  'daemon',
  'daemon.json',
  'daemon.log',
  'daemon.lock',
  'daemon.status.json',
  'jobs',
  'state',
  'sessions',
  '.credentials.json',
  'policy-limits.json',
  'remote-settings.json',
  'mcp-needs-auth-cache.json',
  'cache',
  'debug',
  'telemetry',
  'statsig',
  'backups',
  'stats-cache.json',
  'usage-data',
  'logs',
  'settings.json',
  // Claude's legacy state file, which holds the login like .claude.json.
  '.config.json',
  'history.jsonl',
  ...CLAUDE_PROFILE_HISTORY_DIRS
])

function isSharedEntry(name: string): boolean {
  // Why `.claude`: with the user's own CLAUDE_CONFIG_DIR its state file, backups and locks sit here.
  return !UNSHARED_ENTRIES.has(name) && !name.startsWith('.last-') && !name.startsWith('.claude')
}

/** Install ids Claude writes before any sign-in; each folder keeps its own. */
const INSTALL_STATE_KEYS: ReadonlySet<string> = new Set([
  'userID',
  'machineID',
  'firstStartTime',
  'firstStartVersion'
])

/** State that belongs to the folder's login or install, never copied from the default home. */
function isAccountBoundState(key: string): boolean {
  return (
    key === 'oauthAccount' ||
    // Why: a Console API key login; copied, it would outrank the account's own login.
    key === 'primaryApiKey' ||
    key.includes('Cache') ||
    key.startsWith('cached') ||
    key.startsWith('passes') ||
    // Why: Claude never refetches it; a copied value can also skip startup fetches.
    key === 'claudeCodeFirstTokenDate' ||
    key === 'startupPrefetchedAt' ||
    INSTALL_STATE_KEYS.has(key)
  )
}

/** The whole file: the default home is the master copy, proxy address and key included. */
function copySettings(source: string, target: string): ClaudeProfileSurfaceOutcome {
  const input = readClaudeProfileObject(source)
  const current = readClaudeProfileObject(target)
  // Why by value: the hook installer rewrites the copy in its own layout after every refresh.
  if (
    input.kind === 'present' &&
    current.kind === 'present' &&
    !lstatIfPresent(target)?.isSymbolicLink() &&
    JSON.stringify(input.value) === JSON.stringify(current.value)
  ) {
    return 'unchanged'
  }
  const outcome = copyClaudeProfileFile(source, target)
  if (outcome === 'absent' && lstatIfPresent(target)?.isFile()) {
    rmSync(target, { force: true })
    return 'synced'
  }
  return outcome
}

async function copyState(source: string, target: string): Promise<ClaudeProfileSurfaceOutcome> {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(source)
  if (input.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Personal Claude state is unreadable')
  }
  if (input.kind === 'absent') {
    return 'absent'
  }
  const shared = Object.entries(input.value).filter(([key]) => !isAccountBoundState(key))
  if (!lstatIfPresent(target)) {
    try {
      // Why exclusive: Claude may create its own state file meanwhile; that one wins.
      writeFileSync(target, `${JSON.stringify(Object.fromEntries(shared), null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600
      })
      return 'synced'
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
  }
  // Why no deletions: a key the default home lacks may be one Claude added only in this folder.
  const outcome = await updateClaudeGlobalConfig(target, (current) => {
    const config = { ...current }
    for (const [key, value] of shared) {
      config[key] = value
    }
    return JSON.stringify(config) === JSON.stringify(current)
      ? { kind: 'unchanged' }
      : { kind: 'changed', config }
  })
  if (outcome === 'locked' || outcome === 'unreadable' || outcome === 'missing-config') {
    throw new ClaudeProfileSurfaceError(
      outcome === 'locked' ? 'locked' : 'unreadable',
      `Profile Claude state is ${outcome}`
    )
  }
  return outcome === 'updated' ? 'merged' : 'unchanged'
}

/**
 * Refreshes a profile from the default home, the master copy: everything but the login and
 * account-bound items. Execution-host paths; never writes the default home or credentials.
 * Callers go through provisionClaudeAccountProfile, which gates and creates the profile.
 */
export async function provisionClaudeProfile(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileReport> {
  const platform = args.platform ?? process.platform
  const defaultHome = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  const report = createClaudeProfileReport()
  // Why only for ~/.claude: Claude also loads it as a parent folder's memory for projects under
  // home, so a copy would load twice; a custom CLAUDE_CONFIG_DIR is copied, as superset does.
  const imported = resolve(defaultHome) === resolve(args.userHome, '.claude')
  let names: string[] = []
  try {
    names = readdirSync(defaultHome).filter(isSharedEntry)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      warnClaudeProfile(report, 'profile', error)
    }
  }
  for (const name of names) {
    const source = join(defaultHome, name)
    const target = join(args.profileHome, name)
    await runClaudeProfileSurface(report, name, () => {
      // Why stat, not lstat: a linked entry is shared as what it points at.
      const entry = statSync(source, { throwIfNoEntry: false })
      if (entry?.isDirectory()) {
        return linkClaudeProfileDirectory(source, target, platform)
      }
      if (!entry?.isFile()) {
        return 'absent'
      }
      return name === 'CLAUDE.md' && imported
        ? copyClaudeProfileFile(source, target, () => Buffer.from(CLAUDE_PROFILE_MEMORY_IMPORT))
        : copyClaudeProfileFile(source, target)
    })
  }
  await runClaudeProfileSurface(report, 'settings.json', () =>
    copySettings(join(defaultHome, 'settings.json'), join(args.profileHome, 'settings.json'))
  )
  const statePath = (configDir: string | undefined): string =>
    resolveClaudeGlobalConfigFile({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: args.userHome,
      style: platform === 'win32' ? 'win32' : 'posix',
      exists: existsSync
    })
  await runClaudeProfileSurface(report, '.claude.json', () =>
    copyState(statePath(args.userConfigDir), statePath(args.profileHome))
  )
  return report
}
