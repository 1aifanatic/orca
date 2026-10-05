import { z } from 'zod'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { acpNotificationEnvelopeSchema, AcpContextTimeline } from './acp-context-usage'
import { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import {
  GENERIC_ACP_DIALECT,
  type AcpDialect,
  type AcpRequestPresentation
} from './acp-dialects/acp-dialect'
import type { AcpAgentError } from './acp-errors'
import { AcpHistoryAdoption } from './acp-history-adoption'
import { acpTurnEnd, AcpPromptTurns } from './acp-prompt-turns'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
import { translateAcpRequest } from './acp-timeline-requests'
import { acpSessionUpdate } from './acp-session-update'
import { AcpToolTimeline } from './acp-tool-timeline'
import { AcpTurnFailures, acpPromptErrorDetail } from './acp-turn-failures'
import { AcpTurnMessages } from './acp-turn-messages'
import type { PromptResponse, SessionNotification } from './generated/acp-protocol.generated'

export { acpTurnEnd } from './acp-prompt-turns'

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
  /** The agent's display name, for a failed turn the provider gave no words for. */
  agentName?: string
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
  private readonly failures: AcpTurnFailures
  private load?: { adoption?: AcpHistoryAdoption }
  private readonly context = new AcpContextTimeline()
  private activeTurn?: string

  constructor(private readonly options: AcpTimelineTranslatorOptions) {
    this.dialect = options.dialect ?? GENERIC_ACP_DIALECT
    this.failures = new AcpTurnFailures(options.sessionId, this.dialect, options.agentName)
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

  /** The agent's own error answer to the prompt; Orca's errors about it (a timeout, an unreadable
   *  answer, a closed connection) are no provider words and never reach here. */
  promptFailed(clientMessageId: string, error: AcpAgentError, at: number): ProviderTimelineEvent[] {
    const detail = acpPromptErrorDetail(this.dialect, error)
    const ended = this.prompts.last
    if (this.prompts.current?.clientMessageId !== clientMessageId) {
      // The provider already ended this turn; its answer may carry the only copy of the reason.
      return ended?.clientMessageId === clientMessageId && this.failures.has(ended.turn)
        ? this.failures.row(ended.turn, detail)
        : []
    }
    return this.finishPrompt(clientMessageId, 'error', at, detail)
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
    at: number,
    failureDetail?: string
  ): ProviderTimelineEvent[] {
    const prompt = this.prompts.current
    if (prompt?.clientMessageId !== clientMessageId) {
      return []
    }
    const events = this.start(prompt.turn, at)
    events.push(...this.endTurn(prompt.turn, stopReason, at, prompt.durationMs, failureDetail))
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
    const extension = this.dialect.notification?.(method, params, at)
    if (extension?.disposition === 'ignore') {
      return []
    }
    if (method !== 'session/update' && !extension) {
      return []
    }
    const envelope = acpNotificationEnvelopeSchema.safeParse(params)
    const read = method === 'session/update' ? readAcpSessionEvent(params) : null
    const standard = read?.kind === 'known' ? read.notification : undefined
    const update = standard?.update
    const markedReplay =
      (envelope.success && envelope.data._meta?.isReplay === true) || extension?.replay === true
    const history = markedReplay || (extension?.replay === undefined && this.load !== undefined)
    const adoption = history ? this.load?.adoption : undefined
    if (history && !adoption) {
      return this.context.history(update, extension?.usage, at, { thread: this.options.sessionId })
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
    if (extension?.failureDetail && turn) {
      events.push(...this.failures.row(turn, extension.failureDetail))
    }
    const end = extension?.end
    if (end && turn) {
      if (
        this.prompts.current?.turn === turn &&
        ['end_turn', 'cancelled'].includes(end.stopReason)
      ) {
        this.prompts.current.durationMs = end.durationMs
      } else {
        events.push(...this.endTurn(turn, end.stopReason, at, end.durationMs, end.failureDetail))
      }
      return events
    }
    if (standard) {
      // History text is keyed by its position so a re-run of the adoption lands on the same rows.
      const messageKey =
        turn && (this.dialect.injectedPromptIdentity || history)
          ? this.messages.key(turn, standard.update)
          : undefined
      return [
        ...events,
        ...acpSessionUpdate(standard, turn, at, {
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

  /** A failed end writes the reason row before the end, so it joins the turn while open. */
  private endTurn(
    turn: string,
    stopReason: string,
    at: number,
    durationMs: number | undefined,
    failureDetail: string | undefined
  ): ProviderTimelineEvent[] {
    const events = this.failures.ended(turn, stopReason, failureDetail)
    events.push(acpTurnEnd(turn, stopReason, at, durationMs))
    this.end(turn)
    if (this.prompts.current?.turn === turn) {
      this.prompts.finish()
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
      // Marked so a late frame for this prompt after its end neither reopens nor retargets it.
      this.started.set(turn, true)
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
