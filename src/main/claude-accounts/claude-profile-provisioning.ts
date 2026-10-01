import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  applyClaudeFolderTrust,
  resolveClaudeGlobalConfigFile
} from '../claude/claude-folder-trust-file'
import {
  assertDistinctClaudeProfile,
  isMissingProfileFile,
  readClaudeProfileObject
} from './claude-profile-paths'
import {
  linkClaudeProfileDirectory,
  mergeClaudeProfileKeys,
  readClaudeProfileLedger,
  syncClaudeProfileFile,
  type ClaudeProfileLedger,
  type ProfileSurfaceOutcome
} from './claude-profile-sharing'

const RESOURCE_DIRS = ['skills', 'plugins', 'agents', 'commands', 'output-styles'] as const
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

function pickSettings(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !PRIVATE_KEYS.has(key))
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

function mergeFile(args: {
  source: string
  target: string
  ledger: ClaudeProfileLedger
  state: boolean
  trustKeys: readonly string[]
}): ProfileSurfaceOutcome {
  try {
    if (lstatSync(args.target).isSymbolicLink()) {
      return 'user-owned'
    }
  } catch (error) {
    if (!isMissingProfileFile(error)) {
      throw error
    }
  }
  const existing = readClaudeProfileObject(args.target)
  if (existing.kind === 'unavailable') {
    throw existing.error
  }
  if (args.state && existing.kind === 'absent') {
    return 'absent'
  }
  const source = readClaudeProfileObject(args.source)
  if (source.kind === 'unavailable') {
    throw source.error
  }
  const config = existing.kind === 'present' ? existing.value : {}
  const input = source.kind === 'present' ? source.value : {}
  const desired = args.state
    ? Object.fromEntries(
        Object.entries(input).filter(([key]) => key === 'mcpServers' || key === 'theme')
      )
    : pickSettings(input)
  const written = args.ledger.keys[args.target] ?? {}
  let changed = mergeClaudeProfileKeys(config, desired, written)
  args.ledger.keys[args.target] = written
  if (args.state && config.hasCompletedOnboarding !== true) {
    config.hasCompletedOnboarding = true
    changed = true
  }
  const trust =
    args.state && args.trustKeys.length > 0
      ? applyClaudeFolderTrust(config, args.trustKeys)
      : { kind: 'unchanged' as const }
  if (trust.kind === 'refuse') {
    throw new Error('Profile project trust state is unreadable')
  }
  if (trust.kind === 'changed') {
    changed = true
  }
  if (!changed) {
    return existing.kind === 'absent' ? 'absent' : 'unchanged'
  }
  writeFileAtomically(
    args.target,
    `${JSON.stringify(trust.kind === 'changed' ? trust.config : config, null, 2)}\n`,
    { mode: 0o600 }
  )
  return 'merged'
}

/** Explicit execution-host paths only; callers schedule this after login, never while copying auth. */
export function provisionClaudeProfile(args: {
  profileHome: string
  userHome: string
  platform?: NodeJS.Platform
  trustKeys?: readonly string[]
}): { surfaces: Record<string, ProfileSurfaceOutcome>; warnings: Record<string, string> } {
  const defaultHome = join(args.userHome, '.claude')
  assertDistinctClaudeProfile(args.profileHome, defaultHome)
  assertDistinctClaudeProfile(args.profileHome, join(args.userHome, '.config', 'claude'))
  mkdirSync(args.profileHome, { recursive: true, mode: 0o700 })
  const ledgerPath = join(args.profileHome, '.orca-profile.json')
  try {
    if (lstatSync(ledgerPath).isSymbolicLink()) {
      throw new Error('Profile ledger is user-owned')
    }
  } catch (error) {
    if (!isMissingProfileFile(error)) {
      throw error
    }
  }
  const ledger = readClaudeProfileLedger(ledgerPath)
  const surfaces: Record<string, ProfileSurfaceOutcome> = {}
  const warnings: Record<string, string> = {}
  const attempt = (name: string, operation: () => ProfileSurfaceOutcome): void => {
    try {
      surfaces[name] = operation()
    } catch (error) {
      warnings[name] = error instanceof Error ? error.message : String(error)
    }
  }
  for (const name of RESOURCE_DIRS) {
    attempt(name, () =>
      linkClaudeProfileDirectory(
        join(defaultHome, name),
        join(args.profileHome, name),
        args.platform ?? process.platform
      )
    )
  }
  attempt('CLAUDE.md', () =>
    syncClaudeProfileFile(
      join(defaultHome, 'CLAUDE.md'),
      join(args.profileHome, 'CLAUDE.md'),
      ledger
    )
  )
  attempt('settings.json', () =>
    mergeFile({
      source: join(defaultHome, 'settings.json'),
      target: join(args.profileHome, 'settings.json'),
      ledger,
      state: false,
      trustKeys: []
    })
  )
  const statePath = (configDir: string | undefined): string =>
    resolveClaudeGlobalConfigFile({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: args.userHome,
      style: process.platform === 'win32' ? 'win32' : 'posix',
      exists: existsSync
    })
  attempt('.claude.json', () =>
    mergeFile({
      source: statePath(undefined),
      target: statePath(args.profileHome),
      ledger,
      state: true,
      trustKeys: args.trustKeys ?? []
    })
  )
  attempt('ledger', () => {
    writeFileAtomically(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    return 'synced'
  })
  return { surfaces, warnings }
}
