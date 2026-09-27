import { randomUUID } from 'node:crypto'
import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import type { StructuredSessionCompactionResult } from '../native-chat/agent-session-wire/structured-session-compaction'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isRootClaudeFrame } from './claude-turn-opening'
/** Compaction needs no ack deadline of its own: the session's compaction settles on Claude's
 *  terminal `result` for this input, so the dispatch here only has to report a refusal to send. */
export function compactClaudeSession(
  session: ClaudeSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0]
): Promise<StructuredSessionCompactionResult> {
  const sentUuid = randomUUID()
  return session.compaction.run(
    session.providerSessionId,
    async () => {
      const result = await dispatchClaudeTurn(session, {
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '/compact' }] },
        sentUuid
      })
      if (result.state === 'rejected') {
        return { error: result.reason }
      }
      return undefined
    },
    { turnId: input.turnId, turnItemId: input.turnItemId, sentUuid }
  )
}

export function observeClaudeCompaction(
  session: ClaudeSession | null | undefined,
  event: ClaudeStructuredSessionEvent
): void {
  if (!isClaudeCompactionContent(session, event)) {
    session?.translator?.handle(event)
  }
  if (event.type === 'message') {
    session?.compaction.claude(event.message)
  }
}

/** The command's own output — its echo and the generated summary — while it runs on this child. */
export function isClaudeCompactionContent(
  session: ClaudeSession | null | undefined,
  event: ClaudeStructuredSessionEvent
): boolean {
  return (
    event.type === 'message' &&
    session?.compaction.running === true &&
    isRootClaudeFrame(event.message) &&
    ['user', 'assistant', 'stream_event'].includes(String(event.message.type))
  )
}
