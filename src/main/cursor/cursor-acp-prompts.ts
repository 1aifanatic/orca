import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { ClaudePromptRegistry } from '../claude/claude-prompt-registry'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CursorAcpConnection, CursorAcpHandlers } from './cursor-acp-connection'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'

const id = z.string().min(1).max(512)
const text = z.string().max(64 * 1024)
const label = z.string().max(512)
const questionsSchema = z.object({
  toolCallId: id,
  title: text.optional(),
  questions: z
    .array(
      z.object({
        id,
        prompt: text,
        options: z.array(z.object({ id, label })).min(1).max(64),
        allowMultiple: z.boolean().optional()
      })
    )
    .min(1)
    .max(4)
})
const permissionSchema = z.object({
  sessionId: id,
  toolCall: z.object({ toolCallId: id, title: text.optional() }).passthrough(),
  options: z
    .array(
      z.object({
        optionId: id,
        name: label,
        kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
      })
    )
    .min(1)
    .max(16)
})
const planSchema = z.object({
  toolCallId: id,
  name: text.optional(),
  overview: text.optional(),
  plan: text
})
const pending = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

type Presentation = {
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
  reply: (response: AgentSessionPromptResponse) => unknown
}

function presentRequest(method: string, params: unknown, sessionId: string): Presentation {
  if (method === 'session/request_permission') {
    const request = permissionSchema.parse(params)
    if (request.sessionId !== sessionId) {
      throw new Error('Permission request belongs to another Cursor session')
    }
    return {
      body: {
        kind: 'approval',
        title: request.toolCall.title ?? 'Cursor tool permission',
        detail: null,
        options: request.options.map((option) => ({ id: option.optionId, label: option.name })),
        resolution: { ...pending }
      },
      reply: (response) => {
        if (
          response.kind !== 'option' ||
          !request.options.some((option) => option.optionId === response.optionId)
        ) {
          throw new AgentSessionPromptAnswerRejectedError(
            'Cursor permission requires an offered option'
          )
        }
        return { outcome: { outcome: 'selected', optionId: response.optionId } }
      }
    }
  }
  if (method === 'cursor/create_plan') {
    const request = planSchema.parse(params)
    return {
      body: {
        kind: 'approval',
        title: request.name ?? 'Review Cursor plan',
        detail: request.overview ?? null,
        subject: { kind: 'plan', text: request.plan },
        options: [
          { id: 'accept', label: 'Approve plan' },
          { id: 'reject', label: 'Keep planning' }
        ],
        resolution: { ...pending }
      },
      reply: (response) => {
        if (response.kind !== 'option' || !['accept', 'reject'].includes(response.optionId)) {
          throw new AgentSessionPromptAnswerRejectedError(
            'Cursor plan requires approval or rejection'
          )
        }
        return { outcome: { outcome: response.optionId === 'accept' ? 'accepted' : 'rejected' } }
      }
    }
  }
  const request = questionsSchema.parse(params)
  return {
    body: {
      kind: 'question',
      question: request.title ?? 'Cursor needs your input',
      options: [],
      questions: request.questions.map((question) => ({
        id: question.id,
        question: question.prompt,
        options: question.options.map((option) => ({ id: option.id, label: option.label })),
        multiSelect: question.allowMultiple ?? false
      })),
      resolution: { ...pending }
    },
    reply: (response) => {
      if (response.kind !== 'answers' || response.answers.length !== request.questions.length) {
        throw new AgentSessionPromptAnswerRejectedError(
          'Cursor requires an answer for every question'
        )
      }
      const answers = request.questions.map((question) => {
        const matches = response.answers.filter((answer) => answer.questionId === question.id)
        const answer = matches.length === 1 ? matches[0] : undefined
        if (
          !answer ||
          answer.other ||
          answer.optionIds.length === 0 ||
          (!question.allowMultiple && answer.optionIds.length !== 1) ||
          new Set(answer.optionIds).size !== answer.optionIds.length ||
          answer.optionIds.some(
            (optionId) => !question.options.some((option) => option.id === optionId)
          )
        ) {
          throw new AgentSessionPromptAnswerRejectedError(
            'Cursor question answer does not match its offered choices'
          )
        }
        return { questionId: question.id, selectedOptionIds: answer.optionIds }
      })
      return { outcome: { outcome: 'answered', answers } }
    }
  }
}

