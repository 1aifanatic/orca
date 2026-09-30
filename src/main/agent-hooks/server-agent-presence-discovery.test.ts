import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import type { AgentPresenceDiscoveryRequest } from './server/server-agent-presence-discovery'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const presence: AgentProcessPresence = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
}
const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})
function setup() {
  const server = new AgentHookServer()
  servers.push(server)
  const request: AgentPresenceDiscoveryRequest = {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'folder-1',
    ptyId: 'pty-1',
    terminalHandle: 'terminal-1',
    isCurrent: () => true,
    discover: vi.fn(async () => presence)
  }
  return { server, request }
}
describe('execution host presence discovery', () => {
  it('captures once and preserves an unidentified owner’s turn', async () => {
    const { server, request } = setup()
    server.ingestTerminalStatus({
      ...request,
      payload: { agentType: 'claude', state: 'working', prompt: 'keep this turn' }
    })
    const before = server.getStatusSnapshot()[0]
    await server.discoverAgentPresence(request)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ ...before, agentPresence: presence })
    await server.discoverAgentPresence(request)
    expect(request.discover).toHaveBeenCalledTimes(1)
  })
  it('admits a hookless owner without manufacturing a working turn', async () => {
    const { server, request } = setup()
    await server.discoverAgentPresence(request)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', agentPresence: presence })
  })
  it('rejects a late result after the terminal incarnation changes', async () => {
    const { server, request } = setup()
    request.isCurrent = () => false
    await server.discoverAgentPresence(request)
    expect(server.getStatusSnapshot()).toEqual([])
  })
  it('rejects capture if a hook replaces the observed row during the read', async () => {
    const { server, request } = setup()
    request.discover = async () => {
      server.ingestTerminalStatus({
        ...request,
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      })
      return presence
    }
    await server.discoverAgentPresence(request)
    expect(server.getStatusSnapshot()[0]?.agentPresence?.process).toBeUndefined()
  })
  it('does not let a nested different agent replace an unidentified owner', async () => {
    const { server, request } = setup()
    server.ingestTerminalStatus({
      ...request,
      payload: { agentType: 'codex', state: 'working', prompt: '' }
    })
    await server.discoverAgentPresence(request)
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual({ agent: 'codex' })
  })
})

it('accepts a relay host capture for an unidentified remote owner without probing its PID locally', async () => {
  const { server, request } = setup()
  const event = {
    paneKey: request.paneKey,
    tabId: request.tabId,
    worktreeId: request.worktreeId,
    source: 'claude',
    payload: { agentType: 'claude', state: 'done', prompt: '' }
  }
  server.ingestRemote(event, 'ssh-1')
  server.ingestRemote(
    {
      ...event,
      hookEventName: 'AgentProcessCaptured',
      agentPresence: { ...presence, observation: { epoch: 'relay', sequence: 1 } }
    },
    'ssh-1'
  )
  expect(server.getStatusSnapshot()[0]?.agentPresence).toMatchObject(presence)
  await expect(server.checkAgentPresence(request.paneKey)).resolves.toBe('unverifiable')
})
