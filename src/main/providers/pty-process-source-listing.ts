import type { PtyProcessInfo } from './pty-process-info'
import type { IPtyProvider } from './pty-provider-contract'

/**
 * One process source's answer to a listing: a daemon protocol version, or (`protocolVersion`
 * null) the in-process provider. The contact words are the ones fixed in
 * docs/reference/ssh-execution-boundary.md; a source that did not answer carries no process list,
 * because an empty one would read as a counted zero.
 */
export type PtyProcessSourceListing = {
  protocolVersion: number | null
  isCurrent: boolean
} & (
  | { contact: 'live'; processes: PtyProcessInfo[] }
  | { contact: 'exited' }
  | {
      contact: 'unverifiable'
      error: unknown
      /** Ids this app last knew the source to hold: its routes plus the ids it attached. */
      lastKnownIds: string[]
    }
)

/** Today's fail-closed contract: every source must have answered, else the first silence throws. */
export function requireCompleteProcessListing(
  listings: readonly PtyProcessSourceListing[]
): PtyProcessInfo[] {
  const processes: PtyProcessInfo[] = []
  for (const listing of listings) {
    if (listing.contact === 'unverifiable') {
      throw listing.error
    }
    if (listing.contact === 'live') {
      for (const process of listing.processes) {
        processes.push(process)
      }
    }
  }
  return processes
}

export function answeredProcesses(listings: readonly PtyProcessSourceListing[]): PtyProcessInfo[] {
  return listings.flatMap((listing) => (listing.contact === 'live' ? listing.processes : []))
}

export function describeListingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lists what answered, reporting each silent source; a single-source provider lists as before. */
export async function listAnsweredProcesses(
  provider: IPtyProvider,
  onUnverifiable: (source: { protocolVersion: number | null; reason: string }) => void,
  nonCurrentDeadlineMs: number
): Promise<PtyProcessInfo[]> {
  if (!provider.listProcessesBySource) {
    return await provider.listProcesses()
  }
  // Why no deadline for the current version: a slow one must not read as silent to the activation gate.
  const listings = await provider.listProcessesBySource({ nonCurrentDeadlineMs })
  for (const listing of listings) {
    if (listing.contact === 'unverifiable') {
      onUnverifiable({
        protocolVersion: listing.protocolVersion,
        reason: describeListingError(listing.error)
      })
    }
  }
  return answeredProcesses(listings)
}
