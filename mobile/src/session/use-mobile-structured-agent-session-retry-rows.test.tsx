import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

function retry(sequence: number, attempt: number): AgentJournalRenderItem {
  return {
    itemId: `retry-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        {
          kind: 'providerRetrying',
          detail: { text: `Reconnecting... ${attempt}/5`, audience: 'person' },
          retry: { cause: 'stream disconnected before completion' }
        },
        { surface: 'row', agentName: 'Codex' }
      )
    }
  }
}

function snapshot(items: AgentJournalRenderItem[]): AgentSessionSubscribeEvent {
  const newest = items.length
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: newest },
        nextCursor: { epoch: 'epoch-1', sequence: newest + 1 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: newest },
      hasOlder: false,
      hasNewer: false
    }
  }
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('draws one row for a run of provider retries, with what failed on its second line', async () => {
  let listener: ((value: unknown) => void) | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  const client = {
    sendRequest: vi.fn(async () => ({ ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })),
    subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
      listener = onData
      return vi.fn()
    })
  } as unknown as RpcClient
  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError: vi.fn()
    } as never)
    return null
  }

  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  act(() => listener?.(snapshot([retry(1, 1), retry(2, 2), retry(3, 3)])))

  expect(hook?.session.messages.map((message) => message.blocks)).toEqual([
    [
      expect.objectContaining({
        type: 'text',
        text: 'Codex is retrying: Reconnecting... 3/5.\nstream disconnected before completion'
      })
    ]
  ])
})
