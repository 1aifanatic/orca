import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

async function createServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production' })
  return server
}

const CLAUDE_PROCESS = JSON.stringify({
  pid: 4001,
  platform: process.platform,
  startTime: 'birth-4001'
})

async function claude(server: AgentHookServer, event: string, extra = {}): Promise<void> {
  const body = buildBody(
    { hook_event_name: event, session_id: 'claude-a', ...extra },
    { agentProcess: CLAUDE_PROCESS }
  )
  expect((await postHookEvent(server, body)).status).toBe(204)
}

async function codex(server: AgentHookServer, event: string, extra = {}): Promise<void> {
  const body = buildBody({ hook_event_name: event, session_id: 'codex-x', ...extra })
  expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
}

function row(server: AgentHookServer) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
}

describe('ending a launched agent command', () => {
  it('keeps an owner the launch handed the pane to, and admits its later events', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await claude(server, 'SessionEnd', { reason: 'prompt_input_exit' })
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    server.endLaunchAuthority(PANE, 'claude')
    expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'codex task' })
    await codex(server, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(row(server)).toMatchObject({ agentType: 'codex', toolName: 'Bash' })
  })

  it("keeps the launch's resume remnant but fences its late events", async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await claude(server, 'SessionEnd', { reason: 'prompt_input_exit' })
    server.endLaunchAuthority(PANE, 'claude')
    expect(row(server)).toMatchObject({
      providerSessionOnly: true,
      agentType: 'claude',
      providerSession: { id: 'claude-a' }
    })
    await codex(server, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(row(server)?.providerSessionOnly).toBe(true)
  })

  it.each([['claude'], [null]])(
    "wipes and fences the launch's own row (launch agent %s)",
    async (launchAgent) => {
      const server = await createServer()
      await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
      server.endLaunchAuthority(PANE, launchAgent)
      expect(row(server)).toBeUndefined()
      await claude(server, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
      expect(row(server)).toBeUndefined()
      await claude(server, 'UserPromptSubmit', { prompt: 'next task' })
      expect(row(server)).toMatchObject({ state: 'working', prompt: 'next task' })
    }
  )
})
