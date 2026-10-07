/**
 * Lets an SSH host's relayed `orca` CLI take part in orchestration as that host's own terminals.
 *
 * Without the per-target opt-in, the caller (`from` / `terminal`) must be a terminal on the bridged
 * host. A party outside the host is reachable only as the coordinator of a Dispatch the caller works
 * on, so a worker reports back to whoever dispatched it but cannot message or read anyone else.
 */
import type { DispatchContextRow, MessageRow, RunRow } from '../orchestration/types'

type DispatchParty = Pick<
  DispatchContextRow,
  'run_id' | 'assignee_handle' | 'assignee_pane_key' | 'creator_handle'
>

export type SshBridgeOrchestrationLookup = {
  getDispatchContextById(id: string): DispatchParty | undefined
  getActiveDispatchForIdentity(handle: string, paneKey?: string): DispatchParty | undefined
  getRun(id: string): Pick<RunRow, 'coordinator_handle'> | undefined
  getMessageById(id: string): Pick<MessageRow, 'run_id' | 'to_handle'> | undefined
}

export type SshBridgeOrchestrationRuntime = {
  getTerminalPaneKey(handle: string): string | null
  getOrchestrationDb(): SshBridgeOrchestrationLookup
}

const TERMINAL_CALLER_METHODS: ReadonlySet<string> = new Set([
  'orchestration.check',
  'orchestration.inbox'
])

export const SSH_BRIDGE_ORCHESTRATION_METHODS: ReadonlySet<string> = new Set([
  ...TERMINAL_CALLER_METHODS,
  'orchestration.send',
  'orchestration.ask',
  'orchestration.reply'
])

/** The refused subject, or null when the call stays inside the caller's own orchestration. */
export async function findSshBridgeOrchestrationViolation(
  runtime: SshBridgeOrchestrationRuntime,
  isOwnTerminal: (handle: string) => Promise<boolean>,
  methodName: string,
  params: unknown
): Promise<string | null> {
  const callerKey = TERMINAL_CALLER_METHODS.has(methodName) ? 'terminal' : 'from'
  const caller = readStringParam(params, callerKey)
  if (!caller || !(await isOwnTerminal(caller))) {
    return `terminal '${caller ?? ''}'`
  }
  const paneKey = runtime.getTerminalPaneKey(caller) ?? undefined
  const claimedPane = readStringParam(
    params,
    methodName === 'orchestration.check' ? 'terminalPaneKey' : 'senderPaneKey'
  )
  // Why: the pane key is the lifecycle identity, so it must be the caller's own, not a sibling's.
  if (claimedPane && claimedPane !== paneKey) {
    return `pane '${claimedPane}'`
  }
  const db = runtime.getOrchestrationDb()
  const ownDispatch = db.getActiveDispatchForIdentity(caller, paneKey)
  const run = readStringParam(params, 'run')
  if (run && ownDispatch?.run_id !== run && db.getRun(run)?.coordinator_handle !== caller) {
    return `run '${run}'`
  }
  if (methodName === 'orchestration.reply') {
    const id = readStringParam(params, 'id') ?? ''
    const original = db.getMessageById(id)
    return original?.to_handle === caller && (!run || run === original.run_id)
      ? null
      : `message '${id}'`
  }
  if (TERMINAL_CALLER_METHODS.has(methodName)) {
    return null
  }
  const dispatchId = readPayloadDispatchId(params)
  if (dispatchId) {
    const named = db.getDispatchContextById(dispatchId)
    const party =
      named &&
      (named.assignee_handle === caller ||
        (paneKey !== undefined && named.assignee_pane_key === paneKey) ||
        named.creator_handle === caller)
    if (!party) {
      return `dispatch '${dispatchId}'`
    }
  }
  const to = readStringParam(params, 'to')
  if (!to || (ownDispatch?.creator_handle && to === ownDispatch.creator_handle)) {
    return null
  }
  return (await isOwnTerminal(to)) ? null : `recipient '${to}'`
}

function readPayloadDispatchId(params: unknown): string | null {
  const payload = readStringParam(params, 'payload')
  if (!payload) {
    return null
  }
  try {
    return readStringParam(JSON.parse(payload), 'dispatchId')
  } catch {
    // Why: the handler owns malformed-payload errors; nothing here can name a Dispatch.
    return null
  }
}

export function readStringParam(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null || !(key in params)) {
    return null
  }
  const value: unknown = Reflect.get(params, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}
