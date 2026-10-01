import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

function journalItem(
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

function snapshot(
  items: AgentJournalRenderItem[],
  fence: number,
  activity?: AgentSessionTurnActivity
): AgentSessionSubscribeEvent {
  const newest = items.length
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence,
    ...(activity ? { activity } : {}),
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence,
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

/** What the one live indicator row reads, resolved off the session journal. */
describe('useMobileStructuredAgentSession turn indicator', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  type RpcReply = { ok: boolean; result: unknown; _meta: { runtimeId: string } }
  const sendRequest = vi.fn(async (method: string): Promise<RpcReply> => ({
    ok: true,
    result:
      method === 'agentSession.options'
        ? {
            models: [{ id: 'gpt-fast', label: 'GPT Fast', isDefault: true, efforts: [] }],
            current: { model: 'gpt-fast' }
          }
        : {},
    _meta: { runtimeId: 'r1' }
  }))
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  const client = { sendRequest, subscribe } as unknown as RpcClient
  // Stable across renders: a fresh callback would re-run the hold/subscribe effect
  // and release the session out from under the test.
  const onSendError = vi.fn()

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError
    } as never)
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    listener = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  const runningTurn = journalItem(1, { kind: 'turn', turnId: 'turn-1', state: 'running' })
  const reasoning = journalItem(2, {
    kind: 'message',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Weighing two approaches' }]
  })

  it('reads the live turn as reasoning while reasoning is its newest content', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(snapshot([runningTurn, reasoning], 3))
    })

    expect(hook?.turnIndicator).toEqual({ thinking: true, activityText: null, stopping: false })
  })

  it('hands the row the provider copy once real content ends the reasoning', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(
        snapshot(
          [
            runningTurn,
            reasoning,
            journalItem(3, {
              kind: 'tool-call',
              name: 'shell',
              input: { command: 'pnpm lint' },
              state: 'running'
            }),
            journalItem(4, { kind: 'status', text: 'Context compacted' })
          ],
          3,
          { turnId: 'turn-1', text: 'Updating the plan' }
        )
      )
    })

    expect(hook?.turnIndicator).toEqual({
      thinking: false,
      activityText: 'Updating the plan',
      stopping: false
    })
  })

  it("reads Stopping from this phone's own Stop until its request answers", async () => {
    const passthrough = sendRequest.getMockImplementation()!
    type Reply = Awaited<ReturnType<typeof passthrough>>
    let answer: (value: Reply) => void = () => undefined
    // The Stop's request stays in flight until the test answers it; every other call is as usual.
    sendRequest.mockImplementation((method: string) =>
      method === 'agentSession.cancel'
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : passthrough(method)
    )
    onTestFinished(() => {
      sendRequest.mockImplementation(passthrough)
    })
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())
    act(() => {
      listener?.(snapshot([runningTurn], 3))
    })
    expect(hook?.turnIndicator.stopping).toBe(false)

    act(() => hook?.cancel())
    expect(hook?.turnIndicator.stopping).toBe(true)

    await act(async () => {
      const cancelled = { ok: true, value: { cancelled: true } }
      answer({ ok: true, result: cancelled, _meta: { runtimeId: 'r1' } })
    })
    await vi.waitFor(() => expect(hook?.turnIndicator.stopping).toBe(false))
  })

  it('never reads a journal status row as the live activity', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).not.toBeNull())

    act(() => {
      listener?.(
        snapshot(
          [
            runningTurn,
            journalItem(2, {
              kind: 'status',
              tone: 'warning',
              text: 'Claude hit a temporary problem and is retrying.'
            })
          ],
          3
        )
      )
    })

    expect(hook?.turnIndicator).toEqual({ thinking: false, activityText: null, stopping: false })
  })
})
