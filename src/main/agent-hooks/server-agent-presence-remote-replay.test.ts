import { transitionHookPresence } from '../../shared/agent-hook-presence-transition'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { PANE } from './server.test-fixtures'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const owner = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const replacement = {
  agent: 'codex',
  process: { pid: 43, platform: 'linux', startTime: 'boot:43' }
} as const
const servers: { stop(): void }[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
  probe.mockResolvedValue('live')
})
function setup() {
  let connected = true
  const main = new AgentHookServer()
  const frames: AgentHookRelayEnvelope[] = []
  const relay = new RelayAgentHookServer({
    endpointDir: '/unused-replay-test',
    forward: (event) => {
      frames.push(event)
      if (connected) {
        main.ingestRemote(event, 'ssh-1')
      }
    }
  })
  servers.push(main, relay)
  const request = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'folder-1', isCurrent: () => true }
  return {
    main,
    relay,
    request,
    frames,
    connect: (value: boolean) => {
      connected = value
    }
  }
}
describe('execution host presence replay', () => {
  it.each([false, true])(
    'converges after offline exit and replacement (replacement ended=%s)',
    async (ended) => {
      const { main, relay, request, frames, connect } = setup()
      await relay.discoverAgentPresence({ ...request, discover: async () => owner })
      connect(false)
      probe.mockResolvedValue('exited')
      await relay.checkAgentPresence(PANE)
      const staleExit = frames.at(-1)!
      await relay.discoverAgentPresence({ ...request, discover: async () => replacement })
      if (ended) {
        await relay.checkAgentPresence(PANE)
      } else {
        probe.mockResolvedValue('live')
      }
      connect(true)
      relay.replayCachedPayloadsForPanes()
      await relay.checkAgentPresence(PANE)
      expect(main.getStatusSnapshot()[0]?.agentPresence).toMatchObject({
        ...replacement,
        ...(ended ? { ended: true } : {})
      })
      main.ingestRemote(staleExit, 'ssh-1')
      main.ingestRemote({ ...frames[0], isReplay: true }, 'ssh-1')
      main.ingestRemote({ ...staleExit, isReplay: true }, 'ssh-1')
      expect(main.getStatusSnapshot()[0]?.agentPresence?.process).toEqual(replacement.process)
      expect(main.getStatusSnapshot()[0]?.agentPresence?.ended).toBe(ended ? true : undefined)
    }
  )
  it('retains the ordering of a connected exit when an older live frame replays', async () => {
    const { main, relay, request, frames } = setup()
    await relay.discoverAgentPresence({ ...request, discover: async () => owner })
    const staleLive = frames.at(-1)!
    probe.mockResolvedValue('exited')
    await relay.checkAgentPresence(PANE)
    const exited = main.getStatusSnapshot()[0]?.agentPresence
    expect(exited?.observation).toEqual(frames.at(-1)?.agentPresence?.observation)
    main.ingestRemote({ ...staleLive, isReplay: true }, 'ssh-1')
    expect(main.getStatusSnapshot()[0]?.agentPresence).toEqual(exited)
    expect(exited?.ended).toBe(true)
  })
  it('does not accept host provenance from local hook or terminal bytes', async () => {
    const { main, request } = setup()
    await main.discoverAgentPresence({
      ...request,
      ptyId: 'pty',
      terminalHandle: 'terminal',
      discover: async () => owner
    })
    const normalized = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      {
        env: 'production',
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        agentProcess: { ...replacement.process, observation: { epoch: 'fake', sequence: 99 } },
        agentPresenceFromExecutionHost: true,
        agentPresenceObservation: { epoch: 'fake', sequence: 99 },
        payload: { hook_event_name: 'SessionStart', session_id: 'nested', source: 'startup' }
      },
      'production'
    )
    expect(normalized?.agentPresenceFromExecutionHost).toBeUndefined()
    expect(normalized).not.toBeNull()
    expect(normalized?.agentPresence?.observation).toBeUndefined()
    if (!normalized) {
      throw new Error('missing normalized hook')
    }
    expect(
      transitionHookPresence(normalized, { ...normalized, agentPresence: owner })?.agentPresence
    ).toEqual(owner)
    const bytes = {
      ...request,
      ptyId: 'pty',
      terminalHandle: 'terminal',
      agentPresence: replacement,
      agentPresenceFromExecutionHost: true,
      agentPresenceObservation: { epoch: 'fake', sequence: 99 },
      payload: { agentType: 'codex', state: 'done' as const, prompt: '' }
    }
    main.ingestTerminalStatus(bytes)
    expect(main.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
  })
  it('keeps old relay omission and raw mismatched exits on the legacy path', () => {
    const { main, request } = setup()
    const event = {
      ...request,
      source: 'claude',
      payload: { state: 'done', prompt: '', agentType: 'claude' },
      agentPresence: owner
    }
    main.ingestRemote(event, 'ssh-1')
    main.ingestRemote({ ...event, agentPresence: replacement }, 'ssh-1')
    expect(main.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
    main.ingestRemote({ ...event, agentPresence: { ...replacement, ended: true } }, 'ssh-1')
    expect(main.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
  })
})
