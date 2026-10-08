// The pane owner rule on SSH/WSL panes: the relay classifies each hook producer and forwards only
// the rows it builds; the desktop adopts them as given.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { AgentHookServer } from './server'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const running: { stop: () => void }[] = []
const paths: string[] = []
afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  probe.mockReset()
  probe.mockResolvedValue('live')
})

type SshPane = {
  relay: RelayAgentHookServer
  desktop: AgentHookServer
  pushed: AgentHookEventPayload[]
  connected: boolean
  post: (path: string, payload: Record<string, unknown>, agentProcess?: string) => Promise<void>
}

async function startSshPane(): Promise<SshPane> {
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-pane-owner-relayed-'))
  paths.push(endpointDir)
  const desktop = new AgentHookServer()
  const pane: SshPane = {
    desktop,
    pushed: [],
    connected: true,
    relay: new RelayAgentHookServer({
      endpointDir,
      token: 'pane-owner-token',
      forward: (envelope) => {
        if (pane.connected) {
          pane.desktop.ingestRemote(envelope, 'ssh-1')
        }
      }
    }),
    post: async (path, payload, agentProcess) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload, agentProcess ? { agentProcess } : {}))
      })
      expect(response.status).toBe(204)
    }
  }
  desktop.setListener((event) => pane.pushed.push(event))
  running.push(pane.relay, desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

const CLAUDE_PROCESS = JSON.stringify({ pid: 4001, platform: 'linux', startTime: 'boot:1' })

function claude(pane: SshPane, event: string, extra: Record<string, unknown> = {}) {
  return pane.post(
    '/hook/claude',
    { hook_event_name: event, session_id: 'claude-a', ...extra },
    CLAUDE_PROCESS
  )
}

function codex(pane: SshPane, event: string, extra: Record<string, unknown> = {}) {
  return pane.post('/hook/codex', {
    hook_event_name: event,
    session_id: 'codex-x',
    model: 'gpt-6-astra',
    ...extra
  })
}

function row(server: AgentHookServer) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
}

describe('pane owner rule (relayed panes)', () => {
  it('keeps Claude the owner while a nested Codex reports into its pane (STA-9582)', async () => {
    const pane = await startSshPane()
    await claude(pane, 'UserPromptSubmit', { prompt: 'claude task' })
    await codex(pane, 'UserPromptSubmit', { prompt: 'codex task' })
    await codex(pane, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      agentType: 'claude',
      prompt: 'claude task',
      providerSession: { id: 'claude-a' }
    })
    await codex(pane, 'Stop')
    await claude(pane, 'Stop')
    // Prompt after Claude's Stop is the relay listener's pane-wide cache (a separate change).
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      agentType: 'claude',
      providerSession: { id: 'claude-a' }
    })
    expect(pane.pushed.length).toBeGreaterThan(0)
    for (const event of pane.pushed) {
      expect(event.connectionId).toBe('ssh-1')
      expect(event.payload.agentType).toBe('claude')
      expect(event.payload.model).toBeUndefined()
      expect(event.providerSession?.id).toBe('claude-a')
    }
  })

  it('keeps a working Codex pane when a Claude run inside it ends (#23947)', async () => {
    const pane = await startSshPane()
    await codex(pane, 'UserPromptSubmit', { prompt: 'codex task' })
    await claude(pane, 'SessionStart', { source: 'startup' })
    await claude(pane, 'UserPromptSubmit', { prompt: 'nested claude' })
    await claude(pane, 'SessionEnd', { reason: 'prompt_input_exit' })
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      agentType: 'codex',
      prompt: 'codex task'
    })
    expect(row(pane.desktop)?.providerSessionOnly).toBeUndefined()
  })

  it('hands the pane to the guest once the relay proves the owner exited', async () => {
    const pane = await startSshPane()
    await claude(pane, 'UserPromptSubmit', { prompt: 'claude task' })
    await claude(pane, 'Stop')
    probe.mockResolvedValue('exited')
    await codex(pane, 'UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() =>
      expect(row(pane.desktop)).toMatchObject({
        state: 'working',
        agentType: 'codex',
        providerSession: { id: 'codex-x' }
      })
    )
    expect(probe).toHaveBeenCalledOnce()
  })

  it('gives a replayed row the live verdict, and a disconnect releases nothing', async () => {
    const pane = await startSshPane()
    await claude(pane, 'UserPromptSubmit', { prompt: 'claude task' })
    const live = pane.pushed.at(-1)?.agentPresence
    pane.connected = false
    pane.desktop.clearStatusEntriesForConnection('ssh-1')
    await codex(pane, 'UserPromptSubmit', { prompt: 'codex task' })
    pane.connected = true
    pane.relay.replayCachedPayloadsForPanes()
    const replayed = row(pane.desktop)
    expect(replayed).toMatchObject({
      state: 'working',
      agentType: 'claude',
      prompt: 'claude task',
      providerSession: { id: 'claude-a' }
    })
    expect(pane.pushed.at(-1)?.isReplay).toBe(true)
    expect(pane.pushed.at(-1)?.agentPresence).toEqual(live)
    expect(pane.pushed.at(-1)?.agentPresence).toMatchObject({
      agent: 'claude',
      session: 'claude-a',
      process: { pid: 4001 }
    })
  })
})
