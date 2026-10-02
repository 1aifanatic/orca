import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'exited' | 'unverifiable'> => 'unverifiable')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const owner = {
  agent: 'codex',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const scope = { paneKey: PANE, connectionId: null, tabId: 'tab-1', worktreeId: 'folder-1' }
class Host extends AgentHookServer {
  serialized(): unknown {
    return JSON.parse(this.serializeStatusFile())
  }
  turn(event: Partial<AgentHookEventPayload> = {}) {
    const payload: AgentHookEventPayload = {
      ...scope,
      source: 'codex',
      hookEventName: 'UserPromptSubmit',
      payload: { agentType: 'codex', state: 'waiting', prompt: 'Approve?' },
      ...event
    }
    this.recordCurrentAuthorityObservation(payload)
    this.applyNormalizedStatus(payload)
  }
}
const hosts: Host[] = []
function host() {
  const result = new Host()
  hosts.push(result)
  return result
}
afterEach(() => {
  hosts.splice(0).forEach((server) => server.stop())
  vi.useRealTimers()
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
})

describe('host foreground ownership', () => {
  it('keeps a permission turn and its evidence clock while publishing only identity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = host()
    server.turn()
    const before = server.getStatusSnapshot()[0]
    const published = vi.fn()
    server.subscribeEnrichedStatus(published)
    vi.setSystemTime(5_000)
    server.ingestForegroundPresence(scope, owner)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'waiting',
      prompt: 'Approve?',
      agentPresence: owner,
      evidenceObservedAt: before.evidenceObservedAt,
      stateStartedAt: before.stateStartedAt
    })
    expect(server.getStatusSnapshot()[0].providerSessionOnly).not.toBe(true)
    expect(published.mock.lastCall?.[0].providerSessionOnly).toBe(true)
  })

  it('keeps an unknown owner on command-authority revocation and clears only proven exit', async () => {
    const server = host()
    server.ingestForegroundPresence(scope, owner)
    server.retirePaneAuthority(PANE, undefined, { authorityOnly: true })
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(server.getStatusSnapshot()[0].agentPresence).toEqual(owner)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(server.getStatusSnapshot()[0]?.agentPresence?.ended).toBe(true)
  })

  it('revokes launch authority without losing the owner or persisting a stale token', () => {
    const server = host()
    const token = 'old-launch'
    let launchTokenHash: string | null = createHash('sha256').update(token).digest('hex')
    server.setPaneLaunchAuthorityReader(() => ({ launchTokenHash }))
    server.turn({ launchToken: token })
    server.ingestForegroundPresence(scope, owner)
    expect(server.getCurrentAuthorityObservations()).toHaveLength(1)
    launchTokenHash = null
    server.retirePaneAuthority(PANE, undefined, { authorityOnly: true })
    server.turn({ launchToken: token })
    expect(server.getCurrentAuthorityObservations()).toEqual([])
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
    expect(server.serialized()).not.toHaveProperty(`entries.${PANE}.launchTokenHash`)
    expect(server.serialized()).not.toHaveProperty(`authorityCommitments.${PANE}`)
  })

  it('never reads a plain shell and settles silent death by the owner-only clock', async () => {
    vi.useFakeTimers()
    const server = host()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).not.toHaveBeenCalled()
    server.ingestForegroundPresence(scope, owner)
    probe.mockResolvedValue('exited')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledExactlyOnceWith(owner.process)
    expect(server.getStatusSnapshot()[0]?.agentPresence?.ended).toBe(true)
  })

  it('does not let a late capture resurrect a closed pane', () => {
    const server = host()
    server.retirePaneAuthority(PANE)
    server.ingestForegroundPresence(scope, owner)
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
