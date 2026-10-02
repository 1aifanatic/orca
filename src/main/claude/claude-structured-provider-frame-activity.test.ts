// Every Claude frame reaches the host's chat activity as it is delivered, a streamed delta the
// journal has not written a row for included: what background work gives way to.

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('Claude provider frames as chat activity', () => {
  it('notes a streamed delta that writes no row', async () => {
    const claude = fakeClaude()
    const sink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      noteProviderFrame: vi.fn()
    } satisfies StructuredAgentSessionEventSink
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const delta = (uuid: string) =>
      claude.connections[0]!.handlers.onMessage?.({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        session_id: PROVIDER_SESSION_ID,
        uuid
      })
    // The block's first text is its first checkpoint; later deltas wait for it to grow.
    delta('stream-1')
    await settle()
    const frames = sink.noteProviderFrame.mock.calls.length
    const appends = sink.appendItem.mock.calls.length

    delta('stream-2')
    await settle()

    expect(sink.noteProviderFrame.mock.calls.length).toBe(frames + 1)
    expect(sink.appendItem.mock.calls.length).toBe(appends)
  })
})
