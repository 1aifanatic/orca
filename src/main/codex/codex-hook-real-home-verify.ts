import { tmpdir } from 'node:os'
import { getSystemCodexHomePath } from './codex-home-paths'
import { listCodexHooks } from './codex-hook-trust-derivation'
import type { RealHomeCodexHookReconcile } from './codex-real-home-hook-install'
import { readCodexStateDbBackfillPendingState } from './codex-state-db'
import {
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  type CodexTrustEntry
} from './config-toml-trust'

export type CodexHookVerification = 'trusted' | 'rejected' | 'lost' | 'unverified'

/**
 * One read-only `hooks/list` against ~/.codex after a write. 'rejected' only
 * when Codex hashes Orca's entry differently from the approval; a matching but
 * untrusted listing means another writer dropped the approval ('lost'), and an
 * entry a concurrent edit moved proves nothing either way.
 */
export async function verifyRealHomeCodexHook(
  codexPath: string,
  result: RealHomeCodexHookReconcile
): Promise<CodexHookVerification> {
  const systemHome = getSystemCodexHomePath()
  if (readCodexStateDbBackfillPendingState(systemHome) !== 'not-pending') {
    // Why: an app-server start can refresh Codex's abandoned backfill lease and strand every pane.
    return 'unverified'
  }
  try {
    // Why the same home spelling as panes: an explicit CODEX_HOME keys entries by its real path.
    const explicitHome = process.env.CODEX_HOME?.trim() ? systemHome : null
    const listings = await listCodexHooks(codexPath, explicitHome, tmpdir())
    const byKey = new Map(
      listings.map((listing) => [normalizeHookTrustKeyForLookup(listing.key), listing])
    )
    const slots = new Map<string, CodexHookVerification>()
    for (const entry of result.approvals) {
      const slot = `${entry.eventLabel}:${entry.groupIndex}:${entry.handlerIndex}`
      const listing = byKey.get(normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
      if (listing?.command !== entry.command) {
        continue
      }
      slots.set(slot, readListing(listing, entry))
    }
    const outcomes = [...slots.values()]
    for (const outcome of ['rejected', 'lost'] as const) {
      if (outcomes.includes(outcome)) {
        return outcome
      }
    }
    const listedSlots = new Set(
      result.approvals.map(
        (entry) => `${entry.eventLabel}:${entry.groupIndex}:${entry.handlerIndex}`
      )
    )
    return outcomes.length === listedSlots.size &&
      outcomes.every((outcome) => outcome === 'trusted')
      ? 'trusted'
      : 'unverified'
  } catch (error) {
    console.warn('[codex-hook-reconcile] could not verify Orca entries with Codex:', error)
    return 'unverified'
  }
}

function readListing(
  listing: { trustStatus: string; currentHash: string; enabled: boolean | null },
  entry: CodexTrustEntry
): CodexHookVerification {
  if (listing.trustStatus === 'trusted') {
    return listing.enabled === false ? 'unverified' : 'trusted'
  }
  return listing.currentHash === entry.trustedHash ? 'lost' : 'rejected'
}
