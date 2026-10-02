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
import {
  awaitNativeChatDraftCleared,
  restoreNativeChatDraftIfEmpty
} from './native-chat-draft-cache'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  /** The chat's draft (`nativeChatDraftKey`), where a refused message is put back. */
  draftKey: string
  draft?: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  clearImageAttachments: () => void
  clearSkillOrigin: () => void
  setHistory: (updater: (previous: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** Send through the structured journal transport (the PTY path has its own sibling hook). A
 *  message clears the composer before the transport takes it and is put back if refused; a host
 *  command clears it only once accepted. */
export function useNativeChatStructuredComposerSend({
  agent,
  draftKey,
  draft,
  imageAttachments,
  structuredTransport,
  clearImageAttachments,
  clearSkillOrigin,
  setHistory,
  setDraft,
  setCaret
}: UseNativeChatStructuredComposerSendArgs): (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[]
) => void {
  const composition = useRef({ draft, imageAttachments })
  useLayoutEffect(() => {
    composition.current = { draft, imageAttachments }
  }, [draft, imageAttachments])
  return useCallback(
    (text: string, attachments = imageAttachments): void => {
      if (!structuredTransport) {
        return
      }
      const hostCommand =
        isStructuredAgentSessionComposerCommand(text, agent) ||
        (structuredTransport.threadGoal !== undefined && isStructuredAgentSessionGoalCommand(text))
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError('Remove attachments before using a chat-session command.')
        return
      }
      const submitted = composition.current
      const clearComposer = (): void => {
        setDraft('')
        setCaret(0)
        clearSkillOrigin()
        clearImageAttachments()
      }
      let cleared = false
      // A refused message goes back, unless something was typed since.
      const putBack = (): void => {
        if (cleared) {
          void restoreNativeChatDraftIfEmpty(draftKey, {
            text,
            attachments: attachments.map(({ id, path, connectionId, location }) => ({
              id,
              path,
              ...(connectionId ? { connectionId } : {}),
              ...(location ? { location } : {})
            }))
          })
        }
      }
      void dispatchNativeChatStructuredComposerText(
        structuredTransport,
        text,
        attachments,
        async () => {
          // Why awaited: once the message is out, a crash must not bring it back as a draft.
          cleared = true
          clearComposer()
          await awaitNativeChatDraftCleared(draftKey)
        }
      )
        .then(
          ({ accepted, error }) => {
            structuredTransport.onError(error)
            if (!accepted) {
              putBack()
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
              cleared ||
              (hostCommand &&
                (composition.current.draft !== submitted.draft ||
                  composition.current.imageAttachments !== submitted.imageAttachments))
            ) {
              return
            }
            clearComposer()
          },
          (error: unknown) => {
            putBack()
            throw error
          }
        )
        .catch((error) =>
          structuredTransport.onError(error instanceof Error ? error.message : String(error))
        )
    },
    [
      agent,
      clearImageAttachments,
      clearSkillOrigin,
      draftKey,
      imageAttachments,
      setCaret,
      setDraft,
      setHistory,
      structuredTransport
    ]
  )
}
