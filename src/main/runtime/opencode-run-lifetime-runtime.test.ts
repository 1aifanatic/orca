import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readCommandLineMock } = vi.hoisted(() => ({ readCommandLineMock: vi.fn() }))

vi.mock('./local-pty-foreground-command-line', () => ({
  readLocalPtyForegroundCommandLine: readCommandLineMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { FOREGROUND_COMMAND_READS } from '../../shared/foreground-command-settle'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function createRuntime(foregroundProcess = 'opencode'): {
  runtime: OrcaRuntimeService
  statuses: RuntimeTerminalAgentStatusEvent[]
  channelOrder: string[]
  getForegroundProcess: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
} {
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const channelOrder: string[] = []
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalAgentStatus: (event) => {
      statuses.push(event)
      channelOrder.push(`status:${event.payload.state}`)
    },
    onTerminalSideEffects: (batch) =>
      channelOrder.push(...batch.facts.map((fact) => `fact:${fact.kind}`))
  })
  const getForegroundProcess = vi.fn(async () => foregroundProcess)
  // Stands in for the IPC controller: a daemon attach reports the session's 133 state.
  const attach = vi.fn(async (ptyId: string) => {
    runtime.noteTerminalProviderReattach(ptyId, 'running')
    return true
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess,
    attach
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
  return { runtime, statuses, channelOrder, getForegroundProcess, attach }
}

/** A surviving daemon session main learned from inventory after a restart; no pane mounted it. */
function recordUnattachedPty(runtime: OrcaRuntimeService): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is protected; inventory adoption after a restart reaches it the same way.
  const internals = runtime as unknown as {
    recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
  }
  internals.recordPtyWorktree('pty-1', WORKTREE_ID, { connected: true })
}

const summary = (statuses: RuntimeTerminalAgentStatusEvent[]): string[] =>
  statuses.map(
    (event) =>
      `${event.paneKey}:${event.payload.state}${event.payload.interrupted ? ':interrupted' : ''}:${event.origin}`
  )

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

  it('posts Working after the command starts and Done when it finishes, on its own pane', async () => {
    const { runtime, statuses } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

    expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    expect(readCommandLineMock).toHaveBeenCalledWith('pty-1', 'opencode')
    expect(statuses[0]?.yieldsToHookSince).toBe(statuses[1]?.yieldsToHookSince)
  })

  // Why: the renderer drops an exited agent's row on command-finished unless it changed after.
  it("publishes the run's Done after the command-finished fact of the same chunk", async () => {
    const { runtime, channelOrder } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

    expect(channelOrder).toEqual(['status:working', 'fact:command-finished', 'status:done'])
  })

  it('posts Done from the daemon fact when the pane finished while hidden', async () => {
    const { runtime, statuses, channelOrder } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 130 })

    expect(channelOrder.slice(-2)).toEqual(['fact:command-finished', 'status:done'])
    expect(summary(statuses)).toEqual([
      `${PANE_KEY}:working:process`,
      `${PANE_KEY}:done:interrupted:process`
    ])
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

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  // Main hands its 133 scanner to the daemon while the pane's tab is hidden.
  describe('a run that starts while its tab is hidden', () => {
    it("posts Working from the daemon's command-started fact and Done from its command-finished", async () => {
      const { runtime, statuses } = createRuntime()
      runtime.setPtyTransientFactDelegation('pty-1', true)

      runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-started' })
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 0 })

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    })

    // Why: exactly one side scans each byte, so the relayed fact is the only start main acts on.
    it('does not arm from delivered bytes while the daemon holds the scan', async () => {
      const { runtime, statuses, getForegroundProcess } = createRuntime()
      runtime.setPtyTransientFactDelegation('pty-1', true)

      runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(getForegroundProcess).not.toHaveBeenCalled()

      runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-started' })
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      expect(getForegroundProcess).toHaveBeenCalledTimes(1)
      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`])
    })

    it("posts Done from main's own scanner once the tab is shown again", async () => {
      const { runtime, statuses } = createRuntime()
      runtime.setPtyTransientFactDelegation('pty-1', true)
      runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-started' })
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)

      runtime.setPtyTransientFactDelegation('pty-1', false)
      runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    })
  })

  // E.g. an Orca restart: the run printed its 133;C before this main process was listening.
  describe('a run already in flight when main attaches its surviving pane', () => {
    it('posts Working from one foreground check at reattach and Done at its 133;D', async () => {
      const { runtime, statuses } = createRuntime()
      runtime.registerPty('pty-1', WORKTREE_ID)

      runtime.noteTerminalSpawnCommit({ id: 'pty-1', isReattach: true, shellCommand: 'running' })
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    })

    it('treats an adopted agent session as a reattach', async () => {
      const { runtime, statuses } = createRuntime()
      runtime.registerPty('pty-1', WORKTREE_ID)

      runtime.noteTerminalSpawnCommit({
        id: 'pty-1',
        agentSessionEnsure: { disposition: 'adopted' },
        shellCommand: 'running'
      })
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`])
    })

    it('checks nothing for a freshly spawned or split pane', async () => {
      const { runtime, getForegroundProcess } = createRuntime()
      runtime.registerPty('pty-1', WORKTREE_ID)

      runtime.noteTerminalSpawnCommit({ id: 'pty-1', shellCommand: 'running' })
      runtime.noteTerminalSpawnCommit(
        { id: 'pty-1', isReattach: true, shellCommand: 'running' },
        { sourcePtyId: 'x' }
      )
      await vi.advanceTimersByTimeAsync(60_000)

      expect(getForegroundProcess).not.toHaveBeenCalled()
    })

    it.each(['at-prompt', 'unmarked', undefined] as const)(
      'checks nothing when the daemon reports the shell as %s',
      async (shellCommand) => {
        const { runtime, statuses, getForegroundProcess } = createRuntime()
        runtime.registerPty('pty-1', WORKTREE_ID)

        runtime.noteTerminalSpawnCommit({ id: 'pty-1', isReattach: true, shellCommand })
        await vi.advanceTimersByTimeAsync(60_000)

        expect(getForegroundProcess).not.toHaveBeenCalled()
        expect(statuses).toEqual([])
      }
    )

    it('posts Working when a remote viewer is the first to attach the pane', async () => {
      const { runtime, statuses, attach } = createRuntime()
      recordUnattachedPty(runtime)

      runtime.registerRemoteTerminalViewSubscriber('pty-1')
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

      expect(attach).toHaveBeenCalledWith('pty-1')
      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    })

    it('posts one Working when a desktop mount follows a remote attach', async () => {
      const { runtime, statuses, attach } = createRuntime()
      recordUnattachedPty(runtime)

      runtime.registerRemoteTerminalViewSubscriber('pty-1')
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      expect(attach).toHaveBeenCalledTimes(1)
      runtime.registerPty('pty-1', WORKTREE_ID)
      runtime.noteTerminalSpawnCommit({ id: 'pty-1', isReattach: true, shellCommand: 'running' })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`])
    })

    it('checks a running non-OpenCode command once and never again', async () => {
      const { runtime, statuses, getForegroundProcess } = createRuntime('zsh')
      runtime.registerPty('pty-1', WORKTREE_ID)

      runtime.noteTerminalSpawnCommit({ id: 'pty-1', isReattach: true, shellCommand: 'running' })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(getForegroundProcess).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual([])
    })

    it('stays silent for a reattached SSH pane', async () => {
      const { runtime, getForegroundProcess } = createRuntime()
      runtime.registerPty('pty-1', WORKTREE_ID, 'ssh-conn-1')

      runtime.noteTerminalSpawnCommit({ id: 'pty-1', isReattach: true, shellCommand: 'running' })
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)

      expect(getForegroundProcess).not.toHaveBeenCalled()
    })
  })
})
