import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { lookupOpenCodeSessionPane } from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PANE_B = makePaneKey('tab-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

class IsolatedHookServer extends AgentHookServer {
  isolateBinder(dbPath: string) {
    this._setOpenCodeBinderDepsForTests({
      dbPath: () => dbPath,
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('legacy TUI identity admitted by the canonical hook server', () => {
  let dir: string
  let server: IsolatedHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-opencode-tui-host-'))
    server = new IsolatedHookServer()
    server.isolateBinder(join(dir, 'no-user-database'))
    await server.start({ env: 'test', userDataPath: dir })
  })
  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(
    paneKey: string,
    sessionID: string,
    hookEventName = 'SessionBusy',
    extra: Record<string, unknown> = {}
  ) {
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId: 'folder::same-folder',
        env: 'test',
        launchToken: 'old-generation',
        opencodeTui: 1,
        payload: { hook_event_name: hookEventName, sessionID },
        ...extra
      })
    })
    expect(response.ok).toBe(true)
  }
  const binding = (id: string) => lookupOpenCodeSessionPane(server._getStateForTests(), id)

  it('publishes two same-folder sessions separately and prevents a shared post from ending either', async () => {
    await post(PANE_A, 'ses_a')
    await post(PANE_B, 'ses_b')
    await post(PANE_A, 'ses_b', 'SessionIdle', { opencodeTui: undefined, opencodeSharedServer: 1 })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_A, state: 'working' }),
      expect.objectContaining({ paneKey: PANE_B, state: 'working' })
    ])
    await post(PANE_B, 'ses_b', 'SessionIdle')
    expect(server.getStatusSnapshotForPane(PANE_A)[0]?.state).toBe('working')
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
    expect(binding('ses_a')?.paneKey).toBe(PANE_A)
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
  })

  it('keeps the known creator when a different live pane views its session', async () => {
    await post(PANE_B, 'ses_b')
    await post(PANE_A, 'ses_b')
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_B, state: 'working' })
    ])
  })

  it('does not resurrect retired identity from a late old-generation hook', async () => {
    await post(PANE_A, 'ses_old')
    server.retirePaneAuthority(PANE_A)
    expect(binding('ses_old')).toBeUndefined()
    await post(PANE_A, 'ses_old', 'SessionIdle')
    expect(binding('ses_old')).toBeUndefined()
    expect(server.getStatusSnapshot()).toEqual([])
    await post(PANE_A, 'ses_new', 'SessionStart', { launchToken: 'new-generation' })
    expect(binding('ses_new')?.paneKey).toBe(PANE_A)
    expect(binding('ses_old')).toBeUndefined()
  })

  it('rejects another execution host token before learning its identity', async () => {
    const other = new IsolatedHookServer()
    other.isolateBinder(join(dir, 'other-no-user-database'))
    await other.start({ env: 'other-host', userDataPath: join(dir, 'other-host') })
    try {
      const { ORCA_AGENT_HOOK_PORT } = server.buildPtyEnv()
      const { ORCA_AGENT_HOOK_TOKEN } = other.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_A,
          env: 'other-host',
          opencodeTui: 1,
          payload: { hook_event_name: 'SessionBusy', sessionID: 'ses_other_host' }
        })
      })
      expect(response.status).toBe(403)
      expect(binding('ses_other_host')).toBeUndefined()
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      other.stop()
    }
  })
})
