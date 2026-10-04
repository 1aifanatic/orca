import { z } from 'zod'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { acpNotificationEnvelopeSchema, AcpContextTimeline } from './acp-context-usage'
import { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import {
  GENERIC_ACP_DIALECT,
  type AcpDialect,
  type AcpRequestPresentation
} from './acp-dialects/acp-dialect'
import { acpTurnEnd, AcpPromptTurns } from './acp-prompt-turns'
import { acpMarkedReplay, acpReplayedUser, AcpReplayUserMessages } from './acp-load-replay'
import type { AcpSessionEvent } from './acp-session-runtime'
import { translateAcpRequest } from './acp-timeline-requests'
export { acpTurnEnd } from './acp-prompt-turns'
import { acpSessionUpdate } from './acp-session-update'
import { AcpToolTimeline } from './acp-tool-timeline'
import { AcpTurnMessages } from './acp-turn-messages'
import { SessionNotificationSchema, type PromptResponse } from './generated/acp-protocol.generated'

const requestSessionSchema = z.object({ sessionId: z.string() })

type LoadReplay = {
  adopt: boolean
  turn?: string
  serial: number
  users: AcpReplayUserMessages
  pendingUser?: AgentJournalMessageItem
}
export type AcpTimelineTranslatorOptions = {
  sessionId: string
  /** Committed journal after the host drains earlier writes before session/load. */
  journalItems(): readonly AgentJournalRenderItem[]
  dialect?: AcpDialect
}

/** Consumes each frame once; the host retries the returned grammar events. */
export class AcpTimelineTranslator {
  private readonly dialect: AcpDialect
  private readonly prompts: AcpPromptTurns
  private readonly tools: AcpToolTimeline
  private readonly backgroundTasks: AcpBackgroundTaskTimeline
  private readonly messages = new AcpTurnMessages()
  private readonly started = new BoundedMap<string, true>({ maxEntries: 128 })
  private replay?: LoadReplay
  private readonly context = new AcpContextTimeline()
  private activeTurn?: string

  constructor(private readonly options: AcpTimelineTranslatorOptions) {
    this.dialect = options.dialect ?? GENERIC_ACP_DIALECT
    this.tools = new AcpToolTimeline(options.journalItems)
    this.backgroundTasks = new AcpBackgroundTaskTimeline(options.journalItems, (callId) =>
      this.tools.turn(callId)
    )
    this.prompts = new AcpPromptTurns(
      options.sessionId,
      this.dialect.injectedPromptIdentity === true
    )
  }

  /** The host injects promptId as session/prompt._meta.promptId (and requestId). */
  openPrompt(
    clientMessageId: string,
    at: number
  ): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.replay) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    return this.prompts.open(clientMessageId, at)
  }

  promptResult(
    clientMessageId: string,
    result: PromptResponse,
    at: number
  ): ProviderTimelineEvent[] {
    return this.finishPrompt(clientMessageId, result.stopReason, at)
  }

  promptFailed(clientMessageId: string, _error: unknown, at: number): ProviderTimelineEvent[] {
    return this.finishPrompt(clientMessageId, 'error', at)
  }

  /** The agent refused the prompt before its turn began: forgets it and answers true. False once
   *  the turn opened, when the refusal ends that turn instead (`promptFailed`). */
  promptRefused(clientMessageId: string): boolean {
    const prompt = this.prompts.current
    if (prompt?.clientMessageId !== clientMessageId || prompt.opened) {
      return false
    }
    this.prompts.current = undefined
    return true
  }

  private finishPrompt(
    clientMessageId: string,
    stopReason: string,
    at: number
  ): ProviderTimelineEvent[] {
    const prompt = this.prompts.current
    if (prompt?.clientMessageId !== clientMessageId) {
      return []
    }
    const events = this.prompts.start(prompt.turn, at)
    events.push(acpTurnEnd(prompt.turn, stopReason, at, prompt.durationMs))
    this.end(prompt.turn)
    this.prompts.current = undefined
    return events
  }

  contextModels(models: unknown, at: number): ProviderTimelineEvent[] {
    return this.context.models(models, at, this.dialect, { thread: this.options.sessionId })
  }

  beginLoad(): void {
    if (this.prompts.current || this.replay) {
      throw new Error('ACP load overlaps a prompt or load')
    }
    this.replay = {
      adopt: this.options.journalItems().length === 0,
      serial: 0,
      users: new AcpReplayUserMessages()
    }
  }

  finishLoad(at: number): ProviderTimelineEvent[] {
    const turn = this.replay?.turn
    this.replay = undefined
    if (!turn) {
      return []
    }
    this.end(turn)
    return [{ type: 'turn.end', turn, at, state: 'completed' }]
  }

  sessionEvent(event: AcpSessionEvent, at: number): ProviderTimelineEvent[] {
    return this.notification(
      'session/update',
      event.kind === 'known' ? event.notification : event.raw,
      at
    )
  }

  notification(method: string, params: unknown, at: number): ProviderTimelineEvent[] {
    const session = requestSessionSchema.safeParse(params)
    if (session.success && session.data.sessionId !== this.options.sessionId) {
      return []
    }
    const interpreted = this.dialect.notification?.(method, params, at)
    if (interpreted?.disposition === 'ignore') {
      return []
    }
    const extension = interpreted
    if (method !== 'session/update' && !extension) {
      return []
    }
    const envelope = acpNotificationEnvelopeSchema.safeParse(params)
    const markedReplay =
      (envelope.success && envelope.data._meta?.isReplay === true) || extension?.replay === true
    if (markedReplay && !this.replay) {
      return []
    }
    const isReplay = extension?.replay ?? (markedReplay || this.replay !== undefined)
    const providerTurn = extension?.turn
    // What the journal already holds of a replayed turn is decided at each write, against the
    // journal then: a load runs before its sink can read the journal.
    if (
      isReplay &&
      this.replay &&
      !providerTurn &&
      !this.replay.adopt &&
      !this.dialect.injectedPromptIdentity
    ) {
      this.replay.pendingUser = undefined
      return []
    }
    const standard =
      method === 'session/update' ? SessionNotificationSchema.safeParse(params) : undefined
    const events: ProviderTimelineEvent[] = []
    const replayUser =
      isReplay && this.replay && standard?.success
        ? this.replay.users.observe(standard.data.update)
        : undefined
    if (
      isReplay &&
      this.replay &&
      this.dialect.injectedPromptIdentity &&
      replayUser?.body &&
      !providerTurn
    ) {
      this.replay.pendingUser = replayUser.body
      return []
    }
    if (replayUser?.startsMessage && this.replay?.turn && !providerTurn) {
      events.push({ type: 'turn.end', turn: this.replay.turn, at, state: 'completed' })
      this.end(this.replay.turn)
    }
    const substantive =
      standard?.success &&
      [
        'user_message_chunk',
        'agent_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'plan'
      ].includes(standard.data.update.sessionUpdate)
    let turn =
      providerTurn ??
      (isReplay
        ? this.replay?.turn
        : this.prompts.current?.opened
          ? this.prompts.current.turn
          : this.activeTurn)
    if (!turn && isReplay && this.replay?.adopt && substantive) {
      turn = `replay:${this.replay.serial++}`
    }
    if (turn && (substantive || extension?.end || extension?.started)) {
      events.push(...this.start(turn, extension?.at ?? at))
      if (isReplay && this.replay) {
        this.replay.turn = turn
        if (this.replay.pendingUser) {
          events.push(
            acpReplayedUser({ thread: this.options.sessionId, turn }, this.replay.pendingUser)
          )
          this.replay.pendingUser = undefined
        }
      }
    }
    const join = { thread: this.options.sessionId, ...(turn === undefined ? {} : { turn }) }
    if (extension?.backgroundTasks) {
      events.push(...this.backgroundTasks.translate(extension.backgroundTasks, join, isReplay))
    }
    if (extension?.usage) {
      events.push(...this.context.update(extension.usage, join))
    }
    if (extension?.end && turn) {
      if (
        this.prompts.current?.turn === turn &&
        ['end_turn', 'cancelled'].includes(extension.end.stopReason)
      ) {
        this.prompts.current.durationMs = extension.end.durationMs
      } else {
        events.push(acpTurnEnd(turn, extension.end.stopReason, at, extension.end.durationMs))
        this.end(turn)
        if (this.prompts.current?.turn === turn) {
          this.prompts.current = undefined
        }
      }
      return acpMarkedReplay(events, isReplay)
    }
    if (standard?.success) {
      const messageKey =
        turn && this.dialect.injectedPromptIdentity
          ? this.messages.key(turn, standard.data.update)
          : undefined
      return acpMarkedReplay(
        [
          ...events,
          ...acpSessionUpdate(
            standard.data,
            turn,
            at,
            isReplay,
            this.tools,
            this.dialect,
            this.backgroundTasks,
            replayUser?.body,
            messageKey
          )
        ],
        isReplay
      )
    }
    if (method === 'session/update') {
      events.push({ type: 'provider.frame', frameKind: method, payload: params, join })
    }
    return acpMarkedReplay(events, isReplay)
  }

  request(
    method: string,
    params: unknown,
    id: string | number
  ): { events: ProviderTimelineEvent[]; presentation?: AcpRequestPresentation } {
    return translateAcpRequest(method, params, id, {
      ...this.options,
      dialect: this.dialect,
      tools: this.tools
    })
  }

  private start(turn: string, at: number): ProviderTimelineEvent[] {
    if (turn === this.prompts.current?.turn) {
      const events = this.prompts.start(turn, at)
      this.activeTurn = turn
      return events
    }
    if (this.started.has(turn)) {
      return []
    }
    this.started.set(turn, true)
    this.activeTurn = turn
    return [{ type: 'turn.open', turn, at }]
  }

  private end(turn: string): void {
    this.tools.end(turn)
    this.messages.end(turn)
    if (this.activeTurn === turn) {
      this.activeTurn = undefined
    }
    if (this.replay?.turn === turn) {
      this.replay.turn = undefined
    }
  }
}
