import { describe, expect, it, vi } from 'vitest'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import { judgeForegroundAgent } from '../../shared/foreground-agent-verdict'

const readResult = (controller: object, processName: string | null) => ({
  controller,
  judgement: judgeForegroundAgent({ kind: 'process-name', processName })
})

vi.mock('./orca-runtime-controller-knows-pty-is-live', () => ({
  OrcaRuntimeWithControllerKnowsPtyIsLive: class {}
}))

class ExitHarness extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  confirm(): void {
    this.confirmPtyAgentExit('pty-1')
  }
  commandFinished(): void {
    this.confirmPtyAgentExitAtCommandFinished('pty-1')
  }
}

function setup() {
  const runtime = new ExitHarness(null)
  const facts: TerminalSideEffectFact[] = []
  const controller = {}
  const pty: {
    connected: boolean
    incarnationId: string
    lastOscTitleAt: number
    lastAgentStatus: string | null
    launchAgent: string | null
    foregroundAgent: string | null
  } = {
    connected: true,
    incarnationId: 'inc-1',
    lastOscTitleAt: 1,
    lastAgentStatus: null,
    launchAgent: null,
    foregroundAgent: null
  }
  const markExited = vi.fn()
  const tracker = createTerminalTitleTracker(
    { onAgentExitCandidate: () => runtime.confirm() },
    { initialTitle: 'Claude ready' }
  )
  const read = vi.fn().mockResolvedValue(readResult(controller, null))
  Object.assign(runtime, {
    ptysById: new Map([['pty-1', pty]]),
    handleByPtyId: new Map(),
    ptyController: controller,
    ptyTitleTrackersByPtyId: new Map([['pty-1', { tracker }]]),
    readPtyForegroundProcessFromController: read,
    recordTerminalSideEffectFact: (_id: string, fact: TerminalSideEffectFact) => facts.push(fact),
    getLeavesForPty: () => [],
    titleObservationSequence: 1,
    ptyForegroundAgent: { markExited }
  })
  return { runtime, facts, controller, pty, tracker, read, markExited }
}

describe('host-confirmed agent exit', () => {
  it.each([null, '', 'node.exe', 'other-tool'])(
    'retains Claude after %j and observes a later shell',
    async (process) => {
      const h = setup()
      h.read.mockResolvedValue(readResult(h.controller, process))
      h.tracker.handleChunk('\x1b]0;workspace\x07')
      await Promise.resolve()
      expect(h.facts).toEqual([])
      h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
      h.tracker.handleChunk('\x1b]0;next workspace\x07')
      await Promise.resolve()
      expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'foreground-shell' }])
      h.tracker.dispose()
    }
  )
  it.each(['missing', 'unavailable', 'replaced'] as const)(
    'does not publish exit for a %s controller observation',
    async (kind) => {
      const h = setup()
      h.read.mockReturnValue(
        kind === 'missing'
          ? null
          : Promise.resolve(
              kind === 'unavailable'
                ? { controller: h.controller, judgement: judgeForegroundAgent({ kind }) }
                : readResult({}, 'zsh')
            )
      )
      h.tracker.handleChunk('\x1b]0;workspace\x07')
      await Promise.resolve()
      expect(h.facts).toEqual([])
      h.read.mockResolvedValue(readResult(h.controller, 'zsh'))
      h.tracker.handleChunk('\x1b]0;next workspace\x07')
      await Promise.resolve()
      expect(h.facts).toHaveLength(1)
      h.tracker.dispose()
    }
  )
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
    h.read.mockResolvedValue(readResult(h.controller, 'wsl.exe'))
    h.runtime.commandFinished()
    await vi.waitFor(() =>
      expect(h.facts).toEqual([{ kind: 'agent-exited', evidence: 'command-finished' }])
    )
    expect(h.markExited).toHaveBeenCalledWith('pty-1')
    h.tracker.dispose()
  })
  it('does not read for a 133;D on a pane that never held an agent', () => {
    const h = setup()
    h.runtime.commandFinished()
    expect(h.read).not.toHaveBeenCalled()
    h.tracker.dispose()
  })
})
