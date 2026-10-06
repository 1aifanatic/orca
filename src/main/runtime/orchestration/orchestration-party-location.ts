// Where a party named by its mailbox address is now, so a chat can open a message's sender.

import type { OrchestrationPartyLocationResult } from '../../../shared/orchestration-caller-status'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

type PartyLocationDeps = {
  db: OrchestrationDb | null
  records: AgentSessionRecordReader | null
  /** Non-null only for a handle this runtime issued. */
  terminalPaneKey: (handle: string) => string | null
  terminalHandleForPaneKey: (paneKey: string) => string | null
}

/** `messageIds`: the mail the message carried from this party, whose sender pane outlives a
 *  handle a previous run issued. */
export function locateOrchestrationParty(
  address: string,
  deps: PartyLocationDeps,
  messageIds: readonly string[] = []
): OrchestrationPartyLocationResult {
  if (address.startsWith('dispatch:')) {
    return locateDispatchAssignee(address.slice('dispatch:'.length), deps)
  }
  let party: ReturnType<typeof resolveOrchestrationParty>
  try {
    party = resolveOrchestrationParty(address, deps.db)
  } catch {
    // A worker this host lost the identity of.
    return { location: null, lost: 'chat' }
  }
  if (party.orcaSessionId) {
    return locateSession(party.orcaSessionId, deps.records)
  }
  return party.terminalHandle
    ? locateTerminal(party.terminalHandle, deps, messageIds)
    : { location: null, lost: 'terminal' }
}

/** A handle is issued per run, so one from an earlier run is found again through the pane its mail
 *  was sent from, as mail delivery finds it. */
function locateTerminal(
  handle: string,
  deps: PartyLocationDeps,
  messageIds: readonly string[]
): OrchestrationPartyLocationResult {
  if (deps.terminalPaneKey(handle) !== null) {
    return { location: { kind: 'terminal', handle } }
  }
  for (const messageId of messageIds) {
    const message = deps.db?.getMessageById(messageId)
    const paneKey = message?.from_handle === handle ? message.sender_pane_key : null
    const live = paneKey ? deps.terminalHandleForPaneKey(paneKey) : null
    if (live) {
      return { location: { kind: 'terminal', handle: live } }
    }
  }
  return { location: null, lost: 'terminal' }
}

/** As mail to the dispatch is routed (mailbox-delivery-target.ts): its assignee's pane, else
 *  its recorded handle, else a remote attachment's. */
function locateDispatchAssignee(
  dispatchId: string,
  deps: PartyLocationDeps
): OrchestrationPartyLocationResult {
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
  return handle && !handle.startsWith('dispatch:')
    ? locateOrchestrationParty(handle, deps)
    : { location: null, lost: 'terminal' }
}

function locateSession(
  orcaSessionId: OrcaSessionId,
  records: AgentSessionRecordReader | null
): OrchestrationPartyLocationResult {
  const record = records ? lineageLiveSession(records, orcaSessionId) : null
  return record
    ? {
        location: {
          kind: 'chat',
          sessionId: record.sessionId,
          worktreeId: record.location.workspaceId
        }
      }
    : { location: null, lost: 'chat' }
}
