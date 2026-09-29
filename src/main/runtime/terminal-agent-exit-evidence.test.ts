import { describe, expect, it, vi } from 'vitest'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'
import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'

vi.mock('./orca-runtime-controller-knows-pty-is-live', () => ({
  OrcaRuntimeWithControllerKnowsPtyIsLive: class {}
}))

class ExitHarness extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  confirm(): void {
    this.confirmPtyAgentExit('pty-1')
  }
}

function setup() {
  const runtime = new ExitHarness(null)
  const facts: TerminalSideEffectFact[] = []
  const controller = {}
  const pty = { connected: true, incarnationId: 'inc-1', lastOscTitleAt: 1, lastAgentStatus: null }
  const tracker = createTerminalTitleTracker(
    { onAgentExitCandidate: () => runtime.confirm() },
    { initialTitle: 'Claude ready' }
  )
  const read = vi.fn().mockResolvedValue({ controller, process: null, available: true })
  Object.assign(runtime, {
    ptysById: new Map([['pty-1', pty]]),
    handleByPtyId: new Map(),
    ptyController: controller,
    ptyTitleTrackersByPtyId: new Map([['pty-1', { tracker }]]),
    readPtyForegroundProcessFromController: read,
    recordTerminalSideEffectFact: (_id: string, fact: TerminalSideEffectFact) => facts.push(fact),
    getLeavesForPty: () => []
  })
  return { runtime, facts, controller, pty, tracker, read }
}

describe('host-confirmed agent exit', () => {
  it.each([null, '', 'node.exe', 'other-tool'])(
    'retains Claude after %j and observes a later shell',
    async (process) => {
      const h = setup()
      h.read.mockResolvedValue({ controller: h.controller, process, available: true })
      h.tracker.handleChunk('\x1b]0;workspace\x07')
      await Promise.resolve()
      expect(h.facts).toEqual([])
      h.read.mockResolvedValue({ controller: h.controller, process: 'zsh', available: true })
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
          : Promise.resolve({
              controller: kind === 'replaced' ? {} : h.controller,
              process: 'zsh',
              available: kind !== 'unavailable'
            })
      )
      h.tracker.handleChunk('\x1b]0;workspace\x07')
      await Promise.resolve()
      expect(h.facts).toEqual([])
      h.read.mockResolvedValue({ controller: h.controller, process: 'zsh', available: true })
      h.tracker.handleChunk('\x1b]0;next workspace\x07')
      await Promise.resolve()
      expect(h.facts).toHaveLength(1)
      h.tracker.dispose()
    }
  )
  it('ignores an observation after terminal incarnation replacement', async () => {
    const h = setup()
    h.read.mockResolvedValue({ controller: h.controller, process: 'zsh', available: true })
    h.tracker.handleChunk('\x1b]0;workspace\x07')
    h.pty.incarnationId = 'inc-2'
    await Promise.resolve()
    expect(h.facts).toEqual([])
    h.tracker.dispose()
  })
})
