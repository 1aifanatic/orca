import { expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState,
  seedApproval
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { STRUCTURED_AGENT_SESSION_UNANSWERED_PROMPT_MAX_AGE_MS as MAX_AGE } from '../native-chat/agent-session-wire/structured-agent-session-server-lifetime'

it('keeps an unanswered approval alive for 24 hours, then cancels it and releases the child', async () => {
  await attach()
  const { host, acquire } = hostTestState()
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('provider not attached')
  }
  events.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'pending', ordinal: 50 },
    { kind: 'turn', turnId: 'pending', state: 'running' },
    { turnScope: { kind: 'thread' } }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  const approval = await seedApproval()
  const requestedAt = (await host.journalSnapshot(HOST_TEST_SESSION)).items.find(
    (item) => item.itemId === approval.itemId
  )?.observedAt
  if (requestedAt === undefined) {
    throw new Error('approval missing')
  }
  const now = vi.spyOn(host.deps, 'now').mockReturnValue(requestedAt + MAX_AGE - 1)
  try {
    await host.serverRetirement.expireUnansweredPrompts()
    expect(host.serverRetirement.read()).toBeGreaterThan(0)
    expect(
      (await host.journalSnapshot(HOST_TEST_SESSION)).items.find(
        (item) => item.itemId === approval.itemId
      )?.body
    ).toMatchObject({ resolution: { state: 'pending' } })
    now.mockReturnValue(requestedAt + MAX_AGE)
    await host.serverRetirement.expireUnansweredPrompts()
    expect(
      (await host.journalSnapshot(HOST_TEST_SESSION)).items.find(
        (item) => item.itemId === approval.itemId
      )?.body
    ).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(
      (await host.journalSnapshot(HOST_TEST_SESSION)).items.some(
        ({ body }) => body.kind === 'turn' && body.state === 'interrupted'
      )
    ).toBe(true)
    await vi.waitFor(() => expect(host.serverRetirement.read()).toBe(0))
  } finally {
    now.mockRestore()
  }
})
