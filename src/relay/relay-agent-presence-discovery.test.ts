import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from './agent-hook-server'
import { makePaneKey } from '../shared/stable-pane-id'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const paneKey = makePaneKey('tab', '11111111-1111-4111-8111-111111111111')
const presence = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const servers: RelayAgentHookServer[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
  probe.mockResolvedValue('live')
})
function setup() {
  let connected = true
  const frames: AgentHookRelayEnvelope[] = []
  const server = new RelayAgentHookServer({
    endpointDir: '/unused-presence-test',
    forward: (event) => {
      if (connected) {
        frames.push(event)
      }
    }
  })
  servers.push(server)
  const request = {
    paneKey,
    tabId: 'tab',
    worktreeId: 'folder',
    isCurrent: () => true,
    discover: vi.fn(async () => presence)
  }
  return {
    server,
    request,
    frames,
    connect: (value: boolean) => {
      connected = value
    }
  }
}
describe('relay discovery and offline replay', () => {
  it('captures once and replays an exit that happened without a client', async () => {
    const { server, request, frames, connect } = setup()
    await server.discoverAgentPresence(request)
    await server.discoverAgentPresence(request)
    expect(request.discover).toHaveBeenCalledTimes(1)
    connect(false)
    probe.mockResolvedValue('exited')
    await server.checkAgentPresence(paneKey)
    expect(frames.at(-1)?.agentPresence?.ended).toBeUndefined()
    connect(true)
    server.replayCachedPayloadsForPanes()
    expect(frames.at(-1)?.agentPresence).toMatchObject({ ...presence, ended: true })
  })
  it('rechecks a silent death on reconnect, then replays the settled fact', async () => {
    const { server, request, frames } = setup()
    await server.discoverAgentPresence(request)
    probe.mockResolvedValue('exited')
    server.replayCachedPayloadsForPanes()
    await server.checkAgentPresence(paneKey)
    expect(frames.at(-1)?.agentPresence?.ended).toBe(true)
    server.replayCachedPayloadsForPanes()
    expect(frames.at(-1)?.agentPresence?.ended).toBe(true)
  })
  it('does not admit a detached terminal or resurrect the same ended process', async () => {
    const { server, request, frames } = setup()
    await server.discoverAgentPresence({ ...request, isCurrent: () => false })
    expect(frames).toEqual([])
    await server.discoverAgentPresence(request)
    probe.mockResolvedValue('exited')
    await server.checkAgentPresence(paneKey)
    await server.discoverAgentPresence(request)
    expect(frames.at(-1)?.agentPresence?.ended).toBe(true)
  })
})
