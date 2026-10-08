// A native chat's last status, saved with the agent status store so a restart lists every chat's
// status without opening its history. Only what outlives the host is kept: the agent, its Stop,
// its tools and its child work all end with the process.

import type { AgentSessionStatusSummary } from './agent-session-wire'
import { normalizeAgentProviderSession } from './agent-session-resume'
import { isAgentTurnOutcome } from './agent-turn-outcome'

export type SavedStructuredSessionStatus = {
  summary: AgentSessionStatusSummary
  /** The fence of the child that ran the turn, while one ran: its death proof is read against it. */
  turnFence?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function savedStatus(value: unknown): AgentSessionStatusSummary['status'] | undefined {
  return value === null || value === 'working' || value === 'attention' || value === 'idle'
    ? value
    : undefined
}

/** The summary's restart-proof fields, or null for anything malformed; saving and loading share it. */
export function savedStructuredSessionSummary(value: unknown): AgentSessionStatusSummary | null {
  if (!isRecord(value)) {
    return null
  }
  const status = savedStatus(value.status)
  const { sessionId, workspaceId, agent, latestPrompt, updatedAt, statusStartedAt } = value
  if (
    status === undefined ||
    typeof sessionId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof agent !== 'string' ||
    typeof latestPrompt !== 'string' ||
    !isTimestamp(updatedAt)
  ) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(value.providerSession)
  return {
    sessionId,
    workspaceId,
    agent,
    status,
    latestPrompt,
    ...(nonEmptyString(value.model) ? { model: value.model } : {}),
    ...(nonEmptyString(value.lastAssistantMessage)
      ? { lastAssistantMessage: value.lastAssistantMessage }
      : {}),
    ...(nonEmptyString(value.conversationName) ? { conversationName: value.conversationName } : {}),
    ...(nonEmptyString(value.launchDirectory) ? { launchDirectory: value.launchDirectory } : {}),
    ...(status === 'idle' && isAgentTurnOutcome(value.turnOutcome)
      ? { turnOutcome: value.turnOutcome }
      : {}),
    ...(providerSession ? { providerSession } : {}),
    updatedAt,
    ...(isTimestamp(statusStartedAt) ? { statusStartedAt } : {})
  }
}

export function parseSavedStructuredSessionStatus(
  sessionId: string,
  value: unknown
): SavedStructuredSessionStatus | null {
  const summary = isRecord(value) ? savedStructuredSessionSummary(value.summary) : null
  if (!isRecord(value) || summary?.sessionId !== sessionId) {
    return null
  }
  const { turnFence } = value
  return {
    summary,
    ...(typeof turnFence === 'number' && Number.isInteger(turnFence) ? { turnFence } : {})
  }
}

/** A save is owed when what a restart would show changes, never for a streamed delta. */
export function savedStructuredSessionStatusChanged(
  previous: AgentSessionStatusSummary | undefined,
  next: AgentSessionStatusSummary
): boolean {
  return !previous || previous.status !== next.status || previous.turnOutcome !== next.turnOutcome
}
