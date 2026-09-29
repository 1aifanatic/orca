import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import { OrcaRuntimeWithAgentExitConfirmation } from './orca-runtime-agent-exit-confirmation'
import { judgeForegroundAgent } from '../../shared/foreground-agent-verdict'
import { noteShellCommandStarted } from './shell-command-agent-hold'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

const stubController = (): RuntimePtyController => ({
  write: () => true,
  kill: () => true,
  getForegroundProcess: async () => null
})

const readResult = (controller: RuntimePtyController, processName: string | null) => ({
  controller,
  judgement: judgeForegroundAgent({ kind: 'process-name', processName })
})

vi.mock('./orca-runtime-controller-knows-pty-is-live', () => ({
  OrcaRuntimeWithControllerKnowsPtyIsLive: class {
    markPtyLivenessLive(): void {}
    disposePtyTitleTracker(): void {}
  }
}))

afterEach(() => {
  vi.useRealTimers()
})

class ExitHarness extends OrcaRuntimeWithAgentExitConfirmation {
  confirm(): void {
    this.confirmPtyAgentExit('pty-1')
  }
  commandStarted(): void {
    const pty = this.ptysById.get('pty-1')
    if (pty) {
      noteShellCommandStarted(pty)
    }
  }
  commandFinished(): void {
    this.confirmPtyAgentExitAtCommandFinished('pty-1')
  }
  dispose(): void {
    this.disposePtyTitleTracker('pty-1')
  }
}

function setup() {
  const runtime = new ExitHarness(null)
  const facts: TerminalSideEffectFact[] = []
  const controller = stubController()
  const pty: {
    connected: boolean
    incarnationId: string
    lastOscTitleAt: number
    lastAgentStatus: string | null
    lastAgentStatusObservedLive: boolean
    launchAgent: string | null
    foregroundAgent: string | null
    foregroundAgentIncarnationId?: string | null
    connectionId?: string
    shellCommandMarks?: { incarnationId: string | null; commandRunning: boolean }
  } = {
    connected: true,
    incarnationId: 'inc-1',
    lastOscTitleAt: 1,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    launchAgent: null,
    foregroundAgent: null,
    // A shell with Orca's integration has marked commands before the agent ran.
    shellCommandMarks: { incarnationId: 'inc-1', commandRunning: false }
  }
  const markExited = vi.fn()
  const tracker = createTerminalTitleTracker(
    { onAgentExitCandidate: () => runtime.confirm() },
    { initialTitle: 'Claude ready' }
  )
  const read = vi.fn().mockResolvedValue(readResult(controller, null))
  const lifecycle = { generation: 1 }
  Object.assign(runtime, {
    ptysById: new Map([['pty-1', pty]]),
    handleByPtyId: new Map(),
    ptyController: controller,
    ptyTitleTrackersByPtyId: new Map([['pty-1', { tracker }]]),
    readPtyForegroundProcessFromController: read,
    recordTerminalSideEffectFact: (_id: string, fact: TerminalSideEffectFact) => facts.push(fact),
    getLeavesForPty: () => [],
    resolvePtyTuiIdleWaiters: () => {},
    titleObservationSequence: 1,
    ptyForegroundAgent: { markExited },
    getPtyLifecycleGeneration: () => lifecycle.generation
  })
  return { runtime, facts, controller, pty, tracker, read, markExited, lifecycle }
}

