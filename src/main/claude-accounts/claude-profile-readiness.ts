import { lstatSync, statSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { ClaudeProfileReadiness } from '../../shared/managed-account-types'
import {
  assertClaudeProfileDescendant,
  readClaudeProfileObject,
  type ClaudeProfileDescriptor
} from './claude-profile-paths'

/** Reads ownership and Claude's identity state, never a credential or a stored migration flag. */
export function readClaudeProfileOwnership(
  dataRoot: string,
  profile: ClaudeProfileDescriptor
): ClaudeProfileReadiness {
  try {
    assertClaudeProfileDescendant(dataRoot, profile.home)
    const markerPath = join(dirname(profile.home), 'profile.json')
    assertClaudeProfileDescendant(dataRoot, markerPath)
    const marker = readClaudeProfileObject(markerPath)
    if (marker.kind === 'absent') {
      return 'sign-in-required'
    }
    if (marker.kind === 'unavailable') {
      return 'unavailable'
    }
    if (
      marker.value.version !== 1 ||
      marker.value.accountId !== profile.accountId ||
      marker.value.runtime !== profile.target.runtime ||
      marker.value.distro !==
        (profile.target.runtime === 'wsl' ? profile.target.distro : undefined) ||
      !lstatSync(markerPath).isFile() ||
      !lstatSync(profile.home).isDirectory()
    ) {
      return 'unavailable'
    }
    return 'ready'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'sign-in-required' : 'unavailable'
  }
}

export function readClaudeProfileReadiness(
  dataRoot: string,
  profile: ClaudeProfileDescriptor
): ClaudeProfileReadiness {
  const ownership = readClaudeProfileOwnership(dataRoot, profile)
  if (ownership !== 'ready') {
    return ownership
  }
  return readClaudeLoginState(join(profile.home, '.claude.json')).readiness
}

/** The login Claude itself recorded in an owned profile; read-only and never a credential. */
export function readClaudeProfileIdentity(
  dataRoot: string,
  profile: ClaudeProfileDescriptor
): ClaudeLoginIdentity | null {
  return readClaudeProfileState(dataRoot, profile).identity
}

/** Readiness and identity from one ownership read and one (memoized) state-file read. */
export function readClaudeProfileState(
  dataRoot: string,
  profile: ClaudeProfileDescriptor
): ClaudeLoginState {
  const ownership = readClaudeProfileOwnership(dataRoot, profile)
  return ownership === 'ready'
    ? readClaudeLoginState(join(profile.home, '.claude.json'))
    : { readiness: ownership, identity: null }
}

export type ClaudeLoginIdentity = {
  email: string
  organizationUuid: string | null
  organizationName: string | null
}

export type ClaudeLoginState = {
  readiness: ClaudeProfileReadiness
  identity: ClaudeLoginIdentity | null
}

// Why: Claude's state file grows with history and readiness runs on every resolve.
const parsedLoginStates = new Map<
  string,
  { mtimeMs: number; size: number; ino: number; state: ClaudeLoginState }
>()

/** Reads a Claude state file's `oauthAccount`; present/absent/unavailable, parsed once per change. */
export function readClaudeLoginState(file: string): ClaudeLoginState {
  let stat: Stats
  try {
    stat = statSync(file)
  } catch (error) {
    parsedLoginStates.delete(file)
    return {
      readiness: isDefinitiveAbsence(error) ? 'sign-in-required' : 'unavailable',
      identity: null
    }
  }
  const cached = parsedLoginStates.get(file)
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
    return cached.state
  }
  const read = readClaudeProfileObject(file)
  if (read.kind !== 'present') {
    parsedLoginStates.delete(file)
    return {
      readiness: read.kind === 'absent' ? 'sign-in-required' : 'unavailable',
      identity: null
    }
  }
  const state = loginStateFrom(read.value.oauthAccount)
  // Only a parsed file is remembered; a failed read is retried next time.
  parsedLoginStates.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state })
  return state
}

function loginStateFrom(oauthAccount: unknown): ClaudeLoginState {
  if (oauthAccount == null) {
    return { readiness: 'sign-in-required', identity: null }
  }
  if (typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) {
    return { readiness: 'unavailable', identity: null }
  }
  const text = (key: string): string | null => {
    const value: unknown = Reflect.get(oauthAccount, key)
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const email = text('emailAddress')
  return {
    readiness: 'ready',
    identity: email
      ? {
          email,
          organizationUuid: text('organizationUuid'),
          organizationName: text('organizationName')
        }
      : null
  }
}
