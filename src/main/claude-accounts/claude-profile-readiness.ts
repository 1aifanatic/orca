import { lstatSync } from 'node:fs'
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
  const state = readClaudeProfileObject(join(profile.home, '.claude.json'))
  if (state.kind === 'unavailable') {
    return 'unavailable'
  }
  if (state.kind === 'absent' || state.value.oauthAccount == null) {
    return 'sign-in-required'
  }
  return typeof state.value.oauthAccount === 'object' && !Array.isArray(state.value.oauthAccount)
    ? 'ready'
    : 'unavailable'
}
