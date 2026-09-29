import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyOutputTitleObserver } from './pty-output-title-observer'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { RemoteForegroundEvidence } from '../../../../shared/foreground-process-evidence'
import type { TerminalProcessInspection } from '../../../../shared/terminal-process-inspection'
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
  it('accepts an old host exit fact as that host decided it', () => {
    const exited = vi.fn()
    registerTerminalSideEffectFactConsumer({ ptyId: 'pty-1', callbacks: { onAgentExited: exited } })
    _dispatchTerminalSideEffectBatchForTest({
      ptyId: 'pty-1',
      seq: 1,
      facts: [{ kind: 'agent-exited' }]
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

  describe('startup and remote hosts', () => {
    const SSH_PTY_ID = 'ssh:conn-1@@pty-1'
    let epoch = 0

    function remoteTracker(
      evidence: (rows: 'shell' | 'agent') => RemoteForegroundEvidence | undefined
    ) {
      let foreground: 'shell' | 'agent' = 'agent'
      const read = vi.fn(async (): Promise<TerminalProcessInspection> => ({
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: evidence(foreground)
      }))
      const shell = vi.fn()
      const publish = vi.fn()
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => SSH_PTY_ID,
        isTrackablePtyId: () => true,
        isRemotePtyId: () => true,
        getExpectedIncarnationId: () => 'inc-1',
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish,
        hasKnownAgentIdentity: () => true,
        onConfirmedShellForeground: shell
      })
      return {
        tracker,
        read,
        shell,
        publish,
        exitAgent: () => {
          foreground = 'shell'
        }
      }
    }

    /** The shapes `resolveRemoteForegroundEvidence` emits (its own tests pin them). */
    function posixEvidence(
      foreground: 'shell' | 'agent',
      host: 'posix' | 'windows' = 'posix'
    ): RemoteForegroundEvidence {
      epoch += 1
      const observation = {
        ptyId: 'pty-1',
        ptyIncarnationId: 'inc-1',
        authorityGeneration: 'host-1',
        observationEpoch: epoch,
        capturedAgeMs: 0
      }
      if (host === 'windows') {
        return {
          ...observation,
          verdict: 'unverifiable',
          reason: 'windows_ssh_foreground_unavailable'
        }
      }
      return {
        ...observation,
        verdict: 'live',
        processName: foreground === 'agent' ? 'claude' : null,
        shellForeground: foreground === 'shell',
        fence: {
          platform: 'posix',
          shellPid: 10,
          shellStartTime: '100',
          tty: '/dev/pts/1',
          foregroundPgid: foreground === 'shell' ? 10 : 11,
          ...(foreground === 'agent' ? { process: { pid: 11, startTime: '101' } } : {})
        }
      }
    }

    it('retires a launch expectation on a boot-time shell sample without calling it an exit', async () => {
      vi.useFakeTimers()
      const shell = vi.fn()
      const read = vi.fn().mockResolvedValue('zsh')
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => 'pty-1',
        isTrackablePtyId: () => true,
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish: vi.fn(),
        onConfirmedShellForeground: shell
      })
      tracker.onVisiblePtyBound(true)
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenCalledExactlyOnceWith('visible-pty', 'none')
      tracker.dispose()
    })

    it('calls a shell after an observed agent title an exit', async () => {
      vi.useFakeTimers()
      const shell = vi.fn()
      const read = vi.fn().mockResolvedValue('zsh')
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => 'pty-1',
        isTrackablePtyId: () => true,
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish: vi.fn(),
        onConfirmedShellForeground: shell
      })
      tracker.onAgentExitCandidate()
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenCalledExactlyOnceWith('visible-pty', 'marked')
      tracker.dispose()
    })

    it('confirms an SSH exit from host shell evidence at the first read after 133;D', async () => {
      vi.useFakeTimers()
      const h = remoteTracker((foreground) => posixEvidence(foreground))
      h.tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(400)
      expect(h.shell).not.toHaveBeenCalled()
      h.exitAgent()
      h.tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(400)
      expect(h.shell).toHaveBeenCalledExactlyOnceWith('command-finished', 'read-confirmed')
      expect(h.read).toHaveBeenCalledTimes(2)
      h.tracker.dispose()
    })

    it.each([
      [
        'an old host without the shell field',
        (foreground: 'shell' | 'agent') => {
          const evidence = posixEvidence(foreground)
          if (evidence.verdict !== 'live') {
            return evidence
          }
          const { shellForeground: _omitted, ...legacy } = evidence
          return legacy
        }
      ],
      ['an SSH-to-Windows host', () => posixEvidence('shell', 'windows')]
    ])('retires the agent at the 133;D on %s', async (_label, evidence) => {
      vi.useFakeTimers()
      const h = remoteTracker(evidence)
      h.tracker.onCommandStarted(null, { shellMarked: true })
      h.exitAgent()
      h.tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(400)
      expect(h.shell).toHaveBeenCalledExactlyOnceWith('command-finished', 'marked')
      expect(h.read).toHaveBeenCalledOnce()
      h.tracker.dispose()
    })

    it('retires the agent on its own neutral title where a Windows host marks no commands', async () => {
      vi.useFakeTimers()
      const h = remoteTracker(() => posixEvidence('shell', 'windows'))
      h.tracker.onAgentExitCandidate()
      await vi.advanceTimersByTimeAsync(400)
      expect(h.shell).toHaveBeenCalledExactlyOnceWith('visible-pty', 'marked')
      expect(h.read).toHaveBeenCalledOnce()
      h.tracker.dispose()
    })

    it.each([
      ['a visible-pane sample on a Windows host', () => posixEvidence('shell', 'windows'), false],
      ['a neutral title with the agent still in front', () => posixEvidence('agent'), true],
      ['a neutral title the host could not answer', () => posixEvidence('shell', 'windows'), true]
    ])('keeps the agent on %s', async (label, evidence, titleCandidate) => {
      vi.useFakeTimers()
      const h = remoteTracker(evidence)
      if (label.includes('could not answer')) {
        h.read.mockRejectedValue(new Error('transport lost'))
      }
      if (titleCandidate) {
        h.tracker.onAgentExitCandidate()
      } else {
        h.tracker.onVisiblePtyBound(true)
      }
      await vi.advanceTimersByTimeAsync(8000)
      expect(h.shell).not.toHaveBeenCalled()
      h.tracker.dispose()
    })

    it.each([
      ['a local shell', () => ({ pty: 'pty-1', read: vi.fn().mockResolvedValue('zsh') })],
      [
        'a host that cannot read the foreground',
        () => {
          const h = remoteTracker(() => posixEvidence('shell', 'windows'))
          h.tracker.dispose()
          return { pty: SSH_PTY_ID, read: h.read }
        }
      ]
    ])('does not call a 133;D before any command started an exit on %s', async (_label, make) => {
      vi.useFakeTimers()
      const { pty, read } = make()
      const shell = vi.fn()
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => pty,
        isTrackablePtyId: () => true,
        isRemotePtyId: (id) => id === SSH_PTY_ID,
        getExpectedIncarnationId: () => 'inc-1',
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish: vi.fn(),
        hasKnownAgentIdentity: () => true,
        onConfirmedShellForeground: shell
      })
      // A user shell integration's first-prompt D, before the launched agent's command starts.
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenCalledExactlyOnceWith('command-finished', 'none')
      tracker.onCommandStarted(null, { shellMarked: true })
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenLastCalledWith('command-finished', 'marked')
      tracker.dispose()
    })

    it('calls a shell read-confirmed only after a read saw the agent in this PTY', async () => {
      vi.useFakeTimers()
      let ptyId = 'pty-1'
      const shell = vi.fn()
      const read = vi.fn().mockResolvedValue('claude')
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => ptyId,
        isTrackablePtyId: () => true,
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish: vi.fn(),
        hasKnownAgentIdentity: () => true,
        onConfirmedShellForeground: shell
      })
      tracker.onVisiblePtyBound(true)
      await vi.advanceTimersByTimeAsync(400)
      read.mockResolvedValue('zsh')
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(400)
      expect(shell).toHaveBeenCalledExactlyOnceWith('command-finished', 'read-confirmed')

      // A replacement PTY in the same pane never inherits the earlier sighting.
      read.mockResolvedValue('claude')
      tracker.onVisiblePtyBound(true)
      await vi.advanceTimersByTimeAsync(400)
      ptyId = 'pty-2'
      read.mockResolvedValue('zsh')
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenCalledTimes(2)
      // Nor does the earlier PTY's evidence make the new PTY's first-prompt D a marked exit.
      expect(shell.mock.calls.at(-1)?.[1]).toBe('none')
      tracker.dispose()
    })

    it('does not count a command the previous PTY started as closed by the next PTY', async () => {
      vi.useFakeTimers()
      let ptyId = 'pty-1'
      const shell = vi.fn()
      const read = vi.fn().mockResolvedValue('zsh')
      const tracker = createPaneForegroundAgentTracker({
        getPtyId: () => ptyId,
        isTrackablePtyId: () => true,
        readForegroundProcess: read,
        confirmForegroundProcess: read,
        publish: vi.fn(),
        hasKnownAgentIdentity: () => true,
        onConfirmedShellForeground: shell
      })
      // The agent's command started in pty-1, which then died with no 133;D.
      tracker.onCommandStarted(null, { shellMarked: true })
      ptyId = 'pty-2'
      // The replacement shell's first-prompt D, before the relaunched agent starts.
      tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(shell).toHaveBeenCalledExactlyOnceWith('command-finished', 'none')
      tracker.dispose()
    })

    it('keeps the agent when the host could not be read at the 133;D', async () => {
      vi.useFakeTimers()
      const h = remoteTracker(() => undefined)
      h.read.mockRejectedValue(new Error('transport lost'))
      h.tracker.onCommandFinished()
      await vi.advanceTimersByTimeAsync(8000)
      expect(h.shell).not.toHaveBeenCalled()
      h.tracker.dispose()
    })
  })
})
