// Each chat's sends the host has not answered yet, in memory only: what the sender keeps and the
// chat's view reads.

import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'

export type StructuredAgentSessionPendingSend = {
  clientMessageId: string
  sessionId: string
  body: AgentJournalMessageItem
  previewUris: readonly string[]
  queuedAt: number
  delivery?: 'queue-if-active'
  /**
   * `sending`: out, or its same-id resend is due; the chat takes no other send meanwhile.
   * `recorded`: the host holds it and its row draws it; kept only so a Stop that withdraws it gives
   * the text back.
   */
  phase: 'sending' | 'recorded'
  /** An attempt under this id may have reached the host. */
  issued: boolean
  /** A sender outside the chat keeps its own copy, so nothing goes to the chat's composer. */
  callerKeepsText?: true
  /** Made while the chat read Stopping: drawn after that turn until the host records it. */
  sentWhileStopping?: true
  /** Each image's SSH connection, in body order, so a returned image still opens remotely. */
  imageConnectionIds?: readonly (string | null)[]
}

type SessionSends = {
  entries: readonly StructuredAgentSessionPendingSend[]
  /** Why the last message went back to the composer; cleared by the next send. */
  notice: string | null
  listeners: Set<() => void>
}

export const EMPTY_STRUCTURED_AGENT_SESSION_SENDS: readonly StructuredAgentSessionPendingSend[] = []
const sessions = new Map<string, SessionSends>()

function sessionSends(sessionId: string): SessionSends {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { entries: EMPTY_STRUCTURED_AGENT_SESSION_SENDS, notice: null, listeners: new Set() }
    sessions.set(sessionId, state)
  }
  return state
}

export function publishStructuredAgentSessionSends(
  sessionId: string,
  change: Partial<Omit<SessionSends, 'listeners'>>
): void {
  const state = sessionSends(sessionId)
  Object.assign(state, change)
  for (const listener of state.listeners) {
    listener()
  }
}

export function updateStructuredAgentSessionPendingSend(
  sessionId: string,
  clientMessageId: string,
  change: Partial<StructuredAgentSessionPendingSend> | null
): void {
  const state = sessionSends(sessionId)
  publishStructuredAgentSessionSends(sessionId, {
    entries: state.entries.flatMap((entry) =>
      entry.clientMessageId !== clientMessageId ? [entry] : change ? [{ ...entry, ...change }] : []
    )
  })
}

export function findStructuredAgentSessionPendingSend(
  sessionId: string,
  clientMessageId: string
): StructuredAgentSessionPendingSend | undefined {
  return sessions.get(sessionId)?.entries.find((entry) => entry.clientMessageId === clientMessageId)
}

/** What the chat's view reads: its pending sends and the line saying why one came back. */
export function getStructuredAgentSessionPendingSends(
  sessionId: string
): readonly StructuredAgentSessionPendingSend[] {
  return sessions.get(sessionId)?.entries ?? EMPTY_STRUCTURED_AGENT_SESSION_SENDS
}

/** A view of this chat is mounted, so something draws its sends. */
export function structuredAgentSessionSendsWatched(sessionId: string): boolean {
  return (sessions.get(sessionId)?.listeners.size ?? 0) > 0
}

/** A send of this chat is out and not yet settled: the chat takes no other until it is. */
export function structuredAgentSessionSendOut(sessionId: string): boolean {
  return getStructuredAgentSessionPendingSends(sessionId).some((entry) => entry.phase === 'sending')
}

export function getStructuredAgentSessionSendNotice(sessionId: string): string | null {
  return sessions.get(sessionId)?.notice ?? null
}

/** Says once, on the chat's line, why text came back to its composer. */
export function setStructuredAgentSessionSendNotice(sessionId: string, notice: string): void {
  publishStructuredAgentSessionSends(sessionId, { notice })
}

export function clearStructuredAgentSessionSendNotice(sessionId: string): void {
  if (sessions.get(sessionId)?.notice) {
    publishStructuredAgentSessionSends(sessionId, { notice: null })
  }
}

export function subscribeToStructuredAgentSessionPendingSends(
  sessionId: string,
  listener: () => void
): () => void {
  const state = sessionSends(sessionId)
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

/** Forgets a chat's sends, keeping its listeners. */
export function clearStructuredAgentSessionPendingSends(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (state) {
    publishStructuredAgentSessionSends(sessionId, {
      entries: EMPTY_STRUCTURED_AGENT_SESSION_SENDS,
      notice: null
    })
    if (state.listeners.size === 0) {
      sessions.delete(sessionId)
    }
  }
}

export function structuredAgentSessionsWithPendingSends(): string[] {
  return [...sessions.keys()]
}
