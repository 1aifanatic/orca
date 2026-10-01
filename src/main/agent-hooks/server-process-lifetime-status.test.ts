import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, LEAF_1, PANE, postHookEvent } from './server.test-fixtures'
import { makePaneKey } from '../../shared/stable-pane-id'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-process-lifetime-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.restoreAllMocks()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

function processLifetime(state: 'working' | 'done', yieldsToHookSince: number): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    origin: 'process',
    yieldsToHookSince,
    payload: { state, prompt: '', agentType: 'opencode' }
  })
}

async function openCodeHook(hookEventName: string): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: hookEventName, sessionID: 'ses_1' }),
    '/hook/opencode'
  )
  expect(response.status).toBe(204)
}

function paneState(): string {
  return server.getStatusSnapshotForPane(PANE)[0]?.state ?? 'missing'
}

function paneReceivedAt(): number | undefined {
  return server.getStatusSnapshotForPane(PANE)[0]?.receivedAt
}

async function nextMillisecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

// One `opencode run` command in one pane: the host reports it from the process lifetime unless a
// hook producer (OpenCode 1's in-process plugin) reports the same pane during that command.
describe('process-lifetime status', () => {
  it('reports Working, then Done, when no hook speaks for the command', () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('working')
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('yields the rest of the command once a hook reports the pane', async () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    await openCodeHook('SessionBusy')
    // The hook is still Working, so the process exit must not write a second Done over it.
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('working')
    await openCodeHook('SessionIdle')
    expect(paneState()).toBe('done')
  })

  it('writes no Working over a hook that already claimed the command', async () => {
    const commandStartedAt = Date.now()
    await openCodeHook('SessionIdle')
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('does not yield to a hook row from before the command started', async () => {
    await openCodeHook('SessionIdle')
    await nextMillisecond()
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('working')
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  // Why: a pane where an Orca-launched agent exited is retired; a new `opencode run` there is a new run.
  it('revives a retired pane on its Working, as a hook new-turn event does', () => {
    server.retirePaneAuthority(PANE)
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('working')
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('keeps OSC status and a lone process Done out of a retired pane', () => {
    server.retirePaneAuthority(PANE)
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: '', agentType: 'opencode' }
    })
    processLifetime('done', Date.now())
    expect(paneState()).toBe('missing')
  })

  // Why: a pane holding launch authority retires it at the 133;D that ends the run.
  it('keeps the Done of a run whose own command end retired the pane, and fences what follows', async () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    await nextMillisecond()
    server.retirePaneAuthority(PANE)
    expect(paneState()).toBe('missing')

    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')

    // A late post from the retired launch is still suppressed: the Done did not lift the fence.
    await openCodeHook('SessionBusy')
    expect(paneState()).toBe('done')
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: '', agentType: 'opencode' }
    })
    expect(paneState()).toBe('done')
  })

  it('suppresses a stale hook post after retirement before the run reports its end', async () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    await nextMillisecond()
    server.retirePaneAuthority(PANE)

    await openCodeHook('SessionBusy')
    expect(paneState()).toBe('missing')
  })

  it('keeps the Done of a retired run out of a closed tab', async () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    await nextMillisecond()
    server.retirePaneAuthority(PANE)
    server.dropStatusEntriesByTabPrefix('tab-1')

    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('missing')
  })

  it.each([
    ['still working', ['SessionBusy']],
    ['already done', ['SessionBusy', 'SessionIdle']]
  ])(
    'keeps the process Done of a hook-owned run out of a retired pane (hook %s)',
    async (_, hooks) => {
      const commandStartedAt = Date.now()
      processLifetime('working', commandStartedAt)
      for (const hook of hooks) {
        await openCodeHook(hook)
      }
      server.retirePaneAuthority(PANE)

      processLifetime('done', commandStartedAt)
      expect(paneState()).toBe('missing')
    }
  )

  it('keeps the Done of a retired run whatever the wall clock reads at retirement', () => {
    const commandStartedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(commandStartedAt)
    processLifetime('working', commandStartedAt)
    clock.mockReturnValue(commandStartedAt - 60_000)
    server.retirePaneAuthority(PANE)

    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  // Why: a command end retires each of the pane's keys, so the later retirements find no rows.
  it('keeps the Done when the pane retires again before the run reports its end', () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    server.retirePaneAuthority(PANE)
    server.retirePaneAuthority(PANE)

    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('settles a retired run once', async () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    server.retirePaneAuthority(PANE)
    processLifetime('done', commandStartedAt)
    const settledAt = paneReceivedAt()
    expect(settledAt).toBeDefined()

    await nextMillisecond()
    processLifetime('done', commandStartedAt)
    expect(paneReceivedAt()).toBe(settledAt)
  })

  it('does not settle a run that had already ended when the pane retired', () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    processLifetime('done', commandStartedAt)
    server.retirePaneAuthority(PANE)

    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('missing')
  })

  it('does not let a run captured before a newer run settle that newer run', () => {
    const firstStartedAt = Date.now()
    processLifetime('working', firstStartedAt)
    server.retirePaneAuthority(PANE)
    const secondStartedAt = Date.now()
    processLifetime('working', secondStartedAt)
    expect(paneState()).toBe('working')
    // The newer run's row is dismissed, so its retirement captures nothing of its own.
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    server.retirePaneAuthority(PANE)

    processLifetime('done', secondStartedAt)
    expect(paneState()).toBe('missing')
  })

  // Why: moving the pane to another tab and back lifts its retirement without a new-turn restart.
  it('does not carry a run over from a retirement the pane has since left', async () => {
    const firstStartedAt = Date.now()
    processLifetime('working', firstStartedAt)
    server.retirePaneAuthority(PANE)
    const otherTabPane = makePaneKey('tab-2', LEAF_1)
    server.transferPaneAuthority(PANE, otherTabPane, 'pty-1')
    server.transferPaneAuthority(otherTabPane, PANE, 'pty-1')
    await nextMillisecond()

    // The next run is hook-owned (OpenCode 1 style); its row is dismissed before its command end.
    const secondStartedAt = Date.now()
    processLifetime('working', secondStartedAt)
    await openCodeHook('SessionBusy')
    expect(paneState()).toBe('working')
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    server.retirePaneAuthority(PANE)

    processLifetime('done', secondStartedAt)
    expect(paneState()).toBe('missing')
  })
})
