/**
 * Lets an SSH host's relayed `orca` CLI take part in orchestration as that host's own terminals.
 *
 * Without the per-target opt-in, the caller (`from` / `terminal`) must be a terminal on the bridged
 * host. A party outside the host is reachable only as the coordinator of a Dispatch the caller works
 * on, so a worker reports back to whoever dispatched it but cannot message or read anyone else.
 * Routing stores mail under `run:`/`dispatch:` addresses, so ownership is resolved to those exact
 * mailboxes the caller's live pane reads, never to a Run it merely shares.
 */
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import {
  resolveTerminalOwnedMailboxes,
  type TerminalOwnedMailboxes
} from './methods/orchestration/messaging/terminal-owned-mailboxes'

export type SshBridgeOrchestrationRuntime = OrcaRuntimeService

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
  const owned = resolveTerminalOwnedMailboxes(runtime, db, caller)
  if (methodName === 'orchestration.reply') {
    const id = readStringParam(params, 'id') ?? ''
    const original = db.getMessageById(id)
    return original && owned.addresses.has(original.to_handle) && (!run || run === original.run_id)
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
  if (
    !to ||
    (ownDispatch?.creator_handle && to === ownDispatch.creator_handle) ||
    (await isOwnCanonicalRecipient(db, owned, isOwnTerminal, to))
  ) {
    return null
  }
  return (await isOwnTerminal(to)) ? null : `recipient '${to}'`
}

// A canonical address is in scope when it is the caller's own mailbox, the Run mailbox its held
// Dispatch reports to, or a same-host worker's Dispatch in the Run the caller coordinates.
async function isOwnCanonicalRecipient(
  db: OrchestrationDb,
  owned: TerminalOwnedMailboxes,
  isOwnTerminal: (handle: string) => Promise<boolean>,
  to: string
): Promise<boolean> {
  if (owned.addresses.has(to) || (owned.dispatch && to === `run:${owned.dispatch.run_id}`)) {
    return true
  }
  if (!to.startsWith('dispatch:') || owned.runId === undefined) {
    return false
  }
  const dispatch = db.getDispatchContextById(to.slice('dispatch:'.length))
  return (
    dispatch?.run_id === owned.runId &&
    dispatch.assignee_handle !== null &&
    (await isOwnTerminal(dispatch.assignee_handle))
  )
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
