import {
  computeTrustedHash,
  computeTrustKey,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'

/**
 * - 'trusted': the stored hash is the one Codex accepts now.
 * - 'untrusted': no stored hash, so Codex lists the entry for review.
 * - 'stale': a stored hash that is not the current one, e.g. after a Codex
 *   release changed how it hashes a hook. Codex lists it as modified.
 * - 'disabled': the user turned the entry off; never re-grant it.
 */
export type OrcaEntryTrust = 'trusted' | 'untrusted' | 'stale' | 'disabled'

export function readOrcaEntryTrust(
  entry: CodexTrustEntry,
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  currentHash: string = computeTrustedHash(entry)
): OrcaEntryTrust {
  const state = trustStates.get(computeTrustKey(entry))
  if (state?.enabled === false) {
    return 'disabled'
  }
  if (state?.trustedHash === undefined) {
    return 'untrusted'
  }
  return state.trustedHash === currentHash ? 'trusted' : 'stale'
}
