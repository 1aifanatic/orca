import {
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../../native-chat/agent-session-journal/journal-payload-bounds'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin,
  ProviderTimelineRequestBody
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { OpenCodeNativeSession } from './native-protocol'
import type { OpenCodePendingRequest, OpenCodeTimelineTranslation } from './timeline-contract'
import { remember, MAX_PARTS, MAX_SESSIONS, MAX_TEXT } from './timeline-shapes'
import { openRequest, withdrawRequest } from './timeline-requests'
import { OpenCodeHttpError } from './http-response'

type Tool = {
  name: string
  input: unknown
  state: 'running' | 'completed' | 'failed'
}
type TextPart = { text: string; channel: 'assistant' | 'reasoning'; closed: boolean }

export class OpenCodeTimelineState {
  contextWindowTokens: number | null = null
  readonly sessions = new Map<string, OpenCodeNativeSession>()
  readonly turns = new Map<string, string>()
  readonly texts = new Map<string, TextPart>()
  readonly textMessage = new Map<string, string>()
  readonly messageRole = new Map<string, string>()
  readonly tools = new Map<string, Tool>()
  readonly pending = new Map<string, OpenCodePendingRequest>()
  readonly childCall = new Map<string, string>()
  readonly seenUsage = new Map<string, string>()
  readonly compactionIds = new Map<string, string>()
  readonly accepted = new Set<string>()
  readonly awaitingNativeInputs: (string | undefined)[] = []

  constructor(readonly options: { sessionId: string; major: 1 | 2 }) {
    this.sessions.set(options.sessionId, { id: options.sessionId })
  }

  registerSession(session: OpenCodeNativeSession): void {
    if (
      session.id !== this.options.sessionId &&
      (!session.parentID || !this.ownsSession(session.parentID))
    ) {
      return
    }
    if (!this.sessions.has(session.id) && this.sessions.size >= MAX_SESSIONS) {
      throw new OpenCodeHttpError('capacity', 'OpenCode child session limit exceeded')
    }
    this.sessions.set(session.id, {
      id: session.id,
      ...(session.parentID ? { parentID: session.parentID } : {}),
      ...(session.title ? { title: session.title.slice(0, 512) } : {}),
      ...(session.agent ? { agent: session.agent.slice(0, 256) } : {})
    })
  }

  ownsSession(sessionId: string): boolean {
    if (sessionId === this.options.sessionId) {
      return true
    }
    const seen = new Set<string>()
    let current: string | undefined = sessionId
    while (current && !seen.has(current)) {
      seen.add(current)
      const parent: string | undefined = this.sessions.get(current)?.parentID
      if (parent === this.options.sessionId) {
        return true
      }
      current = parent
    }
    return false
  }

  input(
    clientMessageId: string,
    requestedAt: number,
    nativeMessageId?: string
  ): ProviderTimelineEvent[] {
    const active = this.turns.get(this.options.sessionId)
    const turn = active ?? nativeMessageId ?? clientMessageId
    if (!active) {
      this.turns.set(this.options.sessionId, turn)
    }
    this.awaitingNativeInputs.push(nativeMessageId)
    if (this.awaitingNativeInputs.length > 128) {
      this.awaitingNativeInputs.shift()
    }
    return [
      { type: 'input.accepted', clientMessageId, requestedAt, join: { turn } },
      ...(active ? [] : [{ type: 'turn.open' as const, turn, at: requestedAt }])
    ]
  }

  join(sessionId: string): {
    join: ProviderTimelineJoin
    producer?: { agentId: string; parentAgentId?: string; providerParentRef?: string }
  } {
    const turn = this.turns.get(this.options.sessionId)
    if (sessionId === this.options.sessionId) {
      return { join: turn ? { turn } : {} }
    }
    const parent = this.sessions.get(sessionId)?.parentID
    const providerParentRef = this.childCall.get(sessionId)
    return {
      join: { thread: sessionId, scope: 'thread' },
      producer: {
        agentId: sessionId,
        ...(parent && parent !== this.options.sessionId ? { parentAgentId: parent } : {}),
        ...(providerParentRef ? { providerParentRef } : {})
      }
    }
  }

  open(sessionId: string, turn: string, at: number): ProviderTimelineEvent[] {
    if (sessionId !== this.options.sessionId) {
      return []
    }
    if (this.turns.has(sessionId)) {
      return []
    }
    this.turns.set(sessionId, turn)
    return [{ type: 'turn.open', turn, at }]
  }

  end(
    sessionId: string,
    at: number,
    state: 'completed' | 'interrupted',
    outcome?: 'success' | 'failure' | 'cancellation'
  ): OpenCodeTimelineTranslation {
    if (sessionId !== this.options.sessionId) {
      const withdrawals = [...this.pending.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.request)
      for (const request of withdrawals) {
        this.pending.delete(request)
      }
      return {
        events: [{ type: 'producer.ended', agentId: sessionId, at, state }],
        withdrawnRequestIds: withdrawals
      }
    }
    const turn = this.turns.get(sessionId)
    if (!turn) {
      return { events: [], rootIdle: true }
    }
    this.turns.delete(sessionId)
    this.compactionIds.delete(sessionId)
    this.awaitingNativeInputs.length = 0
    const withdrawals = [...this.pending.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.request)
    for (const request of withdrawals) {
      this.pending.delete(request)
    }
    return {
      events: [
        ...withdrawals.map((request): ProviderTimelineEvent => ({
          type: 'request.withdrawn',
          request
        })),
        { type: 'turn.end', turn, at, state, ...(outcome ? { outcome } : {}) }
      ],
      withdrawnRequestIds: withdrawals,
      rootIdle: true
    }
  }

  noteInput(nativeId: string): string[] {
    if (nativeId.length > 512) {
      throw new OpenCodeHttpError('capacity', 'OpenCode message identity exceeds the limit')
    }
    if (this.accepted.has(nativeId)) {
      return []
    }
    const index = this.awaitingNativeInputs.findIndex(
      (expected) => !expected || expected === nativeId
    )
    if (index === -1) {
      return []
    }
    this.awaitingNativeInputs.splice(index, 1)
    this.accepted.add(nativeId)
    if (this.accepted.size > 128) {
      const oldest = this.accepted.values().next()
      if (!oldest.done) {
        this.accepted.delete(oldest.value)
      }
    }
    return [nativeId]
  }

  textSnapshot(
    id: string,
    channel: TextPart['channel'],
    text: string,
    done: boolean,
    sessionId: string
  ): ProviderTimelineEvent[] {
    const previous = this.texts.get(id)
    if (previous?.closed) {
      return []
    }
    const bounded = text.slice(0, MAX_TEXT)
    const events: ProviderTimelineEvent[] = []
    const joined = this.join(sessionId)
    if (!previous || bounded.startsWith(previous.text)) {
      const addition = bounded.slice(previous?.text.length ?? 0)
      if (addition) {
        events.push({ type: 'text.delta', item: { id }, channel, text: addition, ...joined })
      }
    } else {
      events.push({
        type: 'item.update',
        item: id,
        body: {
          kind: 'message',
          role: channel === 'assistant' ? 'assistant' : 'reasoning',
          blocks: [{ type: 'text', text: bounded }]
        },
        ...joined
      })
    }
    if (done) {
      events.push({ type: 'text.close', item: { id }, text: bounded, join: joined.join })
    }
    remember(this.texts, id, { text: bounded, channel, closed: done }, MAX_PARTS)
    return events
  }

  textDelta(
    id: string,
    channel: TextPart['channel'],
    delta: string,
    sessionId: string
  ): ProviderTimelineEvent[] {
    const previous = this.texts.get(id)
    if (previous?.closed || !delta) {
      return []
    }
    remember(
      this.texts,
      id,
      { text: ((previous?.text ?? '') + delta).slice(0, MAX_TEXT), channel, closed: false },
      MAX_PARTS
    )
    return [
      {
        type: 'text.delta',
        item: { id },
        channel,
        text: delta.slice(0, MAX_TEXT),
        ...this.join(sessionId)
      }
    ]
  }

  tool(
    id: string,
    name: string,
    input: unknown,
    state: Tool['state'],
    sessionId: string,
    output?: string,
    exitCode?: number
  ): ProviderTimelineEvent[] {
    const prior = this.tools.get(id)
    const next: Tool = {
      name: (name || prior?.name || 'tool').slice(0, 256),
      input: boundToolInput(input ?? prior?.input ?? {}, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      state
    }
    remember(this.tools, id, next, MAX_PARTS)
    if (next.name === 'question') {
      return []
    }
    const body = {
      kind: 'tool-call' as const,
      name: next.name,
      callId: id,
      input: next.input,
      state,
      ...(output === undefined
        ? {}
        : { output: boundPayload(output, DEFAULT_JOURNAL_PAYLOAD_LIMITS) }),
      ...(exitCode === undefined ? {} : { exitCode })
    }
    return [
      {
        type: !prior ? 'item.open' : state === 'running' ? 'item.update' : 'item.close',
        item: id,
        body,
        ...this.join(sessionId)
      }
    ]
  }

  request(
    kind: OpenCodePendingRequest['kind'],
    id: string,
    sessionId: string,
    body: ProviderTimelineRequestBody,
    native: Record<string, unknown>
  ): OpenCodeTimelineTranslation {
    return openRequest(this, kind, id, sessionId, body, native)
  }

  withdraw(nativeId: string, kind?: OpenCodePendingRequest['kind']): OpenCodeTimelineTranslation {
    return withdrawRequest(this, nativeId, kind)
  }
}
