import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  parseAgentSessionOperationTimestamp,
  type RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type {
  AgentSessionOperationOutcome,
  AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  readAgentSessionCreatedTerminal,
  readAgentSessionCreateTerminalTarget,
  type AgentSessionCreateTerminalTarget
} from './agent-session-create-terminal-target'
import { isAgentSessionOperationOutcomeUnknown } from './runtime-agent-launch-resolution'

/** What one attempt launches; derived fresh by every attempt that may spawn. */
export type PreparedAgentSessionCreate = {
  target: AgentSessionCreateTerminalTarget
  launch: (dispatched: () => void) => Promise<RuntimeTerminalCreate>
}

type CreateExecution = {
  openStore: () => Promise<AgentSessionRecordStore>
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
  prepare: () => Promise<PreparedAgentSessionCreate>
  reconcile: (target: AgentSessionCreateTerminalTarget) => Promise<RuntimeTerminalCreate | null>
  /** No durable row holds this create's answer, so the caller's in-memory entry must replay it. */
  fenceInMemory: () => void
}

function warnUnrecorded(error: unknown): void {
  console.warn('[agent-session-create] starting without a durable record', error)
}

async function replayCreate(
  args: CreateExecution,
  store: AgentSessionRecordStore,
  row: AgentSessionOperationRow
): Promise<RuntimeCreateAgentSessionResult> {
  const { outcome } = row
  const recorded =
    outcome.status === 'succeeded' ? readAgentSessionCreatedTerminal(outcome.terminalCreate) : null
  if (recorded) {
    return { terminal: recorded, disposition: 'replayed' }
  }
  const target = readAgentSessionCreateTerminalTarget(row.terminalTarget)
  let adopted: RuntimeTerminalCreate | null = null
  try {
    adopted = target ? await args.reconcile(target) : null
  } catch {
    // Contact loss never grants another spawn.
  }
  if (target && adopted) {
    const terminal = {
      ...adopted,
      tabId: target.tabId,
      paneKey: `${target.tabId}:${target.leafId}`
    }
    await recordOutcome(args, store, {
      status: 'succeeded',
      sessionId: '',
      terminalCreate: terminal
    })
    return { terminal, disposition: 'replayed' }
  }
  throw new Error(
    outcome.status === 'failed'
      ? (outcome.message ?? outcome.code)
      : outcome.status === 'unknown'
        ? (outcome.message ?? 'agent_session_operation_unknown')
        : 'agent_session_operation_unknown'
  )
}

/** Best-effort: the claim already fences replay. False when nothing was written. */
async function recordOutcome(
  args: CreateExecution,
  store: AgentSessionRecordStore,
  outcome: AgentSessionOperationOutcome
): Promise<boolean> {
  try {
    await store.recordOperationOutcome({
      callerKey: args.callerKey,
      operationId: args.operationId,
      outcome
    })
    return true
  } catch (error) {
    console.warn('[agent-session-create] could not record outcome', error)
    return false
  }
}

/** `claimed` before a durable spawn, `unrecorded` when the write failed, or the row to replay. */
async function claimCreate(
  args: CreateExecution,
  store: AgentSessionRecordStore,
  terminalTarget: AgentSessionCreateTerminalTarget
): Promise<'claimed' | 'unrecorded' | AgentSessionOperationRow> {
  let admitted: Awaited<ReturnType<AgentSessionRecordStore['admitAndClaimOperation']>>
  try {
    admitted = await store.admitAndClaimOperation(
      {
        callerKey: args.callerKey,
        operationId: args.operationId,
        fingerprint: args.fingerprint,
        now: args.now,
        terminalTarget
      },
      (decision) =>
        decision.decision === 'admit' ||
        (decision.decision === 'replay' && decision.row.outcome.status === 'pending')
    )
  } catch (error) {
    warnUnrecorded(error)
    return 'unrecorded'
  }
  const { decision, claim } = admitted
  if (decision.decision === 'refused') {
    throw new Error(decision.code)
  }
  if (claim?.claim === 'won') {
    return 'claimed'
  }
  if (claim?.claim === 'lost') {
    return claim.row
  }
  if (decision.decision === 'replay') {
    return decision.row
  }
  throw new Error('agent_session_operation_unknown')
}

/**
 * Bookkeeping never gates the user's start: when the store cannot be opened or written, the create
 * still runs, fenced in this process only, and loses nothing but its replay across a restart.
 */
export async function executeAgentSessionCreate(
  args: CreateExecution
): Promise<RuntimeCreateAgentSessionResult> {
  let store: AgentSessionRecordStore | null = null
  try {
    store = await args.openStore()
  } catch (error) {
    warnUnrecorded(error)
  }
  const found = store?.getOperationRow(args.callerKey, args.operationId)
  const existing = found && found.expiresAt > args.now ? found : null
  if (existing && store) {
    if (existing.fingerprint !== args.fingerprint) {
      throw new Error('agent_session_operation_conflict')
    }
    if (existing.outcome.status !== 'pending') {
      return replayCreate(args, store, existing)
    }
  } else {
    const timestamp = parseAgentSessionOperationTimestamp(args.operationId)
    if (timestamp === null) {
      throw new Error('agent_session_operation_invalid')
    }
    if (args.now - timestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      throw new Error('agent_session_operation_expired')
    }
  }
  // Why: a pending row proves nothing was dispatched, so its retry re-runs every check a first attempt does.
  const prepared = await args.prepare()
  let durable: AgentSessionRecordStore | null = null
  if (store) {
    const claim = await claimCreate(args, store, prepared.target)
    if (typeof claim === 'object') {
      return replayCreate(args, store, claim)
    }
    durable = claim === 'claimed' ? store : null
  }
  const settle = async (outcome: AgentSessionOperationOutcome): Promise<void> => {
    if (!durable || !(await recordOutcome(args, durable, outcome))) {
      args.fenceInMemory()
    }
  }
  let dispatched = false
  try {
    const terminal = await prepared.launch(() => {
      dispatched = true
    })
    await settle({ status: 'succeeded', sessionId: '', terminalCreate: terminal })
    return { terminal, disposition: 'created' }
  } catch (error) {
    if (dispatched || isAgentSessionOperationOutcomeUnknown(error)) {
      await settle({
        status: 'unknown',
        message: error instanceof Error ? error.message : String(error)
      })
    } else if (durable) {
      await recordOutcome(args, durable, { status: 'pending' })
    }
    throw error
  }
}
