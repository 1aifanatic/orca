// The strip channel keeps one fingerprint per conversation to skip an unchanged roster; a closed
// conversation's goes with it.

import { describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const child: AgentChildWorkView = {
  id: 'child-1',
  providerId: 'task-1',
  kind: 'agent',
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 1,
  stoppable: true,
  invocation: { invocationId: 'spawn-1', generation: 1 }
}

function channelOver() {
  const sessions = new StructuredAgentSessionConversations({
    deliver: () => {},
    onDeliveryError: () => {},
    now: () => 1
  })
  const sent = vi.fn()
  const channel = new StructuredAgentSessionBackgroundTaskChannel(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel reads only the record store's fence and the adapter's stop capability.
    {
      store: { getRecord: () => null },
      adapter: { backgroundTaskStops: () => ({ supportsTaskStop: true, supportsStopAll: true }) }
    } as unknown as StructuredAgentSessionHostDeps,
    sessions,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publish sends through `backgroundTasks` only.
    { backgroundTasks: sent } as unknown as AgentSessionSubscribers,
    async () => {
      throw new Error('not opened here')
    },
    () => [child]
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the map reads only the journal's commit observer and the session's provider.
  const session = {
    journal: { observeCommits: () => {} },
    params: { provider: 'claude' }
  } as unknown as StructuredAgentSessionHostSession
  return { sessions, sent, channel, session }
}

describe('the background-task channel', () => {
  it("forgets a closed conversation's roster, so reopening it sends the roster again", () => {
    const { sessions, sent, channel, session } = channelOver()
    sessions.set('session-1', session)
    channel.publish('session-1')
    channel.publish('session-1')
    // An unchanged roster sends nothing.
    expect(sent).toHaveBeenCalledTimes(1)

    sessions.delete('session-1')
    expect(channel['published'].size).toBe(0)
    sessions.set('session-1', session)
    channel.publish('session-1')
    expect(sent).toHaveBeenCalledTimes(2)
  })
})
