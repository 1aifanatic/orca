import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyOutputTitleObserver } from './pty-output-title-observer'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import {
  _dispatchTerminalSideEffectBatchForTest,
  _resetTerminalSideEffectFactConsumersForTest,
  registerTerminalSideEffectFactConsumer
} from './terminal-side-effect-facts-handler'

afterEach(() => {
  vi.useRealTimers()
  _resetTerminalSideEffectFactConsumersForTest()
})

describe('agent exit observation', () => {
  it('keeps a title candidate alive until a host can confirm it', () => {
    const candidate = vi.fn()
    const observer = createPtyOutputTitleObserver({
      onTitleChange: vi.fn(),
      onAgentExitCandidate: candidate,
      initialAgentTitle: 'Claude ready'
    })
    observer.processObservedTitles(['workspace'], 'none', false)
    observer.processObservedTitles(['another workspace'], 'none', false)
    expect(candidate).toHaveBeenCalledTimes(2)
    observer.reset()
  })
  it('treats an old host exit fact as a candidate, not a confirmed exit', () => {
    const exited = vi.fn()
    const candidate = vi.fn()
    registerTerminalSideEffectFactConsumer({
      ptyId: 'pty-1',
      callbacks: { onAgentExited: exited, onAgentExitCandidate: candidate }
    })
    _dispatchTerminalSideEffectBatchForTest({
      ptyId: 'pty-1',
      seq: 1,
      facts: [{ kind: 'agent-exited' }]
    })
    expect(exited).not.toHaveBeenCalled()
    expect(candidate).toHaveBeenCalledOnce()
    _dispatchTerminalSideEffectBatchForTest({
      ptyId: 'pty-1',
      seq: 2,
      facts: [{ kind: 'agent-exited', evidence: 'foreground-shell' }]
    })
    expect(exited).toHaveBeenCalledOnce()
  })
  it.each([null, '', 'node.exe', 'unknown-tool'])(
    'retains identity after ambiguous command completion %j',
    async (process) => {
      vi.useFakeTimers()
      const publish = vi.fn()
      const shell = vi.fn()
      const read = vi.fn().mockResolvedValue('claude')
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => 'pty-1',
        isTrackablePtyId: () => true,
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish,
        onConfirmedShellForeground: shell
      })
      tracker.onVisiblePtyBound(true)
      await vi.advanceTimersByTimeAsync(8000)
      publish.mockClear()
      read.mockResolvedValue(process)
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(publish).not.toHaveBeenCalled()
      expect(shell).not.toHaveBeenCalled()
      read.mockResolvedValue('zsh')
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenCalledOnce()
      tracker.dispose()
    }
  )
})
