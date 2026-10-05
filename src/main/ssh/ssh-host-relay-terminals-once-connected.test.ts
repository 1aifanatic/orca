import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'
import type { ListRelayPtyIds } from './orcad-migration-terminal-gate'
import { relayTerminalsOnceConnected } from './ssh-host-relay-terminals-once-connected'
import { relayTerminalsOnConnect } from './ssh-host-relay-terminals-on-connect'

/** Leases that `markSshRemotePtyLease` really updates, as the store's lease operations do. */
function store(leases: Pick<SshRemotePtyLease, 'ptyId' | 'state'>[]) {
  const full: SshRemotePtyLease[] = leases.map((lease) => ({
    ...lease,
    targetId: 'ssh-1',
    createdAt: 1,
    updatedAt: 1
  }))
  return {
    getSshRemotePtyLeases: () => full,
    markSshRemotePtyLease: vi.fn(
      (_targetId: string, ptyId: string, state: SshRemotePtyLease['state']) => {
        full.filter((lease) => lease.ptyId === ptyId).forEach((lease) => (lease.state = state))
      }
    )
  }
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
let detached = store([{ ptyId: 'pty-1', state: 'detached' }])

describe('re-checking relay terminals once the relay session is up', () => {
  beforeEach(() => {
    detached = store([{ ptyId: 'pty-1', state: 'detached' }])
  })

  // The Windows connect: no endpoint census, so the detached lease read unverifiable at decide time.
  it('reports live when the connected relay still runs the detached terminal', async () => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: relay(['pty-1']),
        isCurrent: () => true
      })
    ).resolves.toEqual({ route: 'relay', reason: 'relay_terminals_live', terminals: 1 })
  })

  it('reports and retires nothing for a connect cancelled while the relay answered', async () => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: relay([]),
        isCurrent: () => false
      })
    ).resolves.toBeNull()
    expect(detached.markSshRemotePtyLease).not.toHaveBeenCalled()
  })

  it.each([
    ['the relay still cannot answer', relay(null)],
    ['earlier relays cannot be asked', relay([], null)]
  ])('keeps the first decision and every lease when %s', async (_label, list) => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: list,
        isCurrent: () => true
      })
    ).resolves.toBeNull()
    expect(detached.markSshRemotePtyLease).not.toHaveBeenCalled()
  })

  // BUG-13, from the profile: v1.4.218's terminal and the two it respawned on its relay (92577856),
  // the current relay's first shell, all expired, plus two live shells on the current relay.
  const upgradedProfile = () =>
    store([
      { ptyId: 'pty2:92577856:1', state: 'expired' },
      { ptyId: 'pty2:8ea088dc:1', state: 'expired' },
      { ptyId: 'pty2:92577856:2', state: 'expired' },
      { ptyId: 'pty2:92577856:3', state: 'expired' },
      { ptyId: 'pty2:8ea088dc:2', state: 'detached' },
      { ptyId: 'pty2:8ea088dc:3', state: 'detached' }
    ])
  const sixUnverifiable: HostServerOnConnectResult = {
    route: 'relay',
    reason: 'relay_terminals_unverifiable',
    terminals: 6
  }

  it('reports the upgraded host live while the current relay runs its shells', async () => {
    const upgraded = upgradedProfile()
    await expect(
      relayTerminalsOnceConnected({
        store: upgraded,
        targetId: 'ssh-1',
        decision: sixUnverifiable,
        // The old relay is gone (only its .credential is left), so it lists nothing.
        listRelayPtyIds: relay(['pty2:8ea088dc:2', 'pty2:8ea088dc:3'], []),
        isCurrent: () => true
      })
    ).resolves.toEqual({ route: 'relay', reason: 'relay_terminals_live', terminals: 2 })
    expect(upgraded.markSshRemotePtyLease).not.toHaveBeenCalled()
  })

  it('retires every lease once all relays prove them ended, so the next connect converts', async () => {
    const upgraded = upgradedProfile()
    await expect(
      relayTerminalsOnceConnected({
        store: upgraded,
        targetId: 'ssh-1',
        decision: sixUnverifiable,
        listRelayPtyIds: relay([], []),
        isCurrent: () => true
      })
    ).resolves.toBeNull()
    expect(new Set(upgraded.getSshRemotePtyLeases().map((lease) => lease.state))).toEqual(
      new Set(['terminated'])
    )
    // The next connect decides before any session, and now has nothing left to ask about.
    await expect(
      relayTerminalsOnConnect({
        store: upgraded,
        targetId: 'ssh-1',
        listRelayPtyIds: null,
        censusHost: async () => ({ verdict: 'none', count: 0 })
      })
    ).resolves.toEqual({ verdict: 'exited', count: 0 })
  })

  it.each([
    [
      'a decision about something other than terminals',
      { route: 'relay', reason: 'orcad_unavailable', detail: 'artifacts_unavailable' }
    ],
    ['a managed decision', { route: 'managed', environmentId: 'env-1' }],
    ['no decision', null]
  ] as const)('leaves %s alone', async (_label, decision) => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision,
        listRelayPtyIds: relay(['pty-1']),
        isCurrent: () => true
      })
    ).resolves.toBeNull()
  })

  it('counts a shell the relay runs that no lease here knows', async () => {
    // A CLI-created terminal: only an old lease remains, already proven ended.
    const cliOnly = store([{ ptyId: 'pty2:8ea088dc:1', state: 'terminated' }])
    for (const decision of [
      unverifiable,
      { route: 'relay', reason: 'relay_terminals_live', terminals: 0 } as const
    ]) {
      await expect(
        relayTerminalsOnceConnected({
          store: cliOnly,
          targetId: 'ssh-1',
          decision,
          listRelayPtyIds: relay(['pty2:8ea088dc:4'])
        })
      ).resolves.toEqual({ route: 'relay', reason: 'relay_terminals_live', terminals: 1 })
    }
  })

  it('re-counts a live decision with the relay\u2019s own listing', async () => {
    const attached = store([{ ptyId: 'pty-1', state: 'attached' }])
    await expect(
      relayTerminalsOnceConnected({
        store: attached,
        targetId: 'ssh-1',
        decision: { route: 'relay', reason: 'relay_terminals_live', terminals: 1 },
        listRelayPtyIds: relay(['pty-1', 'pty-cli'])
      })
    ).resolves.toEqual({ route: 'relay', reason: 'relay_terminals_live', terminals: 2 })
  })

  it('does nothing without a relay session to ask', async () => {
    await expect(
      relayTerminalsOnceConnected({
        store: detached,
        targetId: 'ssh-1',
        decision: unverifiable,
        listRelayPtyIds: null,
        isCurrent: () => true
      })
    ).resolves.toBeNull()
  })
})
