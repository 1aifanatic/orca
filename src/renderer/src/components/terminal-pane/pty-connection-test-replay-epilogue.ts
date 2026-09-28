import { expect } from 'vitest'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches a post-replay reset: the profile, then the mirror's kitty restore (a bare pop while unproven). */
export function replayEpilogue(profile: string): ReturnType<typeof expect.stringMatching> {
  return expect.stringMatching(
    new RegExp(`^${escapeRegExp(profile)}\\x1b\\[<99u(?:\\x1b\\[=\\d+u)?$`)
  )
}

export function isReplayEpilogue(data: unknown, profile: string): boolean {
  return typeof data === 'string' && replayEpilogue(profile).asymmetricMatch(data)
}
