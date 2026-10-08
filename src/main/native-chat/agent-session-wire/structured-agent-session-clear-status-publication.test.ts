import { expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { CALLER, attach, hostTestState } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'

async function clear(sessionId: string): Promise<string> {
  const { host, store } = hostTestState()
  const result = await host.conversationCommand(CALLER, {
    command: 'clear',
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(sessionId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId,
        fields: { command: 'clear' }
      })
    }
  })
  if (!result.ok || !result.value.replacementSessionId) {
    throw new Error('test clear did not commit a replacement')
  }
  return result.value.replacementSessionId
}

it.each([false, true])(
  'updates an existing subscriber at the clear commit, with retired predecessor=%s',
  async (retireBeforeCommit) => {
    const { host, store, acquire } = hostTestState()
    await attach()
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    await store.setConversationName(HOST_TEST_SESSION, 'Original name')
    host.publishConversationName(HOST_TEST_SESSION)
    const latest = new Map<string, AgentSessionStatusSummary>()
    const ownershipEvents: string[] = []
    let snapshots = 0
    host.subscribeStatus({
      id: 'already-open',
      emit: (event) => {
        if (event.type === 'snapshot') {
          snapshots++
          for (const summary of event.sessions) {
            latest.set(summary.sessionId, summary)
          }
        } else if (event.type === 'status') {
          if (
            latest.get(event.session.sessionId)?.orchestrationSessionId !==
            event.session.orchestrationSessionId
          ) {
            ownershipEvents.push(event.session.sessionId)
          }
          latest.set(event.session.sessionId, event.session)
        }
      }
    })
    let failedTransport = 0
    host.subscribeStatus({
      id: 'failed-transport',
      emit: (event) => {
        if (event.type === 'status' && event.session.orchestrationSessionId === null) {
          failedTransport++
          throw new Error('transport disconnected')
        }
      }
    })
    expect(latest.get(HOST_TEST_SESSION)?.orchestrationSessionId).toBe(HOST_TEST_SESSION)
    const retainedAtCommit = new Map<string, AgentSessionStatusSummary>()
    const commit = store.commitConversationClear
    vi.spyOn(store, 'commitConversationClear').mockImplementation(async (input) => {
      const sessions = host.collaboratorsForTests().sessions
      const session = sessions.get(input.sessionId)
      expect(session?.child).toBeNull()
      expect(store.getRecord(input.sessionId)?.lease.claimStatus).toBe('released')
      expect(session?.journal.queuedMessages.list()).toEqual([])
      retainedAtCommit.set(input.sessionId, latest.get(input.sessionId)!)
      if (retireBeforeCommit && session) {
        // Model an independently retired journal cache; normal stop alone keeps this handle.
        sessions.delete(input.sessionId)
        await session.journal.close()
      }
      expect(host.hasSession(input.sessionId)).toBe(!retireBeforeCommit)
      await commit(input)
    })

    const first = await clear(HOST_TEST_SESSION)
    // The commit itself must update the existing subscriber, before RPC close or successor open.
    expect(latest.get(HOST_TEST_SESSION)).toEqual({
      ...retainedAtCommit.get(HOST_TEST_SESSION),
      orchestrationSessionId: null
    })
    expect(host.hasSession(first)).toBe(false)
    expect(latest.has(first)).toBe(false)
    const beforeReplay = [...ownershipEvents]
    await expect(clear(HOST_TEST_SESSION)).resolves.toBe(first)
    expect(ownershipEvents).toEqual(beforeReplay)
    await host.close(HOST_TEST_SESSION, 'user-close')
    await host.revealSession(first)
    expect(latest.get(first)?.orchestrationSessionId).toBe(HOST_TEST_SESSION)
    const second = await clear(first)
    expect(latest.get(first)?.orchestrationSessionId).toBeNull()
    await host.close(first, 'user-close')
    await host.revealSession(second)

    // Explicitly reopened history remains readable without reclaiming the current root.
    await host.revealSession(HOST_TEST_SESSION)
    await host.revealSession(first)
    await store.setConversationName(second, 'Renamed successor')
    host.publishConversationName(second)
    expect(latest.get(second)).toMatchObject({
      conversationName: 'Renamed successor',
      orchestrationSessionId: HOST_TEST_SESSION
    })
    expect(
      [...latest.values()]
        .filter((summary) => summary.orchestrationSessionId === HOST_TEST_SESSION)
        .map((summary) => summary.sessionId)
    ).toEqual([second])
    expect(snapshots).toBe(1)
    expect(failedTransport).toBe(1)
    expect(acquire).toHaveBeenCalledOnce()
  }
)

it('does not retire the current root when the clear record fails to commit', async () => {
  const { host, store } = hostTestState()
  await attach()
  host.subscribeStatus({ id: 'already-open', emit: () => {} })
  vi.spyOn(store, 'commitConversationClear').mockRejectedValueOnce(new Error('disk full'))
  await expect(clear(HOST_TEST_SESSION)).rejects.toThrow('disk full')
  expect(host.readStatusSummary(HOST_TEST_SESSION)?.orchestrationSessionId).toBe(HOST_TEST_SESSION)
  expect(store.listRecords()).toHaveLength(1)
})

it('reports a projection failure without rejecting the committed clear', async () => {
  const { host, store, log } = hostTestState()
  await attach()
  host.subscribeStatus({ id: 'already-open', emit: () => {} })
  const commit = store.commitConversationClear
  vi.spyOn(store, 'commitConversationClear').mockImplementationOnce(async (input) => {
    await commit(input)
    vi.spyOn(store, 'listRecords').mockImplementationOnce(() => {
      throw new Error('projection unavailable')
    })
  })
  const replacement = await clear(HOST_TEST_SESSION)
  expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
    phase: 'committed',
    replacementSessionId: replacement
  })
  expect(log.scopes()).toContain('conversation-command-status')
  // The existing reload projection re-derives truth after the failed notification.
  host.subscribeStatus({ id: 'reloaded', emit: () => {} })
  expect(host.readStatusSummary(HOST_TEST_SESSION)?.orchestrationSessionId).toBeNull()
})
