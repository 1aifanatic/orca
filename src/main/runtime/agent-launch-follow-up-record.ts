/**
 * Taking a click's follow-up off its launch's row (`agent-launch-follow-up`).
 *
 * Taken once its prompt has settled, in the same write that removes it, so whoever takes it is the
 * one runner: a window that crashes between taking and running loses the follow-up, never repeats
 * it. A follow-up still waiting on its prompt is reported, never removed.
 */

import {
  isAgentLaunchFollowUp,
  type AgentLaunchFollowUpTake
} from '../../shared/agent-launch-follow-up'
import { isAgentLaunchResult } from '../../shared/agent-launch-intent'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { launchPromptUnsettled, readOwedLaunchPrompt } from './agent-launch-owed-prompt-record'

type OperationRows = { operations: Map<string, AgentSessionOperationRow> }

/** Whether the launch has handed its prompt over, or never will; null while it still may. */
function settledPrompt(
  row: AgentSessionOperationRow,
  isLaunchRunning: (operationKey: string) => boolean
): { handedOver: boolean; composerUnobserved: boolean } | null {
  if (launchPromptUnsettled(row)) {
    return null
  }
  const { outcome } = row
  if (outcome.status === 'succeeded') {
    const prompt = isAgentLaunchResult(outcome.launch) ? outcome.launch.prompt : undefined
    return prompt?.outcome === 'handed-to-terminal'
      ? { handedOver: true, composerUnobserved: prompt.composerUnobserved === true }
      : { handedOver: false, composerUnobserved: false }
  }
  // A claimed launch this process no longer runs died before it recorded anything: its prompt was
  // never handed over, and waiting for it would hold its follow-up until the row expires.
  if (
    outcome.status !== 'failed' &&
    isLaunchRunning(agentSessionOperationKey(row.callerKey, row.operationId))
  ) {
    return null
  }
  return { handedOver: false, composerUnobserved: false }
}

export function takeLaunchFollowUpsInto(
  state: OperationRows,
  args: {
    callerKey: string
    operationId?: string
    now: number
    isLaunchRunning: (operationKey: string) => boolean
  }
): AgentLaunchFollowUpTake {
  const take: AgentLaunchFollowUpTake = { taken: [], pending: [] }
  let next: Map<string, AgentSessionOperationRow> | null = null
  for (const [key, row] of state.operations) {
    const followUp: unknown = row.launchFollowUp
    if (
      row.callerKey !== args.callerKey ||
      row.expiresAt <= args.now ||
      (args.operationId !== undefined && row.operationId !== args.operationId) ||
      !isAgentLaunchFollowUp(followUp)
    ) {
      continue
    }
    const settled = settledPrompt(row, args.isLaunchRunning)
    if (!settled) {
      const owed = readOwedLaunchPrompt(row)
      take.pending.push({
        operationId: row.operationId,
        followUp,
        ...(owed?.state === 'owed' ? { deadline: owed.deadline } : {})
      })
      continue
    }
    take.taken.push({
      operationId: row.operationId,
      followUp,
      promptHandedOver: settled.handedOver,
      composerUnobserved: settled.composerUnobserved
    })
    const { launchFollowUp: _taken, ...rest } = row
    next ??= new Map(state.operations)
    next.set(key, rest)
  }
  if (next) {
    state.operations = next
  }
  return take
}

/** The launches whose follow-up now waits only on its caller to take it. */
export function listSettledLaunchFollowUps(
  rows: Iterable<AgentSessionOperationRow>,
  callerKey: string,
  now: number
): string[] {
  const settled: string[] = []
  for (const row of rows) {
    if (
      row.callerKey === callerKey &&
      row.expiresAt > now &&
      isAgentLaunchFollowUp(row.launchFollowUp) &&
      !launchPromptUnsettled(row)
    ) {
      settled.push(row.operationId)
    }
  }
  return settled
}
