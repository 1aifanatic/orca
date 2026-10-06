import type { OpenCodeWireEvent } from './native-protocol'
import type { OpenCodeTimelineTranslation } from './timeline-contract'
import type { OpenCodeTimelineState } from './timeline-state'
import {
  approvalBody,
  questionBody,
  remember,
  number,
  object,
  string,
  strings,
  usage,
  errorWords,
  terminalState,
  valueAt,
  MAX_PARTS,
  MAX_TEXT
} from './timeline-shapes'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'

export function translateV1(
  state: OpenCodeTimelineState,
  event: OpenCodeWireEvent,
  sessionId: string,
  at: number
): OpenCodeTimelineTranslation {
  const d = event.data
  const p = object(d.part)
  const info = object(d.info)
  if (event.type === 'message.updated' && info) {
    const id = string(info.id)
    if (!id) {
      return { events: [] }
    }
    remember(state.messageRole, id, string(info.role) ?? '', MAX_PARTS)
    if (info.role === 'user') {
      const accepted = sessionId === state.options.sessionId ? state.noteInput(id) : []
      const events = accepted.length === 0 ? state.open(sessionId, id, at) : []
      return {
        events,
        ...(accepted.length ? { acceptedNativeMessageIds: accepted } : {})
      }
    }
    if (info.role === 'assistant' && number(valueAt(info, 'time', 'completed')) !== undefined) {
      const events: ProviderTimelineEvent[] = []
      for (const [partId, messageId] of state.textMessage) {
        if (messageId !== id) {
          continue
        }
        const part = state.texts.get(partId)
        if (part && !part.closed) {
          events.push(...state.textSnapshot(partId, part.channel, part.text, true, sessionId))
        }
      }
      return { events }
    }
    return { events: [] }
  }
  if (event.type === 'message.part.delta') {
    const id = string(d.partID)
    const delta = string(d.delta)
    const channel = state.texts.get(id ?? '')?.channel
    return {
      events:
        id && delta && d.field === 'text' && channel
          ? state.textDelta(id, channel, delta, sessionId)
          : []
    }
  }
  if (event.type === 'message.part.updated' && p) {
    const id = string(p.id)
    const messageId = string(p.messageID)
    if (!id) {
      return { events: [] }
    }
    if (p.type === 'text' || p.type === 'reasoning') {
      if (p.type === 'text' && state.messageRole.get(messageId ?? '') === 'user') {
        if (sessionId === state.options.sessionId && state.accepted.has(messageId ?? '')) {
          return { events: [] }
        }
        return {
          events: [
            {
              type: 'item.update',
              item: id,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: (string(p.text) ?? '').slice(0, MAX_TEXT) }]
              },
              ...state.join(sessionId)
            }
          ]
        }
      }
      if (messageId) {
        remember(state.textMessage, id, messageId, MAX_PARTS)
      }
      return {
        events: state.textSnapshot(
          id,
          p.type === 'text' ? 'assistant' : 'reasoning',
          string(p.text) ?? '',
          number(valueAt(p, 'time', 'end')) !== undefined,
          sessionId
        )
      }
    }
    if (p.type === 'tool') {
      const toolState = object(p.state)
      const callId = string(p.callID) ?? id
      const name = string(p.tool) ?? 'tool'
      const status = terminalState(toolState?.status)
      const output = string(toolState?.output) ?? string(valueAt(toolState, 'metadata', 'output'))
      const childId =
        string(valueAt(toolState, 'metadata', 'sessionId')) ??
        string(valueAt(toolState, 'metadata', 'sessionID'))
      if (childId && state.ownsSession(childId)) {
        state.childCall.set(childId, callId)
      }
      return {
        events: state.tool(
          callId,
          name,
          toolState?.input,
          status,
          sessionId,
          output,
          status === 'completed'
            ? (number(valueAt(toolState, 'metadata', 'exit')) ??
                number(valueAt(toolState, 'metadata', 'exitCode')))
            : undefined
        )
      }
    }
    if (p.type === 'step-finish') {
      if (sessionId !== state.options.sessionId) {
        return { events: [] }
      }
      const key = `${sessionId}:${id}`
      if (state.seenUsage.has(key)) {
        return { events: [] }
      }
      remember(state.seenUsage, key, id, MAX_PARTS)
      const measured = usage(p.tokens, at, state.contextWindowTokens)
      return { events: measured ? [{ ...measured, ...state.join(sessionId) }] : [] }
    }
    if (p.type === 'compaction') {
      state.compactionIds.set(sessionId, id)
      return {
        events: [
          {
            type: 'item.open',
            item: id,
            body: { kind: 'status', text: 'Compacting context' },
            ...state.join(sessionId)
          },
          ...(sessionId === state.options.sessionId
            ? [
                {
                  type: 'context.usage',
                  usage: { used: { kind: 'unknown', capturedAt: at } },
                  ...state.join(sessionId)
                } as const
              ]
            : [])
        ]
      }
    }
    return { events: [] }
  }
  if (event.type === 'permission.asked' || event.type === 'question.asked') {
    const id = string(d.id)
    if (!id) {
      return { events: [] }
    }
    if (event.type === 'permission.asked') {
      const permission = string(d.permission) ?? 'unknown'
      const patterns = strings(d.patterns)
      return state.request(
        'permission',
        id,
        sessionId,
        approvalBody(
          permission,
          patterns,
          strings(d.always).some((rule) => rule.trim().length > 0)
        ),
        d
      )
    }
    return state.request('question', id, sessionId, questionBody(d.questions), d)
  }
  if (
    event.type === 'permission.replied' ||
    event.type === 'question.replied' ||
    event.type === 'question.rejected'
  ) {
    return state.withdraw(string(d.requestID) ?? '')
  }
  if (event.type === 'session.error') {
    const error = object(d.error)
    const aborted = string(error?.name) === 'MessageAbortedError'
    const events: ProviderTimelineEvent[] = aborted
      ? []
      : [
          {
            type: 'item.open',
            item: `error:${state.turns.get(sessionId) ?? at}`,
            body: { kind: 'status', text: errorWords(d.error) },
            ...state.join(sessionId)
          }
        ]
    const end = state.end(
      sessionId,
      at,
      aborted ? 'interrupted' : 'completed',
      aborted ? 'cancellation' : 'failure'
    )
    return { ...end, events: [...events, ...end.events] }
  }
  if (event.type === 'session.status') {
    const status = string(valueAt(d, 'status', 'type'))
    if (status === 'idle') {
      return state.end(sessionId, at, 'completed', 'success')
    }
    return { events: [] }
  }
  if (event.type === 'session.idle') {
    return state.end(sessionId, at, 'completed', 'success')
  }
  if (event.type === 'session.compacted') {
    const id = state.compactionIds.get(sessionId)
    state.compactionIds.delete(sessionId)
    return {
      events: [
        {
          type: id ? 'item.close' : 'item.open',
          item: id ?? `compaction:${sessionId}:${at}`,
          body: { kind: 'status', text: 'Context compacted' },
          ...state.join(sessionId)
        }
      ]
    }
  }
  return { events: [] }
}
