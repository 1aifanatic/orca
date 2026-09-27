import { useCallback, useState } from 'react'
import type { AgentSessionPromptResult } from '../../../src/shared/agent-session-wire'
import type {
  AgentJournalQuestion,
  AgentJournalQuestionItem
} from '../../../src/shared/agent-session-journal-types'
import {
  AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH,
  encodeAgentSessionQuestionAnswers,
  legacyAgentSessionSelectedOptionId,
  type AgentSessionQuestionAnswer
} from '../../../src/shared/agent-session-question-answer'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  structuredApprovalResponseTarget,
  structuredQuestionResponseTarget
} from './mobile-structured-agent-prompts'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import {
  advanceGroupedQuestion,
  groupedQuestionPromptKey,
  type GroupedQuestionDraft
} from './mobile-structured-grouped-question'

const ANSWER_TOO_LONG_FOR_HOST = 'Update Orca on your computer to send an answer this long'

function shortestPackedAnswer(question: AgentJournalQuestion): AgentSessionQuestionAnswer[] {
  const candidates: AgentSessionQuestionAnswer[] = [
    ...question.options.map((option) => ({ questionId: question.id, optionIds: [option.id] })),
    ...(question.freeTextQuestionId ? [{ questionId: question.id, optionIds: [], other: '-' }] : [])
  ]
  const packedLength = (answer: AgentSessionQuestionAnswer) =>
    encodeAgentSessionQuestionAnswers([answer]).length
  return candidates.sort((a, b) => packedLength(a) - packedLength(b)).slice(0, 1)
}

/** True once even the shortest answers to the remaining questions would overflow the packed group. */
function packedGroupCannotFit(
  questions: readonly AgentJournalQuestion[],
  answers: readonly AgentSessionQuestionAnswer[]
): boolean {
  const completion = questions.slice(answers.length).flatMap(shortestPackedAnswer)
  return (
    encodeAgentSessionQuestionAnswers([...answers, ...completion]).length >
    AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH
  )
}

/**
 * Answering the two durable prompt kinds. Kept beside the session hook rather than inside it
 * because grouped questions carry their own multi-step draft, which is state the rest of the
 * session does not touch.
 */
export function useMobileStructuredPromptResponses(args: {
  stateRef: { readonly current: StructuredAgentSessionState }
  sessionKey: string
  mutate: StructuredAgentSessionMutate
  /** Host takes structured `answers`; otherwise the answer is packed into `optionId`. */
  questionAnswersSupported: boolean | null
  onSendError: (message: string) => void
}): {
  groupedDraft: GroupedQuestionDraft | null
  respondPermission: (optionId: string) => Promise<boolean>
  respondQuestion: (answer: string) => Promise<boolean>
} {
  const { mutate, onSendError, questionAnswersSupported, sessionKey, stateRef } = args
  // Partially answered grouped question, held only until its last step is submitted. The session it
  // was collected in is stored with it and checked on read, so switching sessions drops the draft
  // without an effect that would render the stale one for a frame first.
  const [collected, setCollected] = useState<{
    sessionKey: string
    draft: GroupedQuestionDraft
  } | null>(null)
  const groupedDraft = collected?.sessionKey === sessionKey ? collected.draft : null

  const respondPermission = useCallback(
    async (optionId: string): Promise<boolean> => {
      const target = structuredApprovalResponseTarget(
        optionId,
        stateRef.current.items.find(pendingStructuredApproval) ?? null
      )
      if (!target) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        target
      )
      if (result.status === 'unknown') {
        onSendError('Response unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [mutate, onSendError, stateRef]
  )

  const sendAnswers = useCallback(
    (
      target: { itemId: string; expectedRevision: number },
      body: Pick<AgentJournalQuestionItem, 'questions'>,
      answers: AgentSessionQuestionAnswer[]
    ): Promise<StructuredAgentSessionMutationResult<AgentSessionPromptResult> | null> => {
      const send = (fields: Record<string, unknown>) =>
        mutate<AgentSessionPromptResult>(
          'agentSession.respondToQuestion',
          'agentSession.respondTo:question',
          { ...target, ...fields }
        )
      if (questionAnswersSupported === true) {
        return send({ answers })
      }
      const optionId = legacyAgentSessionSelectedOptionId(body, answers)
      if (optionId === null) {
        return Promise.resolve(null)
      }
      if (optionId.length > AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH) {
        // Too long to pack for any host: while support is unknown, `answers` is the only form that can land.
        if (questionAnswersSupported === null) {
          return send({ answers })
        }
        onSendError(ANSWER_TOO_LONG_FOR_HOST)
        return Promise.resolve(null)
      }
      return send({ optionId })
    },
    [mutate, onSendError, questionAnswersSupported]
  )

  const respondQuestion = useCallback(
    async (answer: string): Promise<boolean> => {
      const prompt = stateRef.current.items.find(pendingStructuredQuestion) ?? null
      if (prompt?.body.questions) {
        const promptKey = groupedQuestionPromptKey(prompt.itemId, prompt.revision)
        const grouped = advanceGroupedQuestion({
          response: answer,
          questions: prompt.body.questions,
          draft: groupedDraft,
          promptKey
        })
        if (!grouped) {
          return false
        }
        if (grouped.kind === 'advance') {
          // Refuse while this step's text is still editable, not on a later step that cannot fit.
          if (
            questionAnswersSupported === false &&
            packedGroupCannotFit(prompt.body.questions, grouped.draft.answers)
          ) {
            onSendError(ANSWER_TOO_LONG_FOR_HOST)
            return false
          }
          setCollected({ sessionKey, draft: grouped.draft })
          return true
        }
        const result = await sendAnswers(
          { itemId: prompt.itemId, expectedRevision: prompt.revision },
          prompt.body,
          grouped.answers
        )
        if (!result) {
          return false
        }
        if (result.status !== 'rejected') {
          // The group left the phone; a retry must start from the first question, not a stale tail.
          setCollected((current) =>
            current?.sessionKey === sessionKey && current.draft.promptKey === promptKey
              ? null
              : current
          )
        }
        if (result.status === 'unknown') {
          onSendError('Answer unconfirmed — check chat before retrying')
          return false
        }
        return result.status === 'accepted'
      }
      const target = structuredQuestionResponseTarget(answer, prompt)
      if (!target) {
        return false
      }
      const result = await sendAnswers(
        { itemId: target.itemId, expectedRevision: target.expectedRevision },
        // Grouped questions returned above, so this is a single question.
        {},
        [target.answer]
      )
      if (!result) {
        return false
      }
      if (result.status === 'unknown') {
        onSendError('Answer unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [groupedDraft, onSendError, questionAnswersSupported, sendAnswers, sessionKey, stateRef]
  )

  return { groupedDraft, respondPermission, respondQuestion }
}
