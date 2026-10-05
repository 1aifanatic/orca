import { describe, expect, it, vi } from 'vitest'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import type { SshManagedServerStatus, SshTarget } from '../../shared/ssh-types'
import type { HostServerTerminalVerdict } from '../ssh/ssh-host-server-on-connect'

vi.mock('./ssh-connect-flow', () => ({ connectTarget: vi.fn() }))
vi.mock('./ssh-terminate-sessions', () => ({ terminateSshTargetSessions: vi.fn() }))
vi.mock('./ssh-session-teardown', () => ({ teardownSshTargetTransport: vi.fn() }))
vi.mock('./ssh-host-server-connect', () => ({ publishRelayTerminalsStatus: vi.fn() }))

const { moveSshHostToManagedServer } = await import('./ssh-managed-server-move')

const stillRelay: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'relay_terminals_live',
  terminals: 1
}
const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

function deps(
  options: {
    census?: HostServerTerminalVerdict
    unverifiable?: number
    afterConnect?: SshManagedServerStatus
  } = {}
) {
  const calls: string[] = []
  let status: SshManagedServerStatus | undefined = {
    kind: 'relay',
    reason: 'relay_terminals_live',
    terminals: 2
  }
  return {
    calls,
    getTarget: vi.fn(() => target),
    terminate: vi.fn(async () => {
      calls.push('terminate')
      return { terminated: 2, unverifiable: options.unverifiable ?? 0 }
    }),
    relayTerminals: vi.fn(async () => {
      calls.push('census')
      return options.census ?? { verdict: 'exited' as const, count: 0 }
    }),
    connect: vi.fn(async () => {
      calls.push('connect')
      status = options.afterConnect ?? { kind: 'managed', environmentId: 'env-1' }
    }),
    serverStatus: vi.fn(() => status),
    report: vi.fn(),
    releaseRelay: vi.fn(async () => {
      calls.push('release')
    }),
    publishRelayStatus: vi.fn()
  }
}

describe('moving an SSH host to its managed server on request', () => {
  it('stops the relay terminals, proves them exited, then reconnects through the conversion', async () => {
    const move = deps()
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'moved',
      environmentId: 'env-1'
    })
    expect(move.calls).toEqual(['terminate', 'census', 'connect'])
    expect(move.relayTerminals).toHaveBeenCalledWith(target)
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'moved')
  })

  it('refuses without converting when the stop could not reach every terminal', async () => {
    const move = deps({ unverifiable: 1, afterConnect: stillRelay })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 1
    })
    // The stop closed the relay session, so the refusal reconnects the host on its relay.
    expect(move.calls).toEqual(['terminate', 'connect'])
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'refused_unverifiable')
    expect(move.publishRelayStatus).toHaveBeenCalledWith(target, {
      verdict: 'unverifiable',
      count: 1
    })
  })

  it('refuses without converting when the census is unverifiable or still live', async () => {
    const unverifiable = deps({
      census: { verdict: 'unverifiable', count: 3 },
      afterConnect: stillRelay
    })
    await expect(moveSshHostToManagedServer('ssh-1', unverifiable)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 3
    })
    expect(unverifiable.calls).toEqual(['terminate', 'census', 'connect'])

    const live = deps({ census: { verdict: 'live', count: 1 }, afterConnect: stillRelay })
    await expect(moveSshHostToManagedServer('ssh-1', live)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live'
    })
    expect(live.connect).toHaveBeenCalledTimes(1)
    expect(live.report).toHaveBeenCalledWith('ssh-1', 'refused_live')
  })

  it('reports a connect that kept the relay for another reason', async () => {
    const move = deps({ afterConnect: { kind: 'relay', reason: 'refused', detail: 'blocked' } })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({ outcome: 'stayed' })
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'stayed')
  })

  it('reattaches the relay first when preserved terminals need one to be stopped', async () => {
    const move = deps()
    move.terminate.mockRejectedValueOnce(
      new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: reconnect`)
    )
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(move.calls).toEqual(['connect', 'terminate', 'census', 'connect'])
  })

  it('converts when a stop that failed after its shells died is proven exited by the census', async () => {
    const move = deps()
    // BUG-15: the second terminal's reply was lost to a relay that hung up on its last exit.
    move.terminate.mockRejectedValueOnce(
      new Error('Failed to terminate SSH host sessions: pty2:a:3: Multiplexer disposed')
    )
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(move.calls).toEqual(['census', 'release', 'connect'])
  })

  it('refuses a failed stop the census cannot clear and refreshes the stale status', async () => {
    const move = deps({ census: { verdict: 'live', count: 1 }, afterConnect: stillRelay })
    move.terminate.mockRejectedValueOnce(new Error('Failed to terminate SSH host sessions'))
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'live',
      terminals: 1
    })
    expect(move.calls).toEqual(['census', 'connect'])
    expect(move.publishRelayStatus).toHaveBeenCalledWith(target, { verdict: 'live', count: 1 })
  })

  it('moves a host with two live relay terminals once both stop', async () => {
    const move = deps()
    move.terminate.mockResolvedValueOnce({ terminated: 2, unverifiable: 0 })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(move.releaseRelay).not.toHaveBeenCalled()
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'moved')
  })

  it("reports the move when the refusal's reconnect found the terminals exited and converted", async () => {
    const move = deps({ census: { verdict: 'live', count: 1 } })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'moved',
      environmentId: 'env-1'
    })
  })

  it('still reports the refusal when the reconnect itself fails', async () => {
    const move = deps({ census: { verdict: 'live', count: 2 } })
    move.connect.mockRejectedValueOnce(new Error('auth failed'))
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'live',
      terminals: 2
    })
  })
})
