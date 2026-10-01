import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

function summary(stopping: boolean): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agent: 'codex',
    status: 'working',
    latestPrompt: 'ship it',
    updatedAt: 1,
    hostExecutionOwned: true,
    ...(stopping ? { stopping: true } : {})
  }
}

describe("the phone's status stream", () => {
  let frames: ((value: unknown) => void)[]
  let stateListeners: ((state: ConnectionState) => void)[]
  let client: RpcClient

  beforeEach(() => {
    frames = []
    stateListeners = []
    // A fresh client per test: the stream is one per client for its life.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reaches the client only through subscribe and onStateChange.
    client = {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
        frames.push(onData)
        return () => {}
      }),
      onStateChange: (listener: (state: ConnectionState) => void) => {
        stateListeners.push(listener)
        return () => {}
      }
    } as unknown as RpcClient
  })

  function read(): AgentSessionStatusSummary | undefined {
    return mobileStructuredSessionStatusFeed(client).getSnapshot().get('session-1')
  }

  function connection(state: ConnectionState): void {
    for (const listener of stateListeners) {
      listener(state)
    }
  }

  it('opens one stream per client however many chats read it', () => {
    const feed = mobileStructuredSessionStatusFeed(client)
    feed.subscribe(() => {})
    mobileStructuredSessionStatusFeed(client).subscribe(() => {})

    expect(client.subscribe).toHaveBeenCalledOnce()
    expect(client.subscribe).toHaveBeenCalledWith(
      'agentSession.subscribeStatus',
      {},
      expect.any(Function)
    )
  })

  it("follows the host's Stopping from the snapshot through each status frame", () => {
    const listener = vi.fn()
    mobileStructuredSessionStatusFeed(client).subscribe(listener)

    frames[0]?.({ type: 'snapshot', sessions: [summary(true)] })
    expect(read()?.stopping).toBe(true)

    frames[0]?.({ type: 'status', session: summary(false) })
    expect(read()).toMatchObject({ status: 'working' })
    expect(read()).not.toHaveProperty('stopping')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('drops Stopping when the host ends the stream, and opens it again on the next connection', () => {
    mobileStructuredSessionStatusFeed(client).subscribe(() => {})
    frames[0]?.({ type: 'snapshot', sessions: [summary(true)] })

    frames[0]?.({ type: 'end' })

    expect(read()).not.toHaveProperty('stopping')
    connection('connected')
    expect(client.subscribe).toHaveBeenCalledTimes(2)
  })

  it('drops Stopping, keeping the rest, once the phone loses contact', () => {
    mobileStructuredSessionStatusFeed(client).subscribe(() => {})
    frames[0]?.({ type: 'snapshot', sessions: [summary(true)] })

    connection('reconnecting')

    expect(read()).toMatchObject({ sessionId: 'session-1', status: 'working' })
    expect(read()).not.toHaveProperty('stopping')
    expect(read()).not.toHaveProperty('hostExecutionOwned')
  })

  it('reads a host that refuses the method to phones as one without it, and never asks again', () => {
    mobileStructuredSessionStatusFeed(client).subscribe(() => {})

    // As the host's mobile gate answers it, through the client's failed-opener frame.
    const refusal = "Method 'agentSession.subscribeStatus' is not available to mobile clients"
    frames[0]?.({ type: 'error', message: refusal, error: { code: 'forbidden', message: refusal } })
    connection('reconnecting')
    connection('connected')
    mobileStructuredSessionStatusFeed(client).subscribe(() => {})

    expect(client.subscribe).toHaveBeenCalledOnce()
    expect(read()).toBeUndefined()
  })
})
