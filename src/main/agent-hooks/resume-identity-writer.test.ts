import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { isOwnedAgentResumeSession } from '../../shared/agent-resume-identity'
import { AgentHookServer } from './server'
import { buildBody, PANE, GOOD_PANE, postHookEvent } from './server.test-fixtures'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { sanitizeHydratedEntry } from './server/server-persistence-validation'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const servers: AgentHookServer[] = []
const directories: string[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function startServer(): Promise<AgentHookServer> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-resume-identity-'))
  directories.push(directory)
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: directory })
  return server
}

describe('resume identity through authenticated provider hooks', () => {
  it('does not pair a nested Codex session with the active Claude pane agent', async () => {
    const server = await startServer()
    const owner = { launchToken: 'parent-launch' }
    expect(
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'Delegate work',
            session_id: 'claude-parent'
          },
          owner
        )
      )
    ).toMatchObject({ status: 204 })
    expect(server.getStatusSnapshot()).toMatchObject([
      {
        paneKey: PANE,
        agentType: 'claude',
        providerSession: { id: 'claude-parent' }
      }
    ])

    // A CLI launched by the parent's shell inherits its pane and launch environment.
    expect(
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'Do delegated work',
            session_id: 'codex-child'
          },
          owner
        ),
        '/hook/codex'
      )
    ).toMatchObject({ status: 204 })

    const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
    expect(row).toBeDefined()
    if (!row?.providerSession || row.agentType !== 'claude') {
      throw new Error('Missing owner')
    }
    const startup = buildAgentResumeStartupPlan({
      agent: row.agentType,
      providerSession: row.providerSession,
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(row.providerSession.id).toBe('claude-parent')
    expect(startup?.launchCommand).toContain('claude-parent')
    expect(startup?.launchCommand).not.toContain('codex-child')
  })

  it('takes source from the authenticated route, never a hook body field', async () => {
    const server = await startServer()
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        ...buildBody({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'work',
          session_id: 'codex-worker',
          source: 'claude'
        }),
        source: 'claude',
        providerSession: {
          key: 'session_id',
          id: 'forged',
          resumeIdentity: { agent: 'claude', connectionId: null }
        }
      })
    })
    expect(response.status).toBe(204)
    server.flushStatusPersistSync()
    const saved = JSON.parse(
      readFileSync(join(directories.at(-1)!, 'agent-hooks', 'last-status.json'), 'utf8')
    )
    expect(saved.entries[PANE]).toMatchObject({
      source: 'codex',
      providerSession: {
        id: 'codex-worker',
        resumeIdentity: { agent: 'codex', connectionId: null }
      }
    })

    const legacy = saved.entries[PANE]
    delete legacy.providerSession.resumeIdentity
    expect(sanitizeHydratedEntry(PANE, legacy)?.providerSession?.resumeIdentity).toEqual({
      agent: 'codex',
      connectionId: null
    })
    legacy.payload.agentType = 'claude'
    const hydrated = sanitizeHydratedEntry(PANE, legacy)
    expect(hydrated?.providerSession?.resumeIdentity?.agent).toBe('codex')
    expect(
      hydrated &&
        buildAgentResumeStartupPlan({
          agent: 'claude',
          providerSession: hydrated.providerSession!,
          cmdOverrides: {},
          platform: 'linux'
        })
    ).toBeNull()
    delete legacy.source
    expect(sanitizeHydratedEntry(PANE, legacy)?.providerSession?.resumeIdentity).toBeUndefined()
  })

  it('binds a remote identity-only hook to its connection and rejects another host', async () => {
    const server = await startServer()
    const event = normalizeHookPayload(
      server._getStateForTests(),
      'pi',
      buildBody({
        hook_event_name: 'session_start',
        session_id: 'pi-remote',
        session_file: '/remote/pi-remote.jsonl'
      }),
      'production'
    )
    if (!event) {
      throw new Error('Missing PI identity event')
    }
    expect(event.providerSessionOnly).toBe(true)
    server.ingestRemote(event, 'ssh-owner')
    server.flushStatusPersistSync()
    const saved = JSON.parse(
      readFileSync(join(directories.at(-1)!, 'agent-hooks', 'last-status.json'), 'utf8')
    )
    const row = sanitizeHydratedEntry(PANE, saved.entries[PANE])
    if (!row?.providerSession) {
      throw new Error('Missing remote identity')
    }
    expect(row.connectionId).toBe('ssh-owner')
    expect(isOwnedAgentResumeSession('pi', row.providerSession, 'ssh-owner')).toBe(true)
    expect(isOwnedAgentResumeSession('pi', row.providerSession, 'ssh-other')).toBe(false)
    expect(
      buildAgentResumeStartupPlan({
        agent: 'pi',
        providerSession: row.providerSession,
        requireOwnedSession: true,
        cmdOverrides: {},
        platform: 'linux'
      })?.launchCommand
    ).toContain('/remote/pi-remote.jsonl')
  })

  it('keeps a separately attributed Codex worker separate from its Claude parent', async () => {
    const server = await startServer()
    await postHookEvent(
      server,
      buildBody(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Delegate work',
          session_id: 'claude-parent'
        },
        { launchToken: 'parent-launch' }
      )
    )
    await postHookEvent(
      server,
      buildBody(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Do delegated work',
          session_id: 'codex-worker'
        },
        { paneKey: GOOD_PANE, tabId: 'tab-good', launchToken: 'worker-launch' }
      ),
      '/hook/codex'
    )
    expect(server.getStatusSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paneKey: PANE,
          agentType: 'claude',
          providerSession: expect.objectContaining({ id: 'claude-parent' })
        }),
        expect.objectContaining({
          paneKey: GOOD_PANE,
          agentType: 'codex',
          providerSession: expect.objectContaining({ id: 'codex-worker' })
        })
      ])
    )
  })
})
