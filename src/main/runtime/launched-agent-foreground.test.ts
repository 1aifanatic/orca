import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import { readLaunchedAgentForeground } from './launched-agent-foreground'

/** A live observation naming `claude` in the terminal's foreground group. */
function claudeInGroup(capturedAgeMs: number): RemoteForegroundEvidence {
  return {
    verdict: 'live',
    processName: 'claude',
    fence: {
      platform: 'posix',
      shellPid: 40100,
      shellStartTime: 'Fri Oct  2 09:30:01 2026',
      tty: 'ttys007',
      foregroundPgid: 40210
    },
    authorityGeneration: 'gen-1',
    observationEpoch: 1,
    capturedAgeMs,
    ptyId: 'pty-1',
    ptyIncarnationId: 'inc-1'
  }
}

/** The fresh scan names the `sh` that leads the group, as it does behind a wrapper. */
function controllerAnswering(inspect: () => Promise<RemoteForegroundEvidence>) {
  return {
    getForegroundProcess: async () => 'sh',
    confirmForegroundProcess: async () => 'sh',
    confirmShellForeground: async () => false,
    inspectProcess: async () => ({
      foregroundProcess: 'sh',
      hasChildProcesses: true,
      foregroundProcessEvidence: await inspect()
    })
  }
}

const POSIX_LOCAL = { remote: false, windows: false }

describe('the foreground group as proof of a launched agent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // On a loaded host the whole-machine capture can take seconds; it still describes the moment
  // after the read was asked for.
  it('counts a capture begun after the read was asked for, however long `ps` took', async () => {
    const controller = controllerAnswering(async () => {
      vi.advanceTimersByTime(1_800)
      return claudeInGroup(1_800)
    })

    await expect(
      readLaunchedAgentForeground(controller, POSIX_LOCAL, 'pty-1', 'claude')
    ).resolves.toBe('agent')
  })

  it('takes the fresh read over a capture reused from before the read was asked for', async () => {
    const controller = controllerAnswering(async () => claudeInGroup(1_500))

    await expect(
      readLaunchedAgentForeground(controller, POSIX_LOCAL, 'pty-1', 'claude')
    ).resolves.toBe('shell')
  })
})
