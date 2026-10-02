import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, FRESH_PANE, OLD_PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

// A terminal that survived a restart: its environment still exports OLD_PANE, but it now shows in
// FRESH_PANE (a tab the adoption path minted with a new id).
const movedTerminal = (paneKey: string): string | undefined =>
  paneKey === OLD_PANE ? FRESH_PANE : undefined

function postFromSpawnedPane(server: AgentHookServer, prompt: string): Promise<Response> {
  return postHookEvent(
    server,
    buildBody(
      { hook_event_name: 'UserPromptSubmit', prompt },
      { paneKey: OLD_PANE, tabId: 'tab-old' }
    )
  )
}

describe('agent status follows the terminal, not the pane key it was spawned with', () => {
  let userDataPath: string
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-terminal-pane-routing-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('files a hook posted under the spawn key on the pane that shows the terminal now', async () => {
    server.setTerminalPaneResolver(movedTerminal)

    expect((await postFromSpawnedPane(server, 'after the restart')).status).toBe(204)

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        state: 'working',
        prompt: 'after the restart'
      })
    ])
  })

  it('moves rows filed under the spawn key once the host can route them', async () => {
    await postFromSpawnedPane(server, 'before the host knew')
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([OLD_PANE])

    server.setTerminalPaneResolver(movedTerminal)
    server.reconcileMovedTerminalPaneKeys([OLD_PANE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        prompt: 'before the host knew'
      })
    ])
    server.flushStatusPersistSync()
    expect(
      JSON.parse(readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8'))
    ).toEqual(expect.objectContaining({ entries: { [FRESH_PANE]: expect.anything() } }))
  })

  it('drops the spawn-key row when the live pane already reports for itself', async () => {
    await postFromSpawnedPane(server, 'stale')
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'current' },
        { paneKey: FRESH_PANE, tabId: 'tab-fresh' }
      )
    )

    server.setTerminalPaneResolver(movedTerminal)
    server.reconcileMovedTerminalPaneKeys([OLD_PANE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'current' })
    ])
  })

  it('never lets cleanup of the dead layout key reach the pane the terminal moved to', async () => {
    server.setTerminalPaneResolver(movedTerminal)
    await postFromSpawnedPane(server, 'live')

    server.clearPaneState(OLD_PANE)
    server.retirePaneAuthority(OLD_PANE)

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'live' })
    ])
    // The process keeps posting its spawn key; the retired layout key must not suppress it.
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'Stop' }, { paneKey: OLD_PANE, tabId: 'tab-old' })
    )
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, state: 'done' })
    ])
  })

  it('keeps a hook where it lands when the host cannot route the key', async () => {
    server.setTerminalPaneResolver(() => undefined)

    await postFromSpawnedPane(server, 'unrouted')

    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([OLD_PANE])
  })
})
