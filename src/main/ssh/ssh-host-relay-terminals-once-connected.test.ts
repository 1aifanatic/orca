import { describe, expect, it } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'
import type { ListRelayPtyIds } from './orcad-migration-terminal-gate'
import { relayTerminalsOnceConnected } from './ssh-host-relay-terminals-once-connected'

function store(leases: Pick<SshRemotePtyLease, 'ptyId' | 'state'>[]) {
  const full = leases.map((lease) => ({ ...lease, targetId: 'ssh-1', createdAt: 1, updatedAt: 1 }))
  return { getSshRemotePtyLeases: () => full }
}

function relay(current: string[] | null, previous: string[] | null = []): ListRelayPtyIds {
  const list: ListRelayPtyIds = async () => current
  list.previous = async () => previous
  return list
}

const unverifiable: HostServerOnConnectResult = {
  route: 'relay',
  reason: 'relay_terminals_unverifiable',
  terminals: 1
}
const detached = store([{ ptyId: 'pty-1', state: 'detached' }])

describe('re-checking relay terminals once the relay session is up', () => {
  // The Windows connect: no endpoint census, so the detached lease read unverifiable at decide time.
  it('reports live when the connected relay still runs the detached terminal', async () => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: relay(['pty-1'])
      })
    ).resolves.toEqual({ route: 'relay', reason: 'relay_terminals_live', terminals: 1 })
  })

  it.each([
    ['the relay still cannot answer', relay(null)],
    ['earlier relays cannot be asked', relay([], null)],
    // Exited waits for the next connect, which can convert; this one already runs the relay.
    ['every relay answers that it exited', relay([], [])]
  ])('keeps the first decision when %s', async (_label, list) => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: list
      })
    ).resolves.toBeNull()
  })

  it.each([
    [
      'a decision that was not unverifiable',
      { route: 'relay', reason: 'relay_terminals_live', terminals: 1 }
    ],
    ['a managed decision', { route: 'managed', environmentId: 'env-1' }],
    ['no decision', null]
  ] as const)('leaves %s alone', async (_label, decision) => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision,
        listRelayPtyIds: relay(['pty-1'])
      })
    ).resolves.toBeNull()
  })

  it('does nothing without a relay session to ask', async () => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: null
      })
    ).resolves.toBeNull()
  })
})
