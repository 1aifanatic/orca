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
  return readClaudeIdentityReadiness(join(profile.home, '.claude.json'))
}

// Why: Claude's state file grows with history and readiness runs on every resolve.
const parsedIdentities = new Map<
  string,
  { mtimeMs: number; size: number; ino: number; readiness: ClaudeProfileReadiness }
>()

function readClaudeIdentityReadiness(file: string): ClaudeProfileReadiness {
  let stat: Stats
  try {
    stat = statSync(file)
  } catch (error) {
    parsedIdentities.delete(file)
    return isDefinitiveAbsence(error) ? 'sign-in-required' : 'unavailable'
  }
  const cached = parsedIdentities.get(file)
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
    return cached.readiness
  }
  const state = readClaudeProfileObject(file)
  if (state.kind !== 'present') {
    parsedIdentities.delete(file)
    return state.kind === 'absent' ? 'sign-in-required' : 'unavailable'
  }
  const { oauthAccount } = state.value
  const readiness =
    oauthAccount == null
      ? 'sign-in-required'
      : typeof oauthAccount === 'object' && !Array.isArray(oauthAccount)
        ? 'ready'
        : 'unavailable'
  // Only a parsed file is remembered; a failed read is retried next time.
  parsedIdentities.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, readiness })
  return readiness
}
