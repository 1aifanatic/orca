import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

function setup(remote = false) {
  const pty: Pick<
    RuntimePtyWorktreeRecord,
    'connectionId' | 'incarnationId' | 'connected' | 'launchAgent' | 'foregroundAgent'
  > = {
    connectionId: remote ? 'ssh-host' : null,
    incarnationId: 'generation-1',
    connected: true,
    launchAgent: null,
    foregroundAgent: 'claude'
  }
  const confirm = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
  let controller: RuntimePtyController = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'zsh',
    confirmForegroundProcess: confirm
  }
  const touched = vi.fn()
  const agent = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot: touched,
    finishDelayedSnapshot: vi.fn()
  })
  return {
    pty,
    agent,
    confirm,
    touched,
    replace: (next: RuntimePtyController) => {
      controller = next
    }
  }
}

describe('foreground identity on unknown observations', () => {
  it.each([null, '', 'node.exe', 'other-tool'])(
    'keeps the published Claude identity on %j',
    async (process) => {
      const h = setup()
      h.confirm.mockResolvedValue(process)
      await h.agent.refresh('pty-1')
      expect(h.pty.foregroundAgent).toBe('claude')
      expect(h.touched).not.toHaveBeenCalled()
      h.confirm.mockResolvedValue('zsh')
      await h.agent.refresh('pty-1')
      expect(h.pty.foregroundAgent).toBeNull()
      expect(h.touched).toHaveBeenCalledOnce()
    }
  )
  it('rejects a result for a replaced terminal incarnation', async () => {
    const h = setup()
    let answer: (value: string) => void = () => {}
    h.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const pending = h.agent.refresh('pty-1')
    h.pty.incarnationId = 'generation-2'
    answer('zsh')
    await pending
    expect(h.pty.foregroundAgent).toBe('claude')
  })
  it.each(['missing', 'unverifiable', 'wrong-incarnation', 'stale', 'live'] as const)(
    'admits only fresh matching SSH evidence: %s',
    async (kind) => {
      const h = setup(true)
      h.replace({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        inspectProcess: async () => ({
          foregroundProcess: 'zsh',
          hasChildProcesses: false,
          ...(kind === 'missing'
            ? {}
            : {
                foregroundProcessEvidence:
                  kind === 'unverifiable'
                    ? {
                        verdict: 'unverifiable' as const,
                        reason: 'inspection_failed',
                        authorityGeneration: 'host-1',
                        observationEpoch: 1,
                        capturedAgeMs: 0,
                        ptyId: 'pty-1',
                        ptyIncarnationId: 'generation-1'
                      }
                    : {
                        verdict: 'live' as const,
                        processName: 'zsh',
                        fence: {
                          platform: 'posix' as const,
                          shellPid: 10,
                          shellStartTime: '100',
                          tty: '/dev/pts/1',
                          foregroundPgid: 10
                        },
                        authorityGeneration: 'host-1',
                        observationEpoch: 1,
                        capturedAgeMs: kind === 'stale' ? 10000 : 0,
                        ptyId: 'pty-1',
                        ptyIncarnationId: kind === 'wrong-incarnation' ? 'old' : 'generation-1'
                      }
              })
        })
      })
      await h.agent.refresh('pty-1')
      expect(h.pty.foregroundAgent).toBe(kind === 'live' ? null : 'claude')
    }
  )
})
