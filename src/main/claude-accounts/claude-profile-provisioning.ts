import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  applyClaudeFolderTrust,
  resolveClaudeGlobalConfigFile,
  updateClaudeGlobalConfig
} from '../claude/claude-folder-trust-file'
import { isManagedStatusLine } from '../claude/hook-settings'
import { assertOutsideDefaultClaudeHomes, readClaudeProfileObject } from './claude-profile-paths'
import {
  ClaudeProfileSurfaceError,
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'
import {
  linkClaudeProfileDirectory,
  mergeClaudeProfileKeys,
  readClaudeProfileLedger,
  syncClaudeProfileFile,
  type ClaudeProfileLedger
} from './claude-profile-sharing'

export const CLAUDE_PROFILE_RESOURCE_DIRS = [
  'skills',
  'plugins',
  'agents',
  'commands',
  'output-styles'
] as const
const PRIVATE_KEYS = new Set([
  'hooks',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'forceLoginMethod',
  'forceLoginOrgUUID'
])
const PRIVATE_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
])
const SHARED_STATE_KEYS = ['mcpServers', 'theme']

function pickSettings(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source)
      // Why: Orca's managed statusLine belongs to the profile's hook installer; a user's own line is shared.
      .filter(
        ([key, value]) =>
          !PRIVATE_KEYS.has(key) && !(key === 'statusLine' && isManagedStatusLine(value))
      )
      .map(([key, value]) => {
        if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
          return [
            key,
            Object.fromEntries(Object.entries(value).filter(([name]) => !PRIVATE_ENV.has(name)))
          ]
        }
        return [key, value]
      })
  )
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

function mergeSettings(
  source: string,
  target: string,
  ledger: ClaudeProfileLedger
): ClaudeProfileSurfaceOutcome {
  if (isLink(target)) {
    return 'user-owned'
  }
  const existing = readClaudeProfileObject(target)
  const input = readClaudeProfileObject(source)
  if (existing.kind === 'unavailable' || input.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Claude settings.json is unreadable')
  }
  const config = existing.kind === 'present' ? { ...existing.value } : {}
  const desired = pickSettings(input.kind === 'present' ? input.value : {})
  const written = { ...ledger.keys['settings.json'] }
  if ('statusLine' in desired && isManagedStatusLine(config.statusLine)) {
    // Why: the profile's managed line is the installer's, so a user's own line from the default replaces it.
    written.statusLine = JSON.stringify(config.statusLine)
  }
  const changed = mergeClaudeProfileKeys(config, desired, written)
  if (changed) {
    writeFileAtomically(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  }
  // Committed only after the write, so a failed write never marks an unwritten value as shared.
  ledger.keys['settings.json'] = written
  return changed ? 'merged' : existing.kind === 'absent' ? 'absent' : 'unchanged'
}

async function mergeState(args: {
  source: string
  target: string
  ledger: ClaudeProfileLedger
  trustKeys: readonly string[]
  report: ClaudeProfileReport
}): Promise<ClaudeProfileSurfaceOutcome> {
  if (isLink(args.target)) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(args.source)
  if (input.kind === 'unavailable') {
    // Why: onboarding and trust don't depend on the personal state; only its shared keys wait.
    const error = new ClaudeProfileSurfaceError('unreadable', 'Personal Claude state is unreadable')
    warnClaudeProfile(args.report, '.claude.json', error)
  }
  const source = input.kind === 'present' ? input.value : {}
  const desired = Object.fromEntries(
    SHARED_STATE_KEYS.filter((key) => key in source).map((key) => [key, source[key]])
  )
  let written: Record<string, string> = {}
  const outcome = await updateClaudeGlobalConfig(args.target, (current) => {
    const config = { ...current }
    written = { ...args.ledger.keys['.claude.json'] }
    let changed = mergeClaudeProfileKeys(config, desired, written)
    // Why: otherwise first launch opens the onboarding wizard, where a stray Enter starts a login that rebinds the profile.
    if (config.hasCompletedOnboarding !== true) {
      config.hasCompletedOnboarding = true
      changed = true
    }
    const trust = args.trustKeys.length > 0 ? applyClaudeFolderTrust(config, args.trustKeys) : null
    if (trust && trust.kind !== 'unchanged') {
      return trust
    }
    return changed ? { kind: 'changed', config } : { kind: 'unchanged' }
  })
  if (outcome === 'missing-config') {
    // Why: no state file means no completed login; writing one would fabricate an account.
    return 'absent'
  }
  if (outcome === 'locked' || outcome === 'unreadable') {
    throw new ClaudeProfileSurfaceError(outcome, `Profile Claude state is ${outcome}`)
  }
  args.ledger.keys['.claude.json'] = written
  return outcome === 'updated' ? 'merged' : 'unchanged'
}

/** Shares the personal ~/.claude config into a profile. Execution-host paths; never touches credentials. */
export async function provisionClaudeProfile(args: {
  profileHome: string
  userHome: string
  platform?: NodeJS.Platform
  trustKeys?: readonly string[]
}): Promise<ClaudeProfileReport> {
  assertOutsideDefaultClaudeHomes(args.profileHome, args.userHome)
  mkdirSync(args.profileHome, { recursive: true, mode: 0o700 })
  const platform = args.platform ?? process.platform
  const defaultHome = join(args.userHome, '.claude')
  const report = createClaudeProfileReport()
  const ledgerPath = join(args.profileHome, '.orca-profile.json')
  const { ledger, readable } = readClaudeProfileLedger(ledgerPath)
  const recorded = JSON.stringify(ledger)
  if (!readable) {
    const error = new ClaudeProfileSurfaceError(
      'unreadable',
      'Profile ledger was unreadable; reset'
    )
    warnClaudeProfile(report, 'ledger', error)
  }
  for (const name of CLAUDE_PROFILE_RESOURCE_DIRS) {
    await runClaudeProfileSurface(report, name, () =>
      linkClaudeProfileDirectory(join(defaultHome, name), join(args.profileHome, name), platform)
    )
  }
  await runClaudeProfileSurface(report, 'CLAUDE.md', () =>
    syncClaudeProfileFile(
      join(defaultHome, 'CLAUDE.md'),
      join(args.profileHome, 'CLAUDE.md'),
      'CLAUDE.md',
      ledger
    )
  )
  await runClaudeProfileSurface(report, 'settings.json', () =>
    mergeSettings(
      join(defaultHome, 'settings.json'),
      join(args.profileHome, 'settings.json'),
      ledger
    )
  )
  const statePath = (configDir: string | undefined): string =>
    resolveClaudeGlobalConfigFile({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: args.userHome,
      style: platform === 'win32' ? 'win32' : 'posix',
      exists: existsSync
    })
  await runClaudeProfileSurface(report, '.claude.json', () =>
    mergeState({
      source: statePath(undefined),
      target: statePath(args.profileHome),
      ledger,
      trustKeys: args.trustKeys ?? [],
      report
    })
  )
  await runClaudeProfileSurface(report, 'ledger', () => {
    if (readable && JSON.stringify(ledger) === recorded) {
      return 'unchanged'
    }
    writeFileAtomically(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    return 'synced'
  })
  return report
}
