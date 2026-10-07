/**
 * The launch record's three writes around a first prompt the host pastes into a terminal agent.
 *
 *   W1 owe    the agent's terminal exists, before any wait: the prompt is owed, with its text
 *   W2 begin  readiness and the write guard passed, immediately before the first byte: owed -> writing
 *   W3 clear  the launch settled: the text is gone
 *
 * W2 is the boundary a restart reads. A row still `owed` wrote nothing, so its prompt can be pasted
 * once; a row `writing` may have landed, so it is never pasted again and reads as unconfirmed.
 */

import {
  agentSessionOperationKey,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { AgentLaunchOwedPrompt } from '../../shared/agent-launch-owed-prompt'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { AgentSessionRecordStore } from './agent-session-record-store'

type OperationRows = { operations: Map<string, AgentSessionOperationRow> }

/** What W1 records about the prompt it owes. */
export type OwedLaunchPrompt = Omit<Extract<AgentLaunchOwedPrompt, { state: 'owed' }>, 'state'>

function readTerminal(value: unknown): OwedLaunchPrompt['terminal'] | undefined {
  if (value === null) {
    return null
  }
  if (
    typeof value === 'object' &&
    'ptyId' in value &&
    typeof value.ptyId === 'string' &&
    'incarnationId' in value &&
    (value.incarnationId === null || typeof value.incarnationId === 'string')
  ) {
    return { ptyId: value.ptyId, incarnationId: value.incarnationId }
  }
  return undefined
}

/**
 * How long a host that restarted may still finish an owed prompt. Covers the launch's own 60 s
 * readiness wait plus an app restart or update with room to spare; past it the user has moved on,
 * and a prompt pasted into an idle agent minutes later would be a surprise, not a delivery.
 */
export const OWED_LAUNCH_PROMPT_DEADLINE_MS = 5 * 60_000
type OperationRef = { callerKey: string; operationId: string }

/** What W2 found: the write is this caller's, another writer began it, the deadline passed (the
 *  window no longer waits for it, so nothing may write it), or the row cannot say. */
export type OwedLaunchPromptWriteStart = 'began' | 'taken' | 'expired' | 'absent'

/** The field as a row holds it, or null for a row that owes nothing or holds a value this build
 *  cannot read. */
export function readOwedLaunchPrompt(row: AgentSessionOperationRow): AgentLaunchOwedPrompt | null {
  const value: unknown = row.promptDelivery
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return null
  }
  if (
    value.state === 'owed' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'agent' in value &&
    isTuiAgent(value.agent) &&
    'deadline' in value &&
    typeof value.deadline === 'number' &&
    'terminal' in value
  ) {
    const terminal = readTerminal(value.terminal)
    return terminal === undefined
      ? null
      : { state: 'owed', text: value.text, agent: value.agent, deadline: value.deadline, terminal }
  }
  if (value.state === 'writing' && 'since' in value && typeof value.since === 'number') {
    return { state: 'writing', since: value.since }
  }
  return null
}

function updateRow(
  state: OperationRows,
  ref: OperationRef,
  update: (row: AgentSessionOperationRow) => AgentSessionOperationRow
): AgentSessionOperationRow | null {
  const key = agentSessionOperationKey(ref.callerKey, ref.operationId)
  const row = state.operations.get(key)
  if (!row) {
    return null
  }
  const next = update(row)
  state.operations = new Map(state.operations).set(key, next)
  return next
}

/** W1. */
export function oweLaunchPromptInto(
  state: OperationRows,
  ref: OperationRef,
  owed: OwedLaunchPrompt
): void {
  updateRow(state, ref, (row) => ({ ...row, promptDelivery: { state: 'owed', ...owed } }))
}