describe('host-confirmed agent exit', () => {
  it.each([null, '', 'node.exe', 'other-tool'])(
    'retains Claude after %j and observes a later shell',
    async (process) => {
      vi.useFakeTimers()
      const h = setup()
      h.read.mockResolvedValue(readResult(h.controller, process))
      h.tracker.handleChunk('\x1b]0;workspace\x07')
      await vi.advanceTimersByTimeAsync(0)
      expect(h.facts).toEqual([])
      // The later shell arrives by a re-read or by the next neutral title, whichever is owed.
      h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
      h.tracker.handleChunk('\x1b]0;next workspace\x07')
      await vi.advanceTimersByTimeAsync(8000)
      expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'foreground-shell' }])
      h.tracker.dispose()
    }
  )
  it.each(['missing', 'unavailable', 'replaced'] as const)(
    'does not publish exit for a %s controller observation',
    async (kind) => {
      vi.useFakeTimers()
      const h = setup()
      h.read.mockReturnValue(
        kind === 'missing'
          ? null
          : Promise.resolve(
              kind === 'unavailable'
                ? { controller: h.controller, judgement: judgeForegroundAgent({ kind }) }
                : readResult(stubController(), 'zsh')
            )
      )
      h.tracker.handleChunk('\x1b]0;workspace\x07')
      await vi.advanceTimersByTimeAsync(0)
      expect(h.facts).toEqual([])
      h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
      h.tracker.handleChunk('\x1b]0;next workspace\x07')
      await vi.advanceTimersByTimeAsync(8000)
      expect(h.facts).toHaveLength(1)
      h.tracker.dispose()
    }
  )
  it('retires an agent on its own title where the SSH host can neither read nor mark commands', async () => {
    const h = setup()
    h.pty.connectionId = 'ssh-windows'
    h.read.mockResolvedValue({
      controller: h.controller,
      judgement: judgeForegroundAgent({
        kind: 'host-evidence',
        evidence: {
          authorityGeneration: 'host-1',
          observationEpoch: 1,
          capturedAgeMs: 0,
          ptyId: 'pty-1',
          ptyIncarnationId: 'inc-1',
          verdict: 'unverifiable',
          reason: 'windows_ssh_foreground_unavailable'
        }
      })
    })
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await Promise.resolve()
    expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'agent-title' }])
    expect(h.markExited).toHaveBeenCalledWith('pty-1')
    h.tracker.dispose()
  })
  it('keeps a local WSL agent through a neutral title where its shell marks commands', async () => {
    const h = setup()
    h.read.mockResolvedValue(readResult(h.controller, 'wsl.exe'))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await Promise.resolve()
    expect(h.facts).toEqual([])
    expect(h.markExited).not.toHaveBeenCalled()
    h.tracker.dispose()
  })
  it.each([
    ['a WSL shell that marks no commands', 'wsl.exe', false],
    ['claude inside tmux', 'tmux', true],
    ['claude over ssh', 'ssh', true],
    ['another program, where the shell marks no commands', 'vim', false]
  ])('retires the agent on its own title for %s', async (_label, process, marks) => {
    const h = setup()
    if (!marks) {
      h.pty.shellCommandMarks = undefined
    }
    h.read.mockResolvedValue(readResult(h.controller, process))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await Promise.resolve()
    expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'agent-title' }])
    expect(h.markExited).toHaveBeenCalledWith('pty-1')
    h.tracker.dispose()
  })
  it('keeps the agent through a failed read on a pane that marks no commands', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.pty.shellCommandMarks = undefined
    h.read.mockResolvedValue({
      controller: h.controller,
      judgement: judgeForegroundAgent({ kind: 'unavailable' })
    })
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(8000)
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })
  it('ignores an observation after terminal incarnation replacement', async () => {
    const h = setup()
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    h.pty.incarnationId = 'inc-2'
    await Promise.resolve()
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })
})

describe('agent exit at the shell 133;D', () => {
  it('publishes one exit when a read shows the shell after an agent title', async () => {
    const h = setup()
    h.pty.lastAgentStatus = 'idle'
    h.pty.lastAgentStatusObservedLive = true
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.runtime.commandFinished()
    await vi.waitFor(() =>
      expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'foreground-shell' }])
    )
    expect(h.pty.lastAgentStatus).toBeNull()
    // A later ordinary command pays no read and publishes nothing.
    h.runtime.commandFinished()
    await Promise.resolve()
    expect(h.read).toHaveBeenCalledOnce()
    expect(h.facts).toHaveLength(1)
    h.tracker.dispose()
  })
  it.each([
    ['a live agent (leaked nested-shell 133;D)', 'claude'],
    ['another program', 'node'],
    ['no answer', null]
  ])('keeps the agent when the read shows %s', async (_label, process) => {
    const h = setup()
    h.pty.launchAgent = 'claude'
    h.runtime.commandStarted()
    h.read.mockResolvedValue(readResult(h.controller, process))
    h.runtime.commandFinished()
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })
  it('retires the agent on the 133;D where no read can ever name the shell', async () => {
    const h = setup()
    h.pty.foregroundAgent = 'claude'
    h.pty.foregroundAgentIncarnationId = 'inc-1'
    h.read.mockResolvedValue(readResult(h.controller, 'wsl.exe'))
    h.runtime.commandFinished()
    await vi.waitFor(() =>
      expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'command-finished' }])
    )
    expect(h.markExited).toHaveBeenCalledWith('pty-1')
    h.tracker.dispose()
  })
  it('ends a launched agent at the 133;D that closes its command', async () => {
    const h = setup()
    h.pty.launchAgent = 'claude'
    h.runtime.commandStarted()
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.runtime.commandFinished()
    await vi.waitFor(() =>
      expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'foreground-shell' }])
    )
    h.tracker.dispose()
  })
  it('does not read for a 133;D on a pane that never held an agent', () => {
    const h = setup()
    h.runtime.commandFinished()
    expect(h.read).not.toHaveBeenCalled()
    h.tracker.dispose()
  })
})

