import { useCallback, useEffect, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { NativeChatAsyncAnswerOutcome } from '../../../../shared/native-chat-async-question-answers'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  forgetStructuredAsyncAnswer,
  structuredAsyncAnswerOutcome
} from './structured-agent-session-async-answer-settlement'
import type { NativeChatAsyncAnswerSend } from './use-native-chat-async-questions'

/** The structured pane's answer seam: an outbox entry with a card origin, settled on every
 *  disposition of that entry. Losing the pane or the session ends the wait as `unknown`. */
export function useStructuredAsyncAnswerSend(args: {
  sessionId: string
  sendAsyncAnswer: (text: string, answers: Record<string, string>) => string | null
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[] | undefined
}): NativeChatAsyncAnswerSend {
  const { sessionId, sendAsyncAnswer, outbox, submissions, queuedMessageIds } = args
  const waiting = useRef(new Map<string, (outcome: NativeChatAsyncAnswerOutcome) => void>())

  useEffect(() => {
    for (const [id, resolve] of waiting.current) {
      const outcome = structuredAsyncAnswerOutcome(id, { outbox, submissions, queuedMessageIds })
      if (outcome) {
        waiting.current.delete(id)
        forgetStructuredAsyncAnswer(id)
        resolve(outcome)
      }
    }
  }, [outbox, submissions, queuedMessageIds])

  useEffect(() => {
    const pending = waiting.current
    return () => {
      for (const [id, resolve] of pending) {
        forgetStructuredAsyncAnswer(id)
        resolve('unknown')
      }
      pending.clear()
    }
  }, [sessionId])

  return useCallback(
    (text, answers) => {
      const id = sendAsyncAnswer(text, answers)
      if (!id) {
        return Promise.resolve<NativeChatAsyncAnswerOutcome>('rejected')
      }
      return new Promise<NativeChatAsyncAnswerOutcome>((resolve) => {
        waiting.current.set(id, resolve)
      })
    },
    [sendAsyncAnswer]
  )
}
