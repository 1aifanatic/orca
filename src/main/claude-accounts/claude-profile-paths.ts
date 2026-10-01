import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ClaudeProfileTarget =
  | { executionHostId: string; runtime: 'host' }
  | { executionHostId: string; runtime: 'wsl'; distro: string }

export type ClaudeProfileDescriptor = {
  version: 1
  accountId: string
  target: ClaudeProfileTarget
  home: string
}

export type ClaudeProfileRead<T> =
  | { kind: 'present'; value: T }
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: unknown }

export function isMissingProfileFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isProfileObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readClaudeProfileObject(file: string): ClaudeProfileRead<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isProfileObject(value)) {
      throw new Error('Expected a profile JSON object')
    }
    return { kind: 'present', value }
  } catch (error) {
    return isMissingProfileFile(error) ? { kind: 'absent' } : { kind: 'unavailable', error }
  }
}

/** dataRoot belongs to the execution host (the guest's Orca data root for WSL). */
export function describeClaudeProfile(
  dataRoot: string,
  accountId: string,
  target: ClaudeProfileTarget
): ClaudeProfileDescriptor {
  if (!isAbsolute(dataRoot) || !/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error('Invalid Claude profile location')
  }
  if (!target.executionHostId || (target.runtime === 'wsl' && !target.distro)) {
    throw new Error('Claude profile requires an execution target')
  }
  return {
    version: 1,
    accountId,
    target,
    home: join(dataRoot, 'claude-profiles', accountId, 'home')
  }
}

/** Validate every existing component before creating anything beneath the trusted data root. */
export function prepareClaudeProfileDirectory(
  dataRoot: string,
  profile: ClaudeProfileDescriptor
): void {
  const expected = describeClaudeProfile(dataRoot, profile.accountId, profile.target)
  if (profile.version !== 1 || profile.home !== expected.home) {
    throw new Error('Claude profile does not match its account namespace')
  }
  assertClaudeProfileDescendant(dataRoot, profile.home)
  mkdirSync(profile.home, { recursive: true, mode: 0o700 })
}

export function assertClaudeProfileDescendant(root: string, destination: string): void {
  const suffix = relative(resolve(root), resolve(destination))
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('Claude profile destination escapes its root')
  }
  // The caller owns root; links below it must not redirect profile writes.
  let cursor = resolve(root)
  for (const part of suffix.split(sep)) {
    cursor = join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error('Claude profile path contains a link')
      }
    } catch (error) {
      if (!isMissingProfileFile(error)) {
        throw error
      }
    }
  }
}

export function assertDistinctClaudeProfile(profile: string, defaultHome: string): void {
  const canonical = (file: string): string => {
    try {
      return realpathSync(file)
    } catch (error) {
      if (!isMissingProfileFile(error)) {
        throw error
      }
      return resolve(file)
    }
  }
  const left = canonical(profile)
  const right = canonical(defaultHome)
  for (const [root, destination] of [
    [left, right],
    [right, left]
  ]) {
    if (root === undefined || destination === undefined) {
      throw new Error('Missing profile path')
    }
    const suffix = relative(root, destination)
    if (!suffix || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))) {
      throw new Error('Claude profile and default home must be separate directories')
    }
  }
}
