// The structured-chat step of host startup, before any client lists a tab: the restart lease check,
// then each listed chat's status seeded from its stored state, and every chat that owes work
// settled.

import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'

/** Named from the host so a rename fails to compile. Only the lease check is required: a host
 *  stand-in without stored state seeds and settles nothing, and lists the saved session's chats. */
export type StructuredAgentSessionStartupHost = Pick<
  StructuredAgentSessionHost,
  'reconcileRestartLeases'
> &
  StructuredAgentSessionListingHost &
  Partial<Pick<StructuredAgentSessionHost, 'seedStoredStatuses' | 'settleOwedSessions'>>

type StructuredAgentSessionListingHost = Partial<
  Pick<StructuredAgentSessionHost, 'getPersistedVisibleSessionTabIndex'>
>

/**
 * Answers the listed chats stored state could not answer, which the post-listing restore opens.
 * Death evidence the lease check writes must exist before the settle takes its verdicts; a failed
 * check leaves them `unverifiable`, which is safe, so the seed and settle still run and the failure
 * is thrown after them.
 */
export async function runStructuredAgentSessionStartupStep(
  host: StructuredAgentSessionStartupHost,
  savedSession: WorkspaceSessionState | null
): Promise<string[]> {
  let leaseFailure: { error: unknown } | null = null
  try {
    await host.reconcileRestartLeases()
  } catch (error) {
    leaseFailure = { error }
  }
  const listedIds = listedStructuredAgentSessionIds(host, savedSession)
  const background = host.seedStoredStatuses?.(listedIds) ?? listedIds
  // Un-awaited: nothing waits on a crashed chat's settle, and it never rejects.
  void host.settleOwedSessions?.(listedIds)
  if (leaseFailure) {
    throw leaseFailure.error
  }
  return background
}

/** The chats with a tab, for the startup step and the tab restore alike: the host's persisted tab
 *  index, or before it is recorded, the saved workspace session's. */
export function listedStructuredAgentSessionIds(
  host: StructuredAgentSessionListingHost | null,
  savedSession: WorkspaceSessionState | null
): string[] {
  const persistedVisibleIndex = host?.getPersistedVisibleSessionTabIndex?.() ?? {
    present: false,
    sessionIds: []
  }
  if (persistedVisibleIndex.present) {
    return persistedVisibleIndex.sessionIds
  }
  // Unrecorded, the profile's chats join the tabs chats opened while the import was owed left.
  // First: after a /clear the profile's chat would take their tab id, so seeds hit tabIdTaken.
  return [
    ...new Set([
      ...persistedVisibleIndex.sessionIds,
      ...collectSavedStructuredAgentSessionIds(savedSession)
    ])
  ]
}
