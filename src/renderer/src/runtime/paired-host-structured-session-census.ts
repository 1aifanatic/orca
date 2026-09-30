import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { markStructuredAgentSessionLaunchesPublished } from '@/lib/structured-agent-session-launch-publication'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  beginStructuredAgentSessionAuthoritativeInventory,
  startStructuredAgentLaunchCancellationCleanup
} from '@/lib/structured-agent-session-launch-cancellation'
import { readStructuredAgentLaunchCancellationTombstoneSessionIds } from '@/lib/structured-agent-session-launch-persistence'
import { retireAbsentStructuredAgentSessionLaunchCancellationTombstones } from '@/lib/structured-agent-session-launch-registry'
import { hostSnapshotAffirmsAgentSessions } from './host-session-snapshot-authority'
import { callRuntimeRpc } from './runtime-rpc-client'
import { closeStructuredAgentSession } from './structured-agent-session-close'
import { isSessionTabsListAllResult } from './web-session-tabs-sync/tracking'

/** The structured chats a host's snapshots show, keyed as launch bookkeeping reads them. */
export function publishedStructuredSessions(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): { worktreeId: string; sessionId: string }[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [{ worktreeId: snapshot.worktree, sessionId: tab.sessionId }]
        : []
    )
  )
}

/**
 * A paired host's tab inventory, read without applying it (that host's mirror stream does). It
 * settles that host's launch bookkeeping the way the local sync settles this machine's: its
 * publication settles launches, and its authoritative census is the only evidence that retires the
 * chats cancelled on it.
 */
export async function readPairedHostStructuredSessionTabs(
  environmentId: string
): Promise<RuntimeMobileSessionTabsResult[]> {
  const target = { kind: 'environment' as const, environmentId }
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  // Captured before the request, so a close that races the reply cannot be retired by it.
  const authoritativeInventory = beginStructuredAgentSessionAuthoritativeInventory()
  startStructuredAgentLaunchCancellationCleanup(executionHostId, (sessionId) =>
    closeStructuredAgentSession(target, sessionId)
  )
  const result = await callRuntimeRpc<unknown>(target, 'session.tabs.listAll', {})
  if (!isSessionTabsListAllResult(result)) {
    throw new Error('structured session inventory unavailable')
  }
  const published = publishedStructuredSessions(result.snapshots)
  markStructuredAgentSessionLaunchesPublished(executionHostId, published)
  if (result.authoritative === true && result.snapshots.every(hostSnapshotAffirmsAgentSessions)) {
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
      new Set(published.map(({ sessionId }) => sessionId)),
      authoritativeInventory,
      executionHostId
    )
  }
  return result.snapshots
}

const pairedHostCensusInFlight = new Set<string>()

/** Asks a paired host for its census while chats cancelled on it still wait for one. */
export function settlePairedHostStructuredLaunchCancellations(environmentId: string): void {
  if (
    pairedHostCensusInFlight.has(environmentId) ||
    readStructuredAgentLaunchCancellationTombstoneSessionIds(
      toRuntimeExecutionHostId(environmentId)
    ).length === 0
  ) {
    return
  }
  pairedHostCensusInFlight.add(environmentId)
  void readPairedHostStructuredSessionTabs(environmentId)
    .catch((error: unknown) => {
      console.warn('[structured-agent-launch] paired host census failed', error)
    })
    .finally(() => pairedHostCensusInFlight.delete(environmentId))
}
