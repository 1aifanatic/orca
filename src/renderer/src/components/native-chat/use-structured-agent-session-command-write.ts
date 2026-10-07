import { useCallback, useEffect, useRef } from 'react'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { holdStructuredAgentSessionSends } from './structured-agent-session-pending-sends'
import {
  carryClearedStructuredAgentSessionDraft,
  noteStructuredAgentSessionClearedInto
} from './structured-agent-session-clear-draft-carry'

/**
 * Sends a conversation command. A /clear keeps the chat's sends out while it runs, as its host
 * refuses them, so text typed meanwhile stays in the box. Once it moves the chat to a new
 * conversation, the old one takes nothing until this view leaves it, and its draft goes along.
 */
export function useStructuredAgentSessionCommandWrite(
  sessionId: string,
  write: StructuredAgentSessionWrite
): (
  command: AgentSessionConversationCommand
) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>> {
  const shown = useRef(sessionId)
  const keptHold = useRef<(() => void) | null>(null)
  useEffect(() => {
    shown.current = sessionId
    return () => {
      keptHold.current?.()
      keptHold.current = null
      carryClearedStructuredAgentSessionDraft(sessionId, { leaving: true })
    }
  }, [sessionId])
  return useCallback(
    async (command) => {
      const send = () =>
        write<AgentSessionConversationCommandResult>(
          'agentSession.conversationCommand',
          'agentSession.conversationCommand',
          { command }
        )
      if (command !== 'clear') {
        return send()
      }
      const release = holdStructuredAgentSessionSends(sessionId)
      let movedOn = false
      try {
        const outcome = await send()
        const replacement = outcome.kind === 'done' ? outcome.value.replacementSessionId : undefined
        if (replacement !== undefined) {
          noteStructuredAgentSessionClearedInto(sessionId, replacement)
          movedOn = true
        }
        return outcome
      } finally {
        if (movedOn && shown.current === sessionId) {
          keptHold.current?.()
          keptHold.current = release
        } else {
          release()
        }
      }
    },
    [sessionId, write]
  )
}