/** W2: a compare-and-set, so of two writers only the first may write. */
export function beginOwedLaunchPromptWriteInto(
  state: OperationRows,
  ref: OperationRef,
  now: number
): OwedLaunchPromptWriteStart {
  const row = state.operations.get(agentSessionOperationKey(ref.callerKey, ref.operationId))
  const owed = row ? readOwedLaunchPrompt(row) : null
  if (!owed) {
    return 'absent'
  }
  if (owed.state === 'writing') {
    return 'taken'
  }
  if (now > owed.deadline) {
    return 'expired'
  }
  // The text is no longer needed: nothing may write it again.
  updateRow(state, ref, (current) => ({
    ...current,
    promptDelivery: { state: 'writing', since: now }
  }))
  return 'began'
}

/** W3. */
export function clearOwedLaunchPromptInto(state: OperationRows, ref: OperationRef): void {
  updateRow(state, ref, (row) => {
    const { promptDelivery: _cleared, ...rest } = row
    return rest
  })
}

/**
 * Whether the launch's prompt is still on its way: any value, even one this build cannot read,
 * since only the settle (W3) removes the field. What depends on the prompt waits for this.
 */
export function launchPromptUnsettled(row: AgentSessionOperationRow): boolean {
  return row.promptDelivery !== undefined
}

/** Unexpired rows that still owe a prompt or may be writing one. */
export function listOwedLaunchPromptRows(
  rows: Iterable<AgentSessionOperationRow>,
  now: number
): { row: AgentSessionOperationRow; owed: AgentLaunchOwedPrompt }[] {
  const owing: { row: AgentSessionOperationRow; owed: AgentLaunchOwedPrompt }[] = []
  for (const row of rows) {
    const owed = row.expiresAt > now ? readOwedLaunchPrompt(row) : null
    if (owed) {
      owing.push({ row, owed })
    }
  }
  return owing
}

/** What a launch's answer does to its first prompt: owes it (W1) or clears it (W3). */
export type LaunchPromptSettlement = { owe: OwedLaunchPrompt } | 'clear'

export function settleLaunchPromptInto(
  state: OperationRows,
  ref: OperationRef,
  settlement: LaunchPromptSettlement
): void {
  if (settlement === 'clear') {
    clearOwedLaunchPromptInto(state, ref)
  } else {
    oweLaunchPromptInto(state, ref, settlement.owe)
  }
}

type OperationStore = Pick<AgentSessionRecordStore, 'transactOperations' | 'recordOperationOutcome'>

/**
 * A launch's answer and what becomes of its owed prompt, in one write: W1 with `owedPrompt`,
 * W3 without it.
 */
export function recordLaunchOutcome(
  store: OperationStore,
  args: OperationRef & {
    outcome: AgentSessionOperationOutcome
    owedPrompt?: OwedLaunchPrompt
  }
): Promise<void> {
  const { owedPrompt, ...settlement } = args
  return store.recordOperationOutcome({
    ...settlement,
    launchPrompt: owedPrompt ? { owe: owedPrompt } : 'clear'
  })
}

/** W2, committed before the caller writes a byte. */
export function beginOwedLaunchPromptWrite(
  store: Pick<AgentSessionRecordStore, 'transactOperations'>,
  ref: OperationRef,
  now: number
): Promise<OwedLaunchPromptWriteStart> {
  return store.transactOperations((draft) => beginOwedLaunchPromptWriteInto(draft, ref, now))
}

/** Launches this process may have written without a recorded W2, until their deadline could pass. */
const unrecordedWrites = new Map<string, number>()

/** A live launch's W2 failed, and its write goes ahead anyway (bookkeeping never gates it). */
export function rememberUnrecordedLaunchPromptWrite(ref: OperationRef, now: number): void {
  for (const [key, until] of unrecordedWrites) {
    if (until < now) {
      unrecordedWrites.delete(key)
    }
  }
  unrecordedWrites.set(
    agentSessionOperationKey(ref.callerKey, ref.operationId),
    now + OWED_LAUNCH_PROMPT_DEADLINE_MS
  )
}

/** Whether this process may already have written the launch's prompt though its row says owed. */
export function launchPromptMayHaveBeenWritten(ref: OperationRef): boolean {
  return unrecordedWrites.has(agentSessionOperationKey(ref.callerKey, ref.operationId))
}

export function resetUnrecordedLaunchPromptWritesForTests(): void {
  unrecordedWrites.clear()
}
