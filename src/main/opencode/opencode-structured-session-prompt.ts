import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers
} from '../../shared/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { OpenCodePendingRequest } from './serve/timeline-translator'
import type {
  OpenCodeSession,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'
import { openCodeChatGrantRules } from './opencode-structured-permission-policy'
import { openCodeSessionPermissionRules } from './serve/native-protocol'
import { settleOpenCodeIdleDispatches } from './opencode-structured-session-idle'

export class OpenCodeStructuredSessionPrompts {
  constructor(
    private readonly sessions: Map<string, OpenCodeSession>,
    private readonly deps: OpenCodeStructuredSessionAdapterDeps,
    private readonly closeUnexpected: (sessionId: string) => Promise<boolean>
  ) {}

  private async claimPrompt(
    input: { sessionId: string; itemId: string; fence: number; commit: () => Promise<void> },
    answer: (session: OpenCodeSession, request: OpenCodePendingRequest) => Promise<void>
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    if (
      !session ||
      session.fence !== input.fence ||
      session.ended ||
      !session.client ||
      !session.lane
    ) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    const entry = [...session.pending.values()].find(
      (request) => session.lane?.assembler.requestItemId(request.request) === input.itemId
    )
    if (!entry || session.claims.has(entry.request)) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    session.claims.add(entry.request)
    let committed = false
    try {
      await input.commit()
      committed = true
      if (session.ended || session.pending.get(entry.request) !== entry) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      await answer(session, entry)
      session.pending.delete(entry.request)
      settleOpenCodeIdleDispatches(session, this.deps)
    } catch (error) {
      if (committed && !session.ended && session.pending.get(entry.request) === entry) {
        session.pending.delete(entry.request)
        void this.closeUnexpected(session.sessionId).catch((closeError: unknown) =>
          this.deps.logger?.error('OpenCode prompt reply cleanup failed', {
            scope: 'opencode-prompt-reply',
            sessionId: session.sessionId,
            error: closeError
          })
        )
      }
      throw error
    } finally {
      session.claims.delete(entry.request)
    }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    const request = [...(session?.pending.values() ?? [])].find(
      (entry) => session?.lane?.assembler.requestItemId(entry.request) === input.itemId
    )
    if (!request) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    if (input.kind === 'approval' && request.kind !== 'permission') {
      throw new AgentSessionPromptAnswerRejectedError('OpenCode prompt kind changed')
    }
    if (input.kind === 'question' && request.kind === 'permission') {
      throw new AgentSessionPromptAnswerRejectedError('OpenCode prompt kind changed')
    }
    if (
      request.kind === 'permission' &&
      (input.response.kind !== 'option' ||
        !['once', 'reject', 'allow-session'].includes(input.response.optionId))
    ) {
      throw new AgentSessionPromptAnswerRejectedError('OpenCode approval answer is invalid')
    }
    if (request.kind !== 'permission') {
      if (input.response.kind === 'option') {
        if (!['reject', 'cancel'].includes(input.response.optionId)) {
          throw new AgentSessionPromptAnswerRejectedError('OpenCode question answer is invalid')
        }
      } else if (
        request.body.kind !== 'question' ||
        !isValidAgentSessionQuestionAnswers(
          agentSessionPromptQuestions(request.body),
          input.response.answers
        )
      ) {
        throw new AgentSessionPromptAnswerRejectedError('OpenCode question answer is invalid')
      }
    }
    await this.claimPrompt(input, async (current, entry) => {
      if (
        entry.kind === 'permission' &&
        input.response.kind === 'option' &&
        input.response.optionId === 'allow-session'
      ) {
        try {
          const native = await current.client?.load(entry.sessionId)
          if (current.ended || this.sessions.get(current.sessionId) !== current) {
            throw new AgentSessionPromptUnavailableError(input.itemId)
          }
          const rules = openCodeChatGrantRules(
            native && current.client
              ? (openCodeSessionPermissionRules(native, current.client.version.major) ??
                  current.launch.permissions)
              : current.launch.permissions,
            entry
          )
          await current.client?.patchPermissions(entry.sessionId, rules)
          if (entry.sessionId === current.root?.id) {
            current.launch.permissions = rules
          }
        } catch (error) {
          this.deps.logger?.warn('OpenCode chat grant could not be saved', {
            scope: 'opencode-chat-grant',
            sessionId: current.sessionId,
            error
          })
        }
        await current.client?.answerPermission({
          sessionId: entry.sessionId,
          requestId: entry.nativeId,
          decision: 'once'
        })
      } else {
        await current.client?.answerPrompt(entry, input.response)
      }
    })
  }

  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = async (input) => {
    await this.claimPrompt(input, async (session, request) => {
      if (!input.answer) {
        return
      }
      await (request.kind === 'permission'
        ? session.client?.answerPermission({
            sessionId: request.sessionId,
            requestId: request.nativeId,
            decision: 'reject'
          })
        : session.client?.answerPrompt(request, { kind: 'option', optionId: 'cancel' }))
    })
  }
}
