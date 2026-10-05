import { z } from 'zod'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  acpNotificationEnvelopeSchema,
  AcpContextTimeline,
  acpWindowUsage
} from './acp-context-usage'
import { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import {
  GENERIC_ACP_DIALECT,
  type AcpDialect,
  type AcpDialectNotification,
  type AcpRequestPresentation
} from './acp-dialects/acp-dialect'
import { AcpHistoryAdoption } from './acp-history-adoption'
import { acpTurnEnd, AcpPromptTurns } from './acp-prompt-turns'
import type { AcpSessionEvent } from './acp-session-runtime'
import { translateAcpRequest } from './acp-timeline-requests'
export { acpTurnEnd } from './acp-prompt-turns'
import { acpSessionUpdate } from './acp-session-update'
import { AcpToolTimeline } from './acp-tool-timeline'
import { AcpTurnMessages } from './acp-turn-messages'
import {
  SessionNotificationSchema,
  type PromptResponse,
  type SessionNotification
} from './generated/acp-protocol.generated'

const requestSessionSchema = z.object({ sessionId: z.string() })
const SUBSTANTIVE_UPDATES = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan'
]

export type AcpTimelineTranslatorOptions = {
  sessionId: string
  dialect?: AcpDialect
  /** The creator's decision, made from the journal before spawn: translate `session/load` history
   *  because the journal is empty (an adopted session). Otherwise history stays out of the
   *  timeline and only its context usage reads on. */
  adopt?: boolean
}

/** Consumes each frame once; the host retries the returned grammar events. Lives exactly as long
 *  as its provider child, so it never reads the journal. */
export class AcpTimelineTranslator {
  private readonly dialect: AcpDialect
  private readonly prompts: AcpPromptTurns
  private readonly tools = new AcpToolTimeline()
  private readonly backgroundTasks: AcpBackgroundTaskTimeline
  private readonly messages = new AcpTurnMessages()
  private readonly started = new BoundedMap<string, true>({ maxEntries: 128 })
  private load?: { adoption?: AcpHistoryAdoption }
  private readonly context = new AcpContextTimeline()
  private activeTurn?: string

  constructor(private readonly options: AcpTimelineTranslatorOptions) {
    this.dialect = options.dialect ?? GENERIC_ACP_DIALECT
    this.backgroundTasks = new AcpBackgroundTaskTimeline((callId) => this.tools.turn(callId))
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
    if (this.load) {
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
    if (this.prompts.current || this.load) {
      throw new Error('ACP load overlaps a prompt or load')
    }
    this.load = this.options.adopt
      ? { adoption: new AcpHistoryAdoption(this.options.sessionId) }
      : {}
  }

  finishLoad(at: number): ProviderTimelineEvent[] {
    const adoption = this.load?.adoption
    this.load = undefined
    if (!adoption) {
      return []
    }
    const events = adoption.holdsUser
      ? this.openHistory(adoption, adoption.turnFor(undefined), at)
      : []
    return [...events, ...this.endHistory(adoption, at)]
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
    const standard =
      method === 'session/update' ? SessionNotificationSchema.safeParse(params) : undefined
    const update = standard?.success ? standard.data.update : undefined
    const markedReplay =
      (envelope.success && envelope.data._meta?.isReplay === true) || extension?.replay === true
    const history = markedReplay || (extension?.replay === undefined && this.load !== undefined)
    const adoption = history ? this.load?.adoption : undefined
    if (history && !adoption) {
      return this.historyUsage(update, extension, at)
    }
    if (adoption && update?.sessionUpdate === 'user_message_chunk') {
      return this.historyUser(adoption, update, at)
    }
    const providerTurn = extension?.turn
    const opens =
      (update !== undefined && SUBSTANTIVE_UPDATES.includes(update.sessionUpdate)) ||
      extension?.end !== undefined ||
      extension?.started === true
    const turn = adoption
      ? opens
        ? adoption.turnFor(providerTurn)
        : (providerTurn ?? adoption.turn)
      : (providerTurn ??
        (this.prompts.current?.opened ? this.prompts.current.turn : this.activeTurn))
    const events: ProviderTimelineEvent[] = []
    if (turn && opens) {
      events.push(
        ...(adoption
          ? this.openHistory(adoption, turn, extension?.at ?? at)
          : this.start(turn, extension?.at ?? at))
      )
    }
    const join = { thread: this.options.sessionId, ...(turn === undefined ? {} : { turn }) }
    if (extension?.backgroundTasks) {
      events.push(...this.backgroundTasks.translate(extension.backgroundTasks, join, history))
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
      return events
    }
    if (standard?.success) {
      // History text is keyed by its position so a re-run of the adoption lands on the same rows.
      const messageKey =
        turn && (this.dialect.injectedPromptIdentity || history)
          ? this.messages.key(turn, standard.data.update)
          : undefined
      return [
        ...events,
        ...acpSessionUpdate(standard.data, turn, at, {
          history,
          tools: this.tools,
          dialect: this.dialect,
          backgroundTasks: this.backgroundTasks,
          messageKey
        })
      ]
    }
    if (method === 'session/update') {
      events.push({ type: 'provider.frame', frameKind: method, payload: params, join })
    }
    return events
  }

  request(
    method: string,
    params: unknown,
    id: string | number
  ): { events: ProviderTimelineEvent[]; presentation?: AcpRequestPresentation } {
    return translateAcpRequest(method, params, id, {
      sessionId: this.options.sessionId,
      dialect: this.dialect,
      tools: this.tools
    })
  }

  /** History that is not adopted is dropped except what it says about the context window. */
  private historyUsage(
    update: SessionNotification['update'] | undefined,
    extension: Extract<AcpDialectNotification, { disposition: 'map' }> | undefined,
    at: number
  ): ProviderTimelineEvent[] {
    const join = { thread: this.options.sessionId }
    const events = extension?.usage ? this.context.update(extension.usage, join) : []
    if (update?.sessionUpdate === 'usage_update') {
      events.push({ type: 'context.usage', usage: acpWindowUsage(update, at), join })
    }
    return events
  }

  /** A saved user message opens a new history turn, unless the provider names its turn. */
  private historyUser(
    adoption: AcpHistoryAdoption,
    update: Extract<SessionNotification['update'], { sessionUpdate: 'user_message_chunk' }>,
    at: number
  ): ProviderTimelineEvent[] {
    if (adoption.continuesUser(update)) {
      adoption.observeUser(update)
      return []
    }
    const events = adoption.holdsUser
      ? this.openHistory(adoption, adoption.turnFor(undefined), at)
      : []
    events.push(...this.endHistory(adoption, at))
    adoption.observeUser(update)
    return events
  }

  private openHistory(
    adoption: AcpHistoryAdoption,
    turn: string,
    at: number
  ): ProviderTimelineEvent[] {
    adoption.turn = turn
    return [...this.start(turn, at), ...adoption.takeUser(turn)]
  }

  /** History carries no verdict for a turn it does not end itself. */
  private endHistory(adoption: AcpHistoryAdoption, at: number): ProviderTimelineEvent[] {
    const turn = adoption.turn
    if (!turn) {
      return []
    }
    this.end(turn)
    adoption.turn = undefined
    return [{ type: 'turn.end', turn, at, state: 'completed' }]
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
    if (this.load?.adoption?.turn === turn) {
      this.load.adoption.turn = undefined
    }
  }
}
