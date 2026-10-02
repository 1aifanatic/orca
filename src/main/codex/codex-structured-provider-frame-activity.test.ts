// Every Codex frame reaches the host's chat activity at receipt, a streamed delta the journal has
// not written a row for included: what background work gives way to.

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

describe('Codex provider frames as chat activity', () => {
  it('notes a streamed delta that writes no row', async () => {
    const codex = fakeCodex()
    const sink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      noteProviderFrame: vi.fn()
    } satisfies StructuredAgentSessionEventSink
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const frames = sink.noteProviderFrame.mock.calls.length
    const appends = sink.appendItem.mock.calls.length

    codex.connections[0]!.handlers.onNotification?.('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'streamed'
    })

    expect(sink.noteProviderFrame.mock.calls.length).toBe(frames + 1)
    expect(sink.appendItem.mock.calls.length).toBe(appends)
  })
})
