// Where a party named by its mailbox address is now, so a chat can open a message's sender.

import type { OrchestrationPartyLocation } from '../../../shared/orchestration-caller-status'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

type PartyLocationDeps = {
  db: OrchestrationDb | null
  records: AgentSessionRecordReader | null
  terminalHandleForPaneKey: (paneKey: string) => string | null
}

export function locateOrchestrationParty(
  address: string,
  deps: PartyLocationDeps
): OrchestrationPartyLocation | null {
  if (address.startsWith('dispatch:')) {
    return locateDispatchAssignee(address.slice('dispatch:'.length), deps)
  }
  let party: ReturnType<typeof resolveOrchestrationParty>
  try {
    party = resolveOrchestrationParty(address, deps.db)
  } catch {
    // A worker this host lost the identity of.
    return null
  }
  if (party.orcaSessionId) {
    return locateSession(party.orcaSessionId, deps.records)
  }
  return party.terminalHandle ? { kind: 'terminal', handle: party.terminalHandle } : null
}

/** As mail to the dispatch is routed (mailbox-delivery-target.ts): its assignee's pane, else
 *  its recorded handle, else a remote attachment's. */
function locateDispatchAssignee(
  dispatchId: string,
  deps: PartyLocationDeps
): OrchestrationPartyLocation | null {
  const dispatch = deps.db?.getDispatchContextById(dispatchId)
  if (dispatch?.assignee_orca_session_id) {
    return locateSession(dispatch.assignee_orca_session_id, deps.records)
  }
  const remote = dispatch ? undefined : deps.db?.getRemoteDispatchAttachment(dispatchId)
  const paneKey = dispatch?.assignee_pane_key ?? remote?.pane_key
  const handle =
    (paneKey ? deps.terminalHandleForPaneKey(paneKey) : null) ??
    dispatch?.assignee_handle ??
    remote?.terminal_handle
  return handle && !handle.startsWith('dispatch:') ? locateOrchestrationParty(handle, deps) : null
}

function locateSession(
  orcaSessionId: OrcaSessionId,
  records: AgentSessionRecordReader | null
): OrchestrationPartyLocation | null {
  const record = records ? lineageLiveSession(records, orcaSessionId) : null
  return record
    ? { kind: 'chat', sessionId: record.sessionId, worktreeId: record.location.workspaceId }
    : null
}
