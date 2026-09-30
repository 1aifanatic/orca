import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'unverifiable')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
})

class PresenceTestServer extends AgentHookServer {
  applyTranscriptUpdate(): void {
    const row = this.state.lastStatusByPaneKey.get(PANE)
    if (row) {
      this.applyNormalizedStatus({
        ...row,
        payload: { ...row.payload, lastAssistantMessage: 'late transcript result' }
      })
    }
  }
}

async function createServer(): Promise<PresenceTestServer> {
  const server = new PresenceTestServer()
  servers.push(server)
  await server.start({ env: 'production' })
  return server
}

async function hook(
  server: AgentHookServer,
  event: string,
  session = 'session-a',
  reason?: string,
  pid: number | null = 4001
): Promise<void> {
  const agentProcess =
    pid === null
      ? undefined
      : JSON.stringify({ pid, platform: process.platform, startTime: `birth-${pid}` })
  const response = await postHookEvent(
    server,
    buildBody(
      {
        hook_event_name: event,
        session_id: session,
        source: 'startup',
        reason,
        ...(event === 'UserPromptSubmit' ? { prompt: `${session} task` } : {})
      },
      { agentProcess }
    )
  )
  expect(response.status).toBe(204)
}

function state(server: AgentHookServer): string | null {
  const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
  return row && !row.providerSessionOnly ? row.state : null
}

function visible(server: AgentHookServer): boolean {
  return server.getStatusSnapshot().some((row) => row.paneKey === PANE && !row.providerSessionOnly)
}

describe('host-owned hook presence', () => {
  it('clears the status on SessionEnd while the terminal survives, without a renderer', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    expect(visible(server)).toBe(false)
  })

  it.each(['clear', 'resume'])('keeps the running process present through %s', async (reason) => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', reason)
    expect(visible(server)).toBe(true)
    await hook(server, 'UserPromptSubmit', 'session-b')
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'session-b', 'prompt_input_exit')
    expect(visible(server)).toBe(false)
  })

  it('does not resurrect an ended process on a late Stop', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'Stop')
    expect(visible(server)).toBe(false)
  })

  it('keeps the pane owned by its agent while a nested agent in it starts and ends', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer')
    await hook(server, 'UserPromptSubmit', 'outer')
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'UserPromptSubmit', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    expect(visible(server)).toBe(true)
    await hook(server, 'PostToolUse', 'outer')
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'outer', 'other')
    expect(visible(server)).toBe(false)
  })

  it('never ends a pane from a SessionEnd without a process identity', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer', undefined, null)
    await hook(server, 'UserPromptSubmit', 'outer', undefined, null)
    await hook(server, 'SessionStart', 'nested', undefined, null)
    await hook(server, 'SessionEnd', 'nested', 'other', null)
    expect(visible(server)).toBe(true)
    await hook(server, 'PostToolUse', 'outer', undefined, null)
    expect(state(server)).toBe('working')
  })

  it('lets an unidentified agent keep reporting after an identified nested agent ends', async () => {
    const server = await createServer()
    await hook(server, 'UserPromptSubmit', 'outer', undefined, null)
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    await hook(server, 'PostToolUse', 'outer', undefined, null)
    expect(state(server)).toBe('working')
    expect(await server.checkAgentPresence(PANE)).toBeNull()
  })

  it('keeps unanswered reads and clears only a positive process exit', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(visible(server)).toBe(true)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(visible(server)).toBe(false)
    expect(await server.checkAgentPresence(PANE)).toBeNull()
  })

  it('does not apply a delayed process exit to a relaunched agent', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    let finish: (value: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = server.checkAgentPresence(PANE)
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'SessionStart', 'relaunch', undefined, 4002)
    finish('exited')
    expect(await pending).toBe('unverifiable')
    expect(visible(server)).toBe(true)
  })

  it('accepts a remote exit and never probes that remote PID locally', async () => {
    const server = await createServer()
    const envelope = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName: 'SessionStart',
      providerSession: { provider: 'claude', id: 'remote-session' },
      agentPresence: {
        process: { pid: process.pid, platform: process.platform, startTime: 'remote-birth' }
      },
      payload: { state: 'working', prompt: 'remote task', agentType: 'claude' }
    }
    server.ingestRemote(envelope, 'ssh-1')
    expect(visible(server)).toBe(true)
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(probe).not.toHaveBeenCalled()
    server.ingestRemote(
      {
        ...envelope,
        hookEventName: 'AgentProcessExit',
        providerSessionOnly: true,
        agentPresence: { ...envelope.agentPresence, ended: true }
      },
      'ssh-1'
    )
    expect(visible(server)).toBe(false)
  })

  it('probes the owner only when another process reports, never on its own hooks or retries', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'UserPromptSubmit')
    probe.mockResolvedValue('exited')
    server.applyTranscriptUpdate()
    await Promise.resolve()
    expect(
      server.getStatusSnapshot().find((row) => row.paneKey === PANE)?.lastAssistantMessage
    ).toBe('late transcript result')
    expect(probe).not.toHaveBeenCalled()
    expect(visible(server)).toBe(true)
    await hook(server, 'SessionStart', 'relaunch', undefined, 4002)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(visible(server)).toBe(false))
    await hook(server, 'UserPromptSubmit', 'relaunch', undefined, 4002)
    expect(state(server)).toBe('working')
  })
})
