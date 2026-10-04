import { useCallback, useLayoutEffect, useRef } from 'react'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { reportStructuredSessionUserInput } from '@/lib/worker-terminal-takeover-report'
import {
  isStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand
} from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  draft?: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  clearImageAttachments: () => void
  clearSkillOrigin: () => void
  setHistory: (updater: (previous: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** A command the host runs itself (and `/goal` where the host sets goals), never a message. */
export function isNativeChatStructuredHostCommand(
  text: string,
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport
): boolean {
  return (
    isStructuredAgentSessionComposerCommand(text, agent) ||
    (transport.threadGoal !== undefined && isStructuredAgentSessionGoalCommand(text))
  )
}

/** What the composer held when a send was asked for. */
export type NativeChatComposerComposition = {
  draft: string | undefined
  imageAttachments: readonly NativeChatComposerImageAttachment[]
}

/** A structured send. `sentFrom`: the composition the message was taken from, for a send that
 *  goes out later than it was asked for; the composer is then cleared only if still unchanged. */
export type NativeChatStructuredComposerSend = (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[],
  sentFrom?: NativeChatComposerComposition
) => Promise<void>

/** Send through the structured journal transport, clearing the composer only
 *  once the transport accepts (the PTY path has its own sibling hook). */
export function useNativeChatStructuredComposerSend({
  agent,
  draft,
  imageAttachments,
  structuredTransport,
  clearImageAttachments,
  clearSkillOrigin,
  setHistory,
  setDraft,
  setCaret
}: UseNativeChatStructuredComposerSendArgs): NativeChatStructuredComposerSend {
  const composition = useRef<NativeChatComposerComposition>({ draft, imageAttachments })
  useLayoutEffect(() => {
    composition.current = { draft, imageAttachments }
  }, [draft, imageAttachments])
  return useCallback<NativeChatStructuredComposerSend>(
    async (text, attachments = imageAttachments, sentFrom): Promise<void> => {
      if (!structuredTransport) {
        return
      }
      const hostCommand = isNativeChatStructuredHostCommand(text, agent, structuredTransport)
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError('Remove attachments before using a chat-session command.')
        return
      }
      const submitted = sentFrom ?? composition.current
      await dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
        .then(({ accepted, error }) => {
          structuredTransport.onError(error)
          if (!accepted) {
            return
          }
          emitNativeChatMessageSent({ agent, runtime: structuredTransport.runtime })
          // A real user send is a takeover, exactly as typing into a worker's pane is. Only past
          // `accepted`, and only from this hook: the outbox dispatcher retries and would re-fire,
          // and orchestration's own pointer nudges never reach the composer at all.
          reportStructuredSessionUserInput(
            structuredTransport.sessionId,
            structuredTransport.runtimeEnvironmentId
          )
          setHistory((previous) => pushHistory(previous, text))
          if (
            (hostCommand || sentFrom !== undefined) &&
            (composition.current.draft !== submitted.draft ||
              composition.current.imageAttachments !== submitted.imageAttachments)
          ) {
            return
          }
          setDraft('')
          setCaret(0)
          clearSkillOrigin()
          clearImageAttachments()
        })
        .catch((error) =>
          structuredTransport.onError(error instanceof Error ? error.message : String(error))
        )
    },
    [
      agent,
      clearImageAttachments,
      clearSkillOrigin,
      imageAttachments,
      setCaret,
      setDraft,
      setHistory,
      structuredTransport
    ]
  )
}