export class CursorAcpPrompts {
  private readonly claims = new ClaudePromptRegistry()
  private readonly presentations = new Map<string, Presentation>()

  constructor(
    private readonly connection: () => CursorAcpConnection,
    private readonly sessionId: () => string,
    private readonly append: (
      identity: AgentJournalItemIdentity,
      body: Presentation['body']
    ) => void
  ) {}

  receive(request: Parameters<NonNullable<CursorAcpHandlers['onServerRequest']>>[0]): boolean {
    if (
      !['session/request_permission', 'cursor/ask_question', 'cursor/create_plan'].includes(
        request.method
      )
    ) {
      this.connection().respondWithError(
        request.id,
        -32601,
        'Orca does not implement this ACP client request'
      )
      return false
    }
    let presentation: Presentation
    try {
      if (Buffer.byteLength(JSON.stringify(request.params), 'utf8') > 256 * 1024) {
        throw new Error('Cursor ACP prompt exceeded its byte bound')
      }
      presentation = presentRequest(request.method, request.params, this.sessionId())
      if (
        new Set(presentation.body.options.map((option) => option.id)).size !==
        presentation.body.options.length
      ) {
        throw new Error('Cursor ACP prompt repeated option identities')
      }
      if (presentation.body.kind === 'question' && presentation.body.questions) {
        const questions = presentation.body.questions
        if (
          new Set(questions.map((question) => question.id)).size !== questions.length ||
          questions.some(
            (question) =>
              new Set(question.options.map((option) => option.id)).size !== question.options.length
          )
        ) {
          throw new Error('Cursor ACP question repeated identities')
        }
      }
    } catch {
      this.connection().respondWithError(
        request.id,
        -32602,
        'Cursor ACP prompt is malformed or belongs to another session'
      )
      return false
    }
    if (this.presentations.size >= 64) {
      throw new Error('Cursor ACP pending prompt limit exceeded')
    }
    const key = randomUUID()
    const identity: AgentJournalItemIdentity = {
      provider: 'cursor',
      sessionId: this.sessionId(),
      recordId: `prompt:${key}`
    }
    const itemId = agentJournalItemKey(identity)
    const prompt = this.claims.register({
      requestId: key,
      toolName: presentation.body.kind === 'question' ? 'AskUserQuestion' : 'Cursor approval',
      toolUseId: key,
      input:
        presentation.body.kind === 'question' ? { questions: presentation.body.questions } : {},
      suggestions: [],
      settle: () => undefined
    })
    if (!prompt) {
      throw new Error('Cursor ACP could not retain its pending prompt')
    }
    const reply = presentation.reply
    this.presentations.set(itemId, {
      ...presentation,
      reply: (response) => ({ id: request.id, result: reply(response) })
    })
    this.claims.bindJournalItemId(itemId, key)
    this.append(identity, presentation.body)
    return true
  }

  async answer(input: Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]): Promise<void> {
    const claim = this.claims.claim(input.itemId, input.kind)
    const presentation = this.presentations.get(input.itemId)
    if (!claim || !presentation) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    try {
      const response = z
        .object({ id: z.union([z.string(), z.number()]), result: z.unknown() })
        .parse(presentation.reply(input.response))
      if (this.connection().closed) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      await input.commit()
      if (!this.claims.ownsClaim(claim) || this.connection().closed) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      this.claims.forget(claim.found.prompt)
      this.presentations.delete(input.itemId)
      this.connection().respond(response.id, response.result)
    } finally {
      this.claims.releaseClaim(claim)
    }
  }

  clear(): void {
    this.claims.clear()
    this.presentations.clear()
  }
}
