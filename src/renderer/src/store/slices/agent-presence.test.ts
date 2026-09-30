import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
const presence = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} as const

describe('host process ownership mirror', () => {
  it('survives turn dismissal and transport disappearance until the host reports exit', () => {
    const store = createTestStore()
    store
      .getState()
      .recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: 'ssh-a' })
    store.getState().removeAgentStatus(paneKey)
    store.getState().clearTransientAgentStatuses('ssh-a', 11)
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
    store.getState().recordAgentPresence(paneKey, {
      presence: { ...presence, ended: true },
      receivedAt: 12,
      connectionId: 'ssh-a'
    })
    store
      .getState()
      .recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: 'ssh-a' })
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence.ended).toBe(true)
  })

  it('commits ownership with a status batch and forgets it on explicit pane retirement', () => {
    const store = createTestStore()
    const initial = store.getState()
    initial.transactAgentStatuses((transaction) => {
      transaction
        .getState()
        .recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
      expect(store.getState()).toBe(initial)
      expect(transaction.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
    })
    store.getState().retireAgentPaneAuthority(paneKey)
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
  })
  it('drops owner-only records when their pane or workspace is explicitly removed', () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, worktreeId: 'wt-1' })
    store.getState().dropAgentStatus(paneKey)
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeDefined()
    store.getState().dropAgentStatus(paneKey, { paneRemoved: true })
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 11, worktreeId: 'wt-1' })
    store
      .getState()
      .recordAgentPresence('other:leaf', { presence, receivedAt: 11, worktreeId: 'wt-2' })
    store.getState().dropAgentStatusByWorktree('wt-1')
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().agentPresenceByPaneKey['other:leaf']).toBeDefined()
  })
})
