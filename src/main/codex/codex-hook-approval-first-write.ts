import {
  computeTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'

/** The approvals among `approvals` that config.toml does not already hold as given. */
export function findMissingCodexHookApprovals(
  approvals: readonly CodexTrustEntry[],
  trustStates: ReadonlyMap<string, CodexHookTrustState>
): CodexTrustEntry[] {
  return approvals.filter((entry) => {
    const state = trustStates.get(computeTrustKey(entry))
    return state?.trustedHash !== entry.trustedHash || state.enabled !== entry.enabled
  })
}

/**
 * Writes Orca's approvals, then its entries through `writeEntries`. When that
 * throws, the approvals this call changed go back to what they were, and the
 * error is rethrown: Orca's own writes never leave its entry unapproved, nor
 * an approval for an entry it did not write.
 */
export function writeCodexHookApprovalsBeforeEntries(
  tomlPath: string,
  approvals: readonly CodexTrustEntry[],
  writeEntries: () => void
): void {
  const before = readHookTrustEntries(tomlPath)
  const changed = findMissingCodexHookApprovals(approvals, before)
  upsertHookTrustEntries(tomlPath, changed)
  try {
    writeEntries()
  } catch (error) {
    restoreCodexHookApprovals(tomlPath, changed, before)
    throw error
  }
}

function restoreCodexHookApprovals(
  tomlPath: string,
  changed: readonly CodexTrustEntry[],
  before: ReadonlyMap<string, CodexHookTrustState>
): void {
  try {
    removeHookTrustEntries(
      tomlPath,
      changed.map((entry) => computeTrustKey(entry))
    )
    upsertHookTrustEntries(
      tomlPath,
      changed.flatMap((entry) => {
        const state = before.get(computeTrustKey(entry))
        return state?.trustedHash
          ? [{ ...entry, trustedHash: state.trustedHash, enabled: state.enabled }]
          : []
      })
    )
  } catch (error) {
    console.warn('[codex-hook-approvals] could not take back hook approvals:', error)
  }
}
