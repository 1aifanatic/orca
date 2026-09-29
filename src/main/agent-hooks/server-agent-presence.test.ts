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
  pid?: number
): Promise<void> {
  const agentProcess =
    pid === undefined
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

  it.each(['clear', 'resume'])(
    'keeps process presence through %s and rejects the previous session goodbye',
    async (reason) => {
      const server = await createServer()
      await hook(server, 'SessionStart')
      await hook(server, 'SessionEnd', 'session-a', reason)
      expect(visible(server)).toBe(true)
      await hook(server, 'SessionStart', 'session-b')
      await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
      expect(visible(server)).toBe(true)
      await hook(server, 'SessionEnd', 'session-b', 'prompt_input_exit')
      expect(visible(server)).toBe(false)
    }
  )

  it('keeps the pane owned by its agent while a nested agent in it starts and ends', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'outer', undefined, 4001)
    await hook(server, 'UserPromptSubmit', 'outer', undefined, 4001)
    await hook(server, 'SessionStart', 'nested', undefined, 4002)
    await hook(server, 'UserPromptSubmit', 'nested', undefined, 4002)
    await hook(server, 'SessionEnd', 'nested', 'other', 4002)
    expect(visible(server)).toBe(true)
    await hook(server, 'PostToolUse', 'outer', undefined, 4001)
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'outer', 'other', 4001)
    expect(visible(server)).toBe(false)
  })

  it('lets the next session replace a switched one even if its SessionStart was lost', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart', 'session-a', undefined, 4001)
    await hook(server, 'SessionEnd', 'session-a', 'clear', 4001)
    await hook(server, 'Stop', 'session-a', undefined, 4001)
    await hook(server, 'UserPromptSubmit', 'session-b', undefined, 4001)
    expect(state(server)).toBe('working')
    await hook(server, 'SessionEnd', 'session-b', 'other', 4001)
    expect(visible(server)).toBe(false)
  })

  it('does not resurrect an ended session on a late Stop', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'Stop')
    expect(visible(server)).toBe(false)
  })
  it('keeps unanswered reads and clears only a positive process exit', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(visible(server)).toBe(true)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(visible(server)).toBe(false)
  })

  it('does not apply a delayed process exit to a replacement session', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await server.checkAgentPresence(PANE)
    let finish: (value: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = server.checkAgentPresence(PANE)
    await hook(server, 'SessionStart', 'replacement')
    finish('exited')
    expect(await pending).toBe('unverifiable')
    expect(visible(server)).toBe(true)
  })
  it('admits an explicit same-session resume when no PID was available', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    await hook(server, 'SessionEnd', 'session-a', 'prompt_input_exit')
    await hook(server, 'SessionStart')
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
        sessionId: 'remote-session',
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
  it('checks real hooks but never a transcript retry status write', async () => {
    const server = await createServer()
    await hook(server, 'SessionStart')
    expect(probe).toHaveBeenCalledOnce()
    probe.mockClear()
    probe.mockResolvedValue('exited')
    server.applyTranscriptUpdate()
    await Promise.resolve()
    expect(
      server.getStatusSnapshot().find((row) => row.paneKey === PANE)?.lastAssistantMessage
    ).toBe('late transcript result')
    expect(probe).not.toHaveBeenCalled()
    expect(visible(server)).toBe(true)
    await hook(server, 'Stop')
    expect(probe).toHaveBeenCalledOnce()
    expect(visible(server)).toBe(false)
  })
})
