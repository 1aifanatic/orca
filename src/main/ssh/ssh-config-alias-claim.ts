import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeSshConfigAlias } from '../../shared/ssh-config-alias'
import { expandSshConfigIncludes, type SshConfigIncludeSkip } from './ssh-config-include-expander'
import { parseSshConfigAliasClaims, type SshConfigAliasClaims } from './ssh-config-parser'

/**
 * Whether anything in the user's ssh_config could claim this alias — i.e. whether a `Host` or
 * `Match` block other than a bare catch-all applies to it.
 *
 * Sound in the negative direction only. `false` means the parsed config proves nothing claims the
 * alias; every uncertainty (unreadable file, any `Match` block, any negated `Host` group, any
 * pattern that might match)
 * answers `true`, because "we could not tell" must never be read as "no block exists". Callers use
 * `false` as licence to override what OpenSSH would resolve, so a wrong `false` breaks a config the
 * user explicitly wrote, which is worse than the routing bug it exists to fix.
 */
export function sshConfigMayClaimAlias(
  alias: string,
  claims: SshConfigAliasClaims | null
): boolean {
  const normalizedAlias = normalizeSshConfigAlias(alias)
  if (!normalizedAlias || claims === null) {
    return true
  }
  // A Match block's criteria (exec, originalhost, user, …) are not modelled here, and one that
  // routes this alias is indistinguishable from one that does not.
  if (claims.hasMatchBlock) {
    return true
  }
  return claims.hostPatternGroups.some((patterns) =>
    // A negation makes the whole group uncertain: `Host * !prod` still routes every other alias,
    // so skipping both the catch-all and the `!` would answer "unclaimed" for one that is claimed.
    patterns.some((pattern) => pattern.startsWith('!'))
      ? true
      : patterns.some(
          (pattern) =>
            !isCatchAllHostPattern(pattern) && matchesHostPattern(pattern, normalizedAlias)
        )
  )
}

/** `Host *` — the block every alias matches, which is exactly the one that proves nothing. */
function isCatchAllHostPattern(pattern: string): boolean {
  return pattern.length > 0 && /^\*+$/.test(pattern)
}

function matchesHostPattern(pattern: string, normalizedAlias: string): boolean {
  let expression = ''
  for (const character of normalizeSshConfigAlias(pattern)) {
    if (character === '*') {
      expression += '.*'
    } else if (character === '?') {
      expression += '.'
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${expression}$`).test(normalizedAlias)
}

// Bounds how long an edit to an Included file can go unnoticed; buildSshArgs runs per remote
// command, so re-expanding Includes every time is not an option.
const CLAIM_CACHE_TTL_MS = 5_000

// The cached `claims` is nullable on purpose: doctrine remedy 2 (bound the entry) rather than
// remedy 1 (don't pin it). A config with one permanently unreadable Include would otherwise make
// every remote command re-walk ~/.ssh/config synchronously, forever.
let cachedClaims: { key: string; readAt: number; claims: SshConfigAliasClaims | null } | null = null

export function invalidateSshConfigAliasClaimCache(): void {
  cachedClaims = null
}

/**
 * Parse of `~/.ssh/config` (Includes expanded), or null when it cannot be read.
 *
 * Null and empty are different answers here: an absent or unreadable file -- or one whose Includes
 * could not all be read -- is the uncertainty case, while a fully readable config with no matching
 * block is the proof {@link sshConfigMayClaimAlias} needs.
 */
export function loadUserSshConfigAliasClaims(): SshConfigAliasClaims | null {
  const configPath = join(homedir(), '.ssh', 'config')
  try {
    // `existsSync` conflates "absent" with "could not stat", which is harmless here and nowhere
    // else in this sweep: both answers are `null`, the uncertainty state callers already read as
    // "may claim". An absent config genuinely claims nothing, but saying so would buy nothing --
    // the only consumer of a `false` claim sits behind `shouldUseOpenSshConfigHost`
    // (system-ssh-args.ts), and with no `~/.ssh/config` there is no config-backed target to reach
    // it. It would need a second return value nobody has a use for.
    if (!existsSync(configPath)) {
      return null
    }
    // Why key on the root file only: an edited Include can go unnoticed, so the cache also expires.
    const stats = statSync(configPath)
    const key = `${stats.mtimeMs}:${stats.size}`
    const now = Date.now()
    if (cachedClaims?.key === key && now - cachedClaims.readAt < CLAIM_CACHE_TTL_MS) {
      return cachedClaims.claims
    }
    const expansion = expandSshConfigIncludes(configPath)
    // A skipped Include is invisible to the mtime key above, so the hosts it would have contributed
    // are missing from `content` and a parse of it could answer "unclaimed" for an alias the user's
    // config does claim. Cache the uncertainty under the same TTL instead of the wrong answer.
    const claims = expansion.skippedIncludes.some(hidesHostBlocks)
      ? null
      : parseSshConfigAliasClaims(expansion.content)
    cachedClaims = { key, readAt: now, claims }
    return claims
  } catch {
    return null
  }
}

/**
 * Whether a skip could have hidden a `Host` block from this parse.
 *
 * `not-a-regular-file` could not: the glob matched a subdirectory, and OpenSSH reads no config out of
 * one either, so the expansion is complete for the pattern as written. Counting it would make a
 * `~/.ssh/config.d/backup/` — an ordinary thing to keep — permanently answer "may claim" for every
 * alias, which is the safe direction but never proves anything, and that is the bug in the other
 * direction. The picker still reports it; only this claim proof ignores it.
 *
 * Every other reason counts, `too-large` and `too-many-matches` and `unexpandable` included. Each
 * leaves a file OpenSSH would have read unread, so a `Host` block really may be missing, and a
 * confident `false` from this proof is licence to override what OpenSSH would resolve -- much worse
 * than an over-cautious `true`.
 */
function hidesHostBlocks(skip: SshConfigIncludeSkip): boolean {
  return skip.reason !== 'not-a-regular-file'
}

/** Convenience wrapper over the two above; used where the caller has no claims to inject. */
export function mayUserSshConfigClaimAlias(alias: string): boolean {
  return sshConfigMayClaimAlias(alias, loadUserSshConfigAliasClaims())
}
