import { afterEach, describe, expect, it, vi } from 'vitest'
import { A, PTY, WT, flush, makeAgentExitHost } from './agent-exit-host.test-fixture'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

const CLAUDE = { pid: 4242, platform: 'darwin' as const, startTime: 'utc:claude-start' }

afterEach(() => {
  vi.useRealTimers()
})

function unverifiable(ptyId: string): TerminalProcessInspection {
  return {
    foregroundProcess: 'tmux',
    hasChildProcesses: true,
    foregroundProcessEvidence: {
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId,
      ptyIncarnationId: `inc-${ptyId}`,
      verdict: 'unverifiable',
      reason: 'multiplexer_boundary'
    }
  }
}

describe('a later agent run in the same shell (R2-4)', () => {
  it('finds and proves a second Codex the hooks never announced, and records each end', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
    host.alive.add(1001)
    await host.published()
    host.owner(A, { agent: 'codex' })
    await flush()
    host.alive.delete(1001)
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
    expect(host.recordProvenEnd).toHaveBeenCalledWith(expect.stringContaining(A), 'codex')

    // Codex B starts in the same shell (Codex hooks carry no PID, so no new owner signal).
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 2002, startTime: 'b' })
    host.alive.add(2002)
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    await vi.waitFor(() =>
      expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(2002)
    )

    host.alive.delete(2002)
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
    await expect(host.chatSend(A, 'after-b-exit')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0
    })
  })
})

describe('identity discovery is bounded and scoped (R2-8, R2-11)', () => {
  it('looks again on recognized agent activity after a settled round, a few times only', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    await vi.advanceTimersByTimeAsync(10_000)
    const settled = host.inspectProcess.mock.calls.length
    expect(settled).toBe(3)
    // The agent execs late (slow rc, npx); its title then shows it working.
    host.foreground.set(PTY[A]!, { name: 'claude', pid: 3003, startTime: 'c' })
    host.alive.add(3003)
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(3003)

    // An agent that can never be identified: activity buys three single looks, then nothing.
    const other = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await other.published()
    await vi.advanceTimersByTimeAsync(10_000)
    for (let index = 0; index < 50; index += 1) {
      other.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(other.inspectProcess.mock.calls.length).toBe(6)
  })

  it('spends no capture on a hook start in a pane no client shows as chat', async () => {
    const host = makeAgentExitHost({ viewMode: 'terminal', leaves: 1 })
    await host.published()
    host.inspectProcess.mockClear()
    host.owner(A, { agent: 'codex' })
    await flush()
    expect(host.inspectProcess).not.toHaveBeenCalled()
    // Once a client switches it to chat, its agent is looked for.
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    await flush()
    expect(host.inspectProcess).toHaveBeenCalled()
  })
})

describe('an end that stays unverifiable backs off and stops (R2-6, R2-7)', () => {
  it('costs at most three captures however many publishes and nudges follow', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    await vi.advanceTimersByTimeAsync(20_000)
    host.inspectProcess.mockClear()
    for (let index = 0; index < 200; index += 1) {
      host.runtime.touchMobileSessionTabsForWorktree(WT)
      host.runtime['confirmPtyAgentExit'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(3)
    expect(host.hostPair().viewMode).toBe('chat')
  })

  it('asks an SSH relay at most three times for an end it cannot verify', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, connectionId: 'ssh-win' })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.inspectProcess.mockImplementation(async (ptyId: string) => unverifiable(ptyId))
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    for (let index = 0; index < 200; index += 1) {
      host.runtime['nudgeAgentExitCheck'](PTY[A]!)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('still confirms promptly when the ended agent was merely still in front', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.foreground.set(PTY[A]!, { name: 'claude', pid: CLAUDE.pid, startTime: 'raw' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
  })
})