describe('a 133;D printed before the launched agent starts', () => {
  const shellAtPrompt = { verdict: 'exited', processName: null, canCertifyExit: true } as const
  it.each([
    ['a local shell', (h: ReturnType<typeof setup>) => readResult(h.controller, 'zsh')],
    [
      'an SSH host showing its shell',
      (h: ReturnType<typeof setup>) => {
        h.pty.connectionId = 'ssh-1'
        return { controller: h.controller, judgement: shellAtPrompt }
      }
    ],
    [
      'a host that cannot read the foreground',
      (h: ReturnType<typeof setup>) => {
        h.pty.connectionId = 'ssh-old'
        return {
          controller: h.controller,
          judgement: judgeForegroundAgent({ kind: 'host-without-evidence' })
        }
      }
    ]
  ])('does not end the launch on %s', async (_label, answer) => {
    const h = setup()
    h.pty.launchAgent = 'claude'
    h.read.mockResolvedValue(answer(h))
    // A user shell integration's first-prompt D, before Orca's startup command runs.
    h.runtime.commandFinished()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.facts).toEqual([])
    expect(h.markExited).not.toHaveBeenCalled()
    h.tracker.dispose()
  })
  it('does not count a command started by an earlier incarnation', async () => {
    const h = setup()
    h.pty.launchAgent = 'claude'
    h.runtime.commandStarted()
    h.pty.incarnationId = 'inc-2'
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.runtime.commandFinished()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })
  it('does not count an agent a read saw in an earlier incarnation', async () => {
    const h = setup()
    h.pty.launchAgent = 'claude'
    h.pty.foregroundAgent = 'claude'
    h.pty.foregroundAgentIncarnationId = 'inc-1'
    // A same-id respawn: the new shell prints its first-prompt D before the agent relaunches.
    h.pty.incarnationId = 'inc-2'
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.runtime.commandFinished()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.read).not.toHaveBeenCalled()
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })
  it('counts one 133;D per started command when a user integration doubles the marks', async () => {
    const h = setup()
    h.pty.launchAgent = 'claude'
    h.runtime.commandStarted()
    h.runtime.commandStarted()
    h.read.mockResolvedValue(readResult(h.controller, 'claude'))
    h.runtime.commandFinished()
    h.runtime.commandFinished()
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce())
    h.tracker.dispose()
  })
})

describe('re-deriving an exit candidate the first read could not answer', () => {
  const unanswered = (h: ReturnType<typeof setup>) => ({
    controller: h.controller,
    judgement: judgeForegroundAgent({ kind: 'unavailable' })
  })

  it('leaves Chat when a read fails once and the re-read shows the shell', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.read.mockResolvedValueOnce(unanswered(h))
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.facts).toEqual([])
    await vi.advanceTimersByTimeAsync(1200)
    expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'foreground-shell' }])
    expect(h.read).toHaveBeenCalledTimes(2)
    h.tracker.dispose()
  })

  it('stops after the bounded ladder, then re-reads once when the host is reached again', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.read.mockResolvedValue(unanswered(h))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.read).toHaveBeenCalledTimes(3)
    expect(h.facts).toEqual([])
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'foreground-shell' }])
    h.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.read).toHaveBeenCalledTimes(4)
    h.tracker.dispose()
  })

  it('re-reads only once on contact, even when that read fails too', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.read.mockResolvedValue(unanswered(h))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(60_000)
    h.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)
    h.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.read).toHaveBeenCalledTimes(4)
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })

  it('never re-reads an old candidate into a same-id replacement incarnation', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.read.mockResolvedValueOnce(unanswered(h))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(0)
    // The respawned agent's shell is still booting when the ladder would fire.
    h.pty.incarnationId = 'inc-2'
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    await vi.advanceTimersByTimeAsync(60_000)
    h.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.facts).toEqual([])
    expect(h.read).toHaveBeenCalledOnce()
    h.tracker.dispose()
  })

  it('drops a candidate whose read was still out when its process exited', async () => {
    vi.useFakeTimers()
    const h = setup()
    let answer: (result: ReturnType<typeof unanswered>) => void = () => {}
    h.read.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    // The PTY exits and a same-id shell respawns before the host answers.
    h.lifecycle.generation += 1
    h.pty.connected = false
    h.runtime.dispose()
    answer(unanswered(h))
    await vi.advanceTimersByTimeAsync(0)
    h.pty.connected = true
    h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
    h.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.facts).toEqual([])
    expect(h.read).toHaveBeenCalledOnce()
    h.tracker.dispose()
  })

  it('ends the ladder at a live answer, and drops it when the PTY is disposed', async () => {
    vi.useFakeTimers()
    const live = setup()
    live.read.mockResolvedValueOnce(unanswered(live))
    live.read.mockResolvedValue(readResult(live.controller, 'claude'))
    live.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(live.read).toHaveBeenCalledTimes(2)
    live.runtime.markPtyLivenessLive('pty-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(live.read).toHaveBeenCalledTimes(2)
    live.tracker.dispose()

    const disposed = setup()
    disposed.read.mockResolvedValue(unanswered(disposed))
    disposed.tracker.handleChunk('\x1b]0;workspace\x07')
    await vi.advanceTimersByTimeAsync(0)
    disposed.runtime.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(disposed.read).toHaveBeenCalledOnce()
    disposed.tracker.dispose()
  })
})
