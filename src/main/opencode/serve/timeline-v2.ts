import type { OpenCodeWireEvent } from './native-protocol'
import type { OpenCodeTimelineTranslation } from './timeline-contract'
import type { OpenCodeTimelineState } from './timeline-state'
import {
  approvalBody,
  questionBody,
  textContent,
  remember,
  number,
  object,
  string,
  strings,
  usage,
  errorWords,
  valueAt,
  MAX_PARTS,
  MAX_TEXT
} from './timeline-shapes'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'

export function translateV2(
  state: OpenCodeTimelineState,
  event: OpenCodeWireEvent,
  sessionId: string,
  at: number
): OpenCodeTimelineTranslation {
  const d = event.data
  const assistantId = string(d.assistantMessageID)
  const callId = string(d.id)
  if (event.type === 'session.inbox.enqueued' || event.type === 'session.inbox.delivered') {
    const id = string(d.inboxID)
    if (!id) {
      return { events: [] }
    }
    const item = object(d.item)
    const alreadyAccepted = state.accepted.has(id)
    const accepted =
      item?.type === 'user' && sessionId === state.options.sessionId ? state.noteInput(id) : []
    const events =
      item?.type === 'user' && accepted.length === 0 && !alreadyAccepted
        ? state.open(sessionId, id, at)
        : []
    if (item?.type === 'user' && accepted.length === 0 && !alreadyAccepted) {
      events.push({
        type: 'item.open',
        item: id,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: (string(valueAt(item, 'payload', 'text')) ?? '').slice(0, MAX_TEXT)
            }
          ]
        },
        ...state.join(sessionId)
      })
    }
    return {
      events,
      ...(accepted.length ? { acceptedNativeMessageIds: accepted } : {})
    }
  }
  if (event.type === 'session.execution.started') {
    return { events: state.open(sessionId, `execution:${sessionId}:${event.id ?? at}`, at) }
  }
  if (event.type === 'session.execution.succeeded') {
    return state.end(sessionId, at, 'completed', 'success')
  }
  if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
    const failed = event.type === 'session.execution.failed'
    const events: ProviderTimelineEvent[] = failed
      ? [
          {
            type: 'item.open',
            item: `error:${state.turns.get(sessionId) ?? at}`,
            body: { kind: 'status', text: errorWords(d.error) },
            ...state.join(sessionId)
          }
        ]
      : []
    const end = state.end(
      sessionId,
      at,
      failed ? 'completed' : 'interrupted',
      failed ? 'failure' : undefined
    )
    return { ...end, events: [...events, ...end.events] }
  }
  if (
    event.type.startsWith('session.execution.') &&
    /(?:ended|completed|cancelled|terminated|stopped|aborted)$/.test(event.type)
  ) {
    const join = state.join(sessionId).join
    const end = state.end(sessionId, at, 'interrupted')
    return {
      ...end,
      events: [
        {
          type: 'provider.frame',
          frameKind: event.type,
          payload: d,
          join
        },
        ...end.events
      ]
    }
  }
  if (event.type === 'session.reasoning.delta' || event.type === 'session.text.delta') {
    const ordinal = number(d.ordinal)
    const id =
      assistantId && ordinal !== undefined
        ? `${assistantId}:${event.type.includes('reasoning') ? 'reasoning' : 'text'}:${ordinal}`
        : undefined
    return {
      events: id
        ? state.textDelta(
            id,
            event.type.includes('reasoning') ? 'reasoning' : 'assistant',
            string(d.delta) ?? '',
            sessionId
          )
        : []
    }
  }
  if (event.type === 'session.reasoning.ended' || event.type === 'session.text.ended') {
    const ordinal = number(d.ordinal)
    const id =
      assistantId && ordinal !== undefined
        ? `${assistantId}:${event.type.includes('reasoning') ? 'reasoning' : 'text'}:${ordinal}`
        : undefined
    return {
      events: id
        ? state.textSnapshot(
            id,
            event.type.includes('reasoning') ? 'reasoning' : 'assistant',
            string(d.text) ?? '',
            true,
            sessionId
          )
        : []
    }
  }
  if (event.type === 'session.tool.input.started' && callId) {
    return { events: state.tool(callId, string(d.name) ?? 'tool', {}, 'running', sessionId) }
  }
  if (event.type === 'session.tool.called' && callId) {
    return {
      events: state.tool(
        callId,
        state.tools.get(callId)?.name ?? 'tool',
        d.input,
        'running',
        sessionId
      )
    }
  }
  if (event.type === 'session.tool.progress' && callId) {
    const childId = string(valueAt(d, 'metadata', 'sessionID'))
    if (childId && state.ownsSession(childId)) {
      state.childCall.set(childId, callId)
    }
    return { events: [] }
  }
  if ((event.type === 'session.tool.success' || event.type === 'session.tool.failed') && callId) {
    const failure = event.type === 'session.tool.failed'
    const output = failure ? errorWords(d.error) : textContent(d.content)
    const exitCode = number(valueAt(d, 'metadata', 'exit'))
    return {
      events: state.tool(
        callId,
        state.tools.get(callId)?.name ?? 'tool',
        undefined,
        failure ? 'failed' : 'completed',
        sessionId,
        output,
        exitCode
      )
    }
  }
  if (event.type === 'permission.asked' && callId) {
    const permission = string(d.action) ?? 'unknown'
    const patterns = strings(d.resources)
    return state.request(
      'permission',
      callId,
      sessionId,
      approvalBody(
        permission,
        patterns,
        strings(d.save).some((rule) => rule.trim().length > 0)
      ),
      d
    )
  }
  if (event.type === 'form.created') {
    const form = object(d.form)
    const id = string(form?.id)
    return id
      ? state.request('form', id, sessionId, questionBody(form?.fields), { ...d, form })
      : { events: [] }
  }
  if (
    event.type === 'permission.replied' ||
    event.type === 'form.replied' ||
    event.type === 'form.cancelled'
  ) {
    return state.withdraw(string(d.requestID) ?? callId ?? '')
  }
  if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
    if (sessionId !== state.options.sessionId) {
      return { events: [] }
    }
    const id = assistantId ?? event.id
    if (!id || state.seenUsage.has(`${sessionId}:${id}`)) {
      return { events: [] }
    }
    remember(state.seenUsage, `${sessionId}:${id}`, id, MAX_PARTS)
    const measured = usage(d.tokens, at, state.contextWindowTokens)
    return { events: measured ? [{ ...measured, ...state.join(sessionId) }] : [] }
  }
  if (event.type === 'session.compaction.started') {
    const id = `compaction:${string(d.inputID) ?? at}`
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
  if (event.type === 'session.compaction.ended' || event.type === 'session.compaction.failed') {
    const id = state.compactionIds.get(sessionId)
    state.compactionIds.delete(sessionId)
    return {
      events: [
        {
          type: id ? 'item.close' : 'item.open',
          item: id ?? `compaction:${sessionId}:${at}`,
          body: {
            kind: 'status',
            text: event.type.endsWith('failed') ? errorWords(d.error) : 'Context compacted'
          },
          ...state.join(sessionId)
        }
      ]
    }
  }
  return { events: [] }
}
