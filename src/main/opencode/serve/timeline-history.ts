import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { OpenCodeTimelineState } from './timeline-state'
import {
  array,
  number,
  object,
  string,
  terminalState,
  textContent,
  usage,
  valueAt,
  remember,
  MAX_PARTS,
  MAX_TEXT
} from './timeline-shapes'

export function translateHistory(
  state: OpenCodeTimelineState,
  messages: unknown
): ProviderTimelineEvent[] {
  const entries = array(object(messages)?.data ?? messages)
  const events: ProviderTimelineEvent[] = []
  const root = state.options.sessionId
  let lastCompleted = false
  let lastAt = 0
  for (const candidate of entries) {
    const entry = object(candidate)
    if (!entry) {
      continue
    }
    if (state.options.major === 1) {
      const info = object(entry.info)
      const id = string(info?.id)
      if (!id || string(info?.sessionID) !== root) {
        continue
      }
      const role = string(info?.role)
      const created = number(valueAt(info, 'time', 'created')) ?? Date.now()
      if (role === 'user') {
        if (state.turns.has(root)) {
          events.push(
            ...state.end(
              root,
              lastAt || created,
              'completed',
              lastCompleted ? 'success' : undefined
            ).events
          )
        }
        events.push(...state.open(root, id, created))
        const text = array(entry.parts)
          .map((part) => object(part))
          .filter((part) => part?.type === 'text' && part.synthetic !== true)
          .map((part) => string(part?.text) ?? '')
          .join('\n')
        events.push({
          type: 'item.open',
          item: id,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: text.slice(0, MAX_TEXT) }]
          },
          ...state.join(root)
        })
        lastCompleted = false
        lastAt = created
        continue
      }
      if (role !== 'assistant') {
        continue
      }
      for (const partValue of array(entry.parts)) {
        const part = object(partValue)
        const partId = string(part?.id)
        if (!partId) {
          continue
        }
        if (part?.type === 'text' || part?.type === 'reasoning') {
          events.push(
            ...state.textSnapshot(
              partId,
              part.type === 'text' ? 'assistant' : 'reasoning',
              string(part.text) ?? '',
              true,
              root
            )
          )
        } else if (part?.type === 'tool') {
          const toolState = object(part.state)
          const status = terminalState(toolState?.status)
          const metadata = object(toolState?.metadata)
          events.push(
            ...state.tool(
              string(part.callID) ?? partId,
              string(part.tool) ?? 'tool',
              toolState?.input,
              status,
              root,
              string(toolState?.output) ?? string(metadata?.output),
              status === 'completed'
                ? (number(metadata?.exit) ?? number(metadata?.exitCode))
                : undefined
            )
          )
        } else if (part?.type === 'step-finish') {
          const measured = usage(part.tokens, created)
          remember(state.seenUsage, `${root}:${partId}`, partId, MAX_PARTS)
          if (measured) {
            events.push({ ...measured, ...state.join(root) })
          }
        }
      }
      const completed = number(valueAt(info, 'time', 'completed'))
      lastCompleted = completed !== undefined
      lastAt = completed ?? created
    } else {
      const id = string(entry.id)
      if (!id) {
        continue
      }
      const created = number(valueAt(entry, 'time', 'created')) ?? Date.now()
      if (entry.type === 'user') {
        if (state.turns.has(root)) {
          events.push(
            ...state.end(
              root,
              lastAt || created,
              'completed',
              lastCompleted ? 'success' : undefined
            ).events
          )
        }
        events.push(...state.open(root, id, created))
        events.push({
          type: 'item.open',
          item: id,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: (string(entry.text) ?? '').slice(0, MAX_TEXT) }]
          },
          ...state.join(root)
        })
        lastCompleted = false
        lastAt = created
        continue
      }
      if (entry.type !== 'assistant') {
        continue
      }
      let textOrdinal = 0
      let reasoningOrdinal = 0
      for (const contentValue of array(entry.content)) {
        const content = object(contentValue)
        if (!content) {
          continue
        }
        if (content.type === 'text' || content.type === 'reasoning') {
          const channel = content.type === 'text' ? 'assistant' : 'reasoning'
          const ordinal = content.type === 'text' ? textOrdinal++ : reasoningOrdinal++
          events.push(
            ...state.textSnapshot(
              `${id}:${content.type}:${ordinal}`,
              channel,
              string(content.text) ?? '',
              true,
              root
            )
          )
        } else if (content.type === 'tool') {
          const callId = string(content.id)
          if (!callId) {
            continue
          }
          const toolState = object(content.state)
          const status = terminalState(toolState?.status)
          events.push(
            ...state.tool(
              callId,
              string(content.name) ?? 'tool',
              toolState?.input,
              status,
              root,
              textContent(toolState?.content),
              number(valueAt(toolState, 'metadata', 'exit'))
            )
          )
        }
      }
      const measured = usage(entry.tokens, created)
      remember(state.seenUsage, `${root}:${id}`, id, MAX_PARTS)
      if (measured) {
        events.push({ ...measured, ...state.join(root) })
      }
      const completed = number(valueAt(entry, 'time', 'completed'))
      lastCompleted = completed !== undefined
      lastAt = completed ?? created
    }
  }
  if (state.turns.has(root) && lastCompleted) {
    events.push(...state.end(root, lastAt, 'completed', 'success').events)
  }
  return events
}
