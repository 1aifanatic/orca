import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { DaemonSessionInfo } from '../daemon/types'
import {
  listPerGeneration,
  USER_FACING_DAEMON_LISTING_TIMEOUT_MS
} from '../daemon/daemon-generation-listing'
import { describeListingError } from '../providers/pty-process-source-listing'

export type DaemonAdapterSet = { adapters: DaemonPtyAdapter[]; current: DaemonPtyAdapter | null }

/** A listed session plus whether this app attached it, i.e. whether a tab can be backed by it. */
export type ManagedDaemonSession = DaemonSessionInfo & { attached: boolean }

/**
 * One daemon protocol generation and what this process actually knows about it, in the contact
 * words of docs/reference/ssh-execution-boundary.md. An `unverifiable` generation carries no
 * session list: an empty array would read as a counted zero.
 */
export type DaemonGenerationInventory = { protocolVersion: number; isCurrent: boolean } & (
  | { contact: 'live'; sessions: ManagedDaemonSession[] }
  | { contact: 'exited' }
  | { contact: 'unverifiable'; reason: 'listing-failed'; detail: string | null }
)

/** Lists each generation under one user-facing deadline; a silent one never withholds the rest. */
export async function collectGenerations(
  { adapters, current }: DaemonAdapterSet,
  deadlineMs = Date.now() + USER_FACING_DAEMON_LISTING_TIMEOUT_MS
): Promise<DaemonGenerationInventory[]> {
  const listings = await listPerGeneration(
    adapters,
    (adapter) => adapter.readSessions({ deadlineMs }),
    deadlineMs
  )
  return listings.map(({ source: adapter, ...listing }): DaemonGenerationInventory => {
    const generation = { protocolVersion: adapter.protocolVersion, isCurrent: adapter === current }
    if (listing.contact === 'unverifiable') {
      return {
        ...generation,
        contact: 'unverifiable',
        reason: 'listing-failed',
        detail: describeListingError(listing.error)
      }
    }
    if (listing.contact === 'exited') {
      return { ...generation, contact: 'exited' }
    }
    return {
      ...generation,
      contact: 'live',
      sessions: listing.items.map<ManagedDaemonSession>((s) => ({
        ...s,
        protocolVersion: adapter.protocolVersion,
        // Why: only the adapter this app attached answers hasPty, so a same-id copy in another version reads false.
        attached: adapter.hasPty(s.sessionId)
      }))
    }
  })
}
