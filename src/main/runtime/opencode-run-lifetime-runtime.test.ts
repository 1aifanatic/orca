import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readCommandLineMock } = vi.hoisted(() => ({ readCommandLineMock: vi.fn() }))

vi.mock('./local-pty-foreground-command-line', () => ({
  readLocalPtyForegroundCommandLine: readCommandLineMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { FOREGROUND_COMMAND_READS } from '../../shared/foreground-command-settle'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function createRuntime(): {
  runtime: OrcaRuntimeService
  statuses: RuntimeTerminalAgentStatusEvent[]
  channelOrder: string[]
  statusStore: ReturnType<typeof makeAgentStatusStoreWiring>['statusStore']
} {
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const channelOrder: string[] = []
  // Why the real store: it is what the sidebar, `worktree ps` and mobile all read.
  const wiring = makeAgentStatusStoreWiring()
  wiring.statusStore.subscribePaneStatusClear((clear) =>
    channelOrder.push(`clear:${'paneKey' in clear ? clear.paneKey : ''}`)
  )
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    ...wiring.deps,
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      wiring.statusStore.retirePaneAuthority(paneKey),
    onTerminalAgentStatus: (event) => {
      statuses.push(event)
      channelOrder.push(`status:${event.payload.state}`)
      wiring.deps.onTerminalAgentStatus(event)
    },
    onTerminalSideEffects: (batch) =>
      channelOrder.push(...batch.facts.map((fact) => `fact:${fact.kind}`))
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'opencode'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: 'tab-1', worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: 'pty-1' }
    ]
  })
  return { runtime, statuses, channelOrder, statusStore: wiring.statusStore }
}

const hostRows = (statusStore: ReturnType<typeof createRuntime>['statusStore']): string[] =>
  statusStore
    .getStatusSnapshot()
    .filter((row) => row.paneKey === PANE_KEY && row.providerSessionOnly !== true)
    .map((row) => row.state)

const summary = (statuses: RuntimeTerminalAgentStatusEvent[]): string[] =>
  statuses.map((event) => `${event.paneKey}:${event.payload.state}:${event.origin}`)

// `opencode run` typed in a pane: the pane's own command boundaries and foreground drive its row.
describe('OpenCode run process lifetime in the runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readCommandLineMock.mockReset()
    readCommandLineMock.mockResolvedValue('opencode run fix the bug')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts Working after the command starts, on its own pane, and no status when it finishes', async () => {
    const { runtime, statuses } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

    expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`])
    expect(readCommandLineMock).toHaveBeenCalledWith('pty-1', 'opencode')
  })

  it('stays silent for an SSH pane', async () => {
    const { runtime, statuses } = createRuntime()
    runtime.registerPty('pty-1', WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', '\x1b]133;D;0\x07', 101)

    expect(statuses).toEqual([])
    expect(readCommandLineMock).not.toHaveBeenCalled()
  })

  it('reports a local Windows pane from its own foreground', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const { runtime, statuses } = createRuntime()
      readCommandLineMock.mockResolvedValue('"C:\\Tools\\opencode.exe" run fix it')

      runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      runtime.onPtyData('pty-1', '\x1b]133;D;0\x07', 101)

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`])
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})

// Why: Done means a live TUI finished its turn. Once `opencode run` exits nothing runs in the pane,
// so its row must leave the host store every reader subscribes to, as any exited agent's does.
describe('OpenCode run exit in the host status store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readCommandLineMock.mockReset()
    readCommandLineMock.mockResolvedValue('opencode run fix the bug')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function startRun(): Promise<ReturnType<typeof createRuntime>> {
    const wired = createRuntime()
    wired.runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    expect(hostRows(wired.statusStore)).toEqual(['working'])
    return wired
  }

  it.each([
    ['exits', 0],
    ['is interrupted with Ctrl+C', 130]
  ])('clears the row of a visible pane whose run %s', async (_label, exitCode) => {
    const { runtime, statusStore, channelOrder } = await startRun()

    runtime.onPtyData('pty-1', `done\x1b]133;D;${exitCode}\x07`, 101)

    expect(hostRows(statusStore)).toEqual([])
    expect(channelOrder).not.toContain('status:done')
    expect(channelOrder.slice(-2)).toEqual([`clear:${PANE_KEY}`, 'fact:command-finished'])
  })

  it.each([
    ['exits', 0],
    ['is interrupted with Ctrl+C', 130]
  ])('clears the row of a hidden pane whose run %s', async (_label, exitCode) => {
    const { runtime, statusStore, channelOrder } = await startRun()

    runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode })

    expect(hostRows(statusStore)).toEqual([])
    expect(channelOrder).not.toContain('status:done')
    expect(channelOrder.slice(-2)).toEqual([`clear:${PANE_KEY}`, 'fact:command-finished'])
  })

  // Why: a terminal-list refresh marks live panes as restored launch authority, and retiring that
  // authority on command-finished deletes the pane's rows without telling the renderer.
  it.each([
    ['visible', 'chunk'],
    ['hidden', 'daemon fact']
  ])('clears the %s pane on the renderer too when a refresh had marked it', async (_l, path) => {
    const { runtime, statusStore, channelOrder } = await startRun()
    runtime['restoredOrchestrationAuthorityByPtyId'].set('pty-1', {
      ptyId: 'pty-1',
      worktreeId: WORKTREE_ID,
      terminalHandle: 'term-1',
      paneKey: PANE_KEY,
      processIncarnation: 'pty-1:1',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    if (path === 'chunk') {
      runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)
    } else {
      runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 0 })
    }

    expect(hostRows(statusStore)).toEqual([])
    expect(channelOrder).toContain(`clear:${PANE_KEY}`)
  })

  it('clears the row when the next command starts without the run’s command-finished', async () => {
    const { runtime, statusStore, channelOrder } = await startRun()
    readCommandLineMock.mockResolvedValue('ls')

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 101)

    expect(hostRows(statusStore)).toEqual([])
    expect(channelOrder).toContain(`clear:${PANE_KEY}`)
  })

  it('leaves the row of a pane whose foreground was never `opencode run` to its own agent', async () => {
    readCommandLineMock.mockResolvedValue('opencode')
    const { runtime, statusStore } = createRuntime()
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"done","prompt":"ship it","agentType":"opencode"}\x07',
      99
    )
    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)

    runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 0 })

    expect(hostRows(statusStore)).toEqual(['done'])
  })
})
