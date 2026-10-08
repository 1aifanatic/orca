import { expect, it } from 'vitest'
import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

function frame(permissionMode?: AgentChatPermissionMode | null): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 's',
    batch: {
      cursor: { epoch: 'e', sequence: 1 },
      submissions: [],
      removedItemIds: [],
      items: [
        {
          itemId: 'a',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'output' }] }
        }
      ]
    },
    ...(permissionMode !== undefined ? { permissionMode } : {})
  }
}

it.each([
  { modes: ['bypass', undefined], expected: 'bypass' },
  { modes: [undefined, 'bypass'], expected: 'bypass' },
  { modes: ['bypass', 'auto', 'ask'], expected: 'ask' },
  { modes: ['bypass', null, undefined], expected: null },
  { modes: [null, 'bypass'], expected: 'bypass' },
  { modes: [undefined, undefined], expected: 'ask' }
] satisfies {
  modes: (AgentChatPermissionMode | null | undefined)[]
  expected: AgentChatPermissionMode | null
}[])(
  'retains $expected through permission/output batches and the reducer ($modes)',
  ({ modes, expected }) => {
    const events: AgentSessionSubscribeEvent[] = []
    let state: StructuredAgentSessionState = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'e',
      permissionMode: 'ask' as const
    }
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
      events.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    })
    modes.forEach((mode) => coalescer.push(frame(mode)))
    coalescer.flush()
    expect(events).toHaveLength(1)
    expect(state.permissionMode).toBe(expected)
    expect(state.items).toHaveLength(1)
    if (modes.every((mode) => mode === undefined)) {
      expect(events[0]).not.toHaveProperty('permissionMode')
    } else {
      expect(events[0]).toHaveProperty('permissionMode', expected)
    }
    coalescer.dispose()
  }
)
