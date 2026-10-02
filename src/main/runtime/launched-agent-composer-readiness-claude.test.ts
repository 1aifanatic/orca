/**
 * A freshly launched Claude's first input, replayed from captured transcripts
 * (`__fixtures__/claude-dialog-trust-workspace*.txt`).
 *
 * The launch pastes on the signal the desktop's own paste used: bracketed paste turned on, then a
 * quiet render. Claude's first-launch trust dialog renders in that same mode, so the quiet window
 * also settles over it, and only the screen check keeps the prompt out of the dialog.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import {
  waitForLaunchedAgentComposer,
  waitForWorkerStartComposer
} from './launched-agent-composer-readiness'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

/** The desktop paste's quiet window after bracketed paste, which the launch now shares. */
const QUIET_WINDOW_MS = 1_500

function readCapture(name: string): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', name)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

/** Starts the launch wait on an empty pane, then streams the capture in, as a live launch does. */
async function launchAndStream(
  name: string,
  timeoutMs: number,
  pane: Partial<Parameters<typeof createTranscriptPane>[0]> = {}
) {
  const { data, size } = readCapture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: '',
    ...pane
  })
  // Pane creation awaits real timers; the wait and its quiet window use the virtual clock.
  vi.useFakeTimers()
  const ready = waitForLaunchedAgentComposer(runtime, handle, 'claude', timeoutMs)
  const settled = vi.fn()
  ready.then(settled, settled)
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  return { ready, settled }
}

describe('launch readiness for a freshly launched Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('claude-dialog-trust-workspace-answered: reads the composer after the answered dialog as ready', async () => {
    const { data } = readCapture('claude-dialog-trust-workspace-answered')
    // Presence precondition: the capture turns bracketed paste on and ends on the idle composer.
    expect(data).toContain('\x1b[?2004h')
    const { ready, settled } = await launchAndStream(
      'claude-dialog-trust-workspace-answered',
      60_000
    )

    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS + 100)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({ satisfied: true })
  })

  it('claude-dialog-trust-workspace-answered: over SSH, settles on the quiet window, not the 8 s fallback', async () => {
    const { ready, settled } = await launchAndStream(
      'claude-dialog-trust-workspace-answered',
      60_000,
      // The relay offers no scan or shell check; either claiming a shell would refuse this signal.
      { connectionId: 'ssh-1', confirmedForegroundProcess: 'zsh', shellForegroundProven: true }
    )

    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS + 300)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({ satisfied: true })
  })

  it('claude-dialog-trust-workspace: never reads the trust dialog as the composer', async () => {
    const { ready, settled } = await launchAndStream('claude-dialog-trust-workspace', 60_000)

    // Reported inside the desktop paste's budget: the quiet window settles over the dialog, the
    // screen check refuses it, and the idle wait names it.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })
})

describe('a fresh orchestration worker start for Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Main's worker start pasted on this cue; the launch's quiet window put the brief 1.6 s later.
  it('settles on Claude’s ready title, before the launch paste’s quiet window', async () => {
    const { data, size } = readCapture('claude-dialog-trust-workspace-answered')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess: 'claude',
      launchAgent: 'claude',
      size,
      data: ''
    })
    vi.useFakeTimers()
    const ready = waitForWorkerStartComposer(runtime, handle, 'claude', 60_000)
    const settled = vi.fn()
    ready.then(settled, settled)
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())

    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS / 2)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({ satisfied: true })
  })
})

describe('what holds a launched agent’s terminal', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  describe('macOS and Linux: one fresh foreground read decides', () => {
    beforeEach(() => setPlatform('darwin'))

    it.each([
      // For its first 5 s the daemon's cached read names the launch agent while zsh is in front.
      ['claude', 'zsh', 'shell'],
      // A stub agent that crashed: the cached read can still name it after zsh took the terminal.
      ['python3', 'zsh', 'shell'],
      ['claude', 'claude', 'agent'],
      // A native Claude names itself by its version.
      ['zsh', '2.1.285', 'agent'],
      ['zsh', 'node', 'agent'],
      ['-zsh', '-zsh', 'shell'],
      ['bash', 'bash', 'shell'],
      [null, 'zsh', 'shell'],
      ['claude', null, 'unknown']
    ] as const)('cached %s, scan %s: %s', async (foregroundProcess, scanned, found) => {
      const scan = vi.fn()
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        confirmedForegroundProcess: scanned,
        onForegroundScan: scan,
        shellForegroundProven: false,
        onShellForegroundProof: proof,
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe(found)
      expect(scan).toHaveBeenCalledOnce()
      expect(proof).not.toHaveBeenCalled()
    })

    it('proves nothing on a controller without a fresh scan', async () => {
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: 'claude',
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe('unknown')
    })

    // Captured with `ps -o pid=,ppid=,pgid=,tpgid=,stat=,command=` on a pane spawned the way a macOS
    // pane is, under `login`: zsh holds the terminal in its own group, never the root's.
    it('reads a login-wrapped pane’s zsh at its prompt as the shell', async () => {
      const rows: ProcessTableRow[] = [
        {
          pid: 60404,
          ppid: 60394,
          pgid: 60404,
          tpgid: 60406,
          stat: 'Ss',
          tty: 'ttys004',
          startTime: 'Fri Oct  2 01:20:11 2026',
          command: '/usr/bin/login -flpq user /bin/bash --noprofile --norc -p -c'
        },
        {
          pid: 60406,
          ppid: 60404,
          pgid: 60406,
          tpgid: 60406,
          stat: 'S+',
          tty: 'ttys004',
          startTime: 'Fri Oct  2 01:20:11 2026',
          command: '-/bin/zsh -f'
        }
      ]
      const inspection = {
        foregroundProcess: 'zsh',
        hasChildProcesses: true,
        foregroundProcessEvidence: resolveRemoteForegroundEvidence(
          { rootPid: 60404, fallbackProcess: 'zsh' },
          {
            ptyId: TRANSCRIPT_PANE_PTY_ID,
            ptyIncarnationId: 'inc-1',
            authorityGeneration: 'gen-1',
            observationEpoch: 1,
            capturedAgeMs: 0,
            platform: 'darwin'
          },
          rows
        )
      }
      // Presence precondition: the fence is live, and its foreground group is not the root's.
      expect(inspection.foregroundProcessEvidence).toMatchObject({
        verdict: 'live',
        fence: { shellPid: 60404, foregroundPgid: 60406 }
      })
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'python3',
        processInspection: inspection,
        confirmedForegroundProcess: '-zsh',
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe('shell')
    })

    // A wrapper that does not `exec` an agent the scan cannot recognize keeps its own name in front,
    // which reads as a shell: the prompt stays undelivered rather than risk the user's shell.
    it('reads a bash wrapper still in front of an unrecognized agent as a shell', async () => {
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'bash',
        confirmedForegroundProcess: 'bash',
        launchAgent: 'copilot',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'copilot')
      ).resolves.toBe('shell')
    })
  })

  // The scan names the pane's shell for an agent it cannot recognize (an npm agent as `node.exe`),
  // and Git Bash and WSL keep other processes in the shell's job, so nothing proves the agent.
  describe('Windows: only the shell-foreground check, and never the agent', () => {
    beforeEach(() => setPlatform('win32'))

    it.each([
      ['powershell.exe', false, 'unknown'],
      ['powershell.exe', true, 'shell'],
      ['claude', true, 'shell'],
      ['claude', false, 'unknown'],
      ['node', false, 'unknown']
    ] as const)('cached %s, shell check %s: %s', async (foregroundProcess, proven, found) => {
      const scan = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        confirmedForegroundProcess: 'claude',
        onForegroundScan: scan,
        shellForegroundProven: proven,
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe(found)
      expect(scan).not.toHaveBeenCalled()
    })
  })

  // The stubs always disagree with the relay's name, so asking either would flip the answer.
  it.each([
    ['claude', 'agent'],
    ['bash', 'shell']
  ] as const)(
    'SSH: takes the relay’s own read %s (%s), without a scan or check',
    async (relayRead, found) => {
      setPlatform('darwin')
      const scan = vi.fn()
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: relayRead,
        confirmedForegroundProcess: found === 'shell' ? 'claude' : 'zsh',
        onForegroundScan: scan,
        shellForegroundProven: found !== 'shell',
        onShellForegroundProof: proof,
        connectionId: 'ssh-1',
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe(found)
      expect(scan).not.toHaveBeenCalled()
      expect(proof).not.toHaveBeenCalled()
    }
  )

  // Why: a Windows relay names the pane's shell for an agent its scan cannot recognize (node.exe).
  it('SSH to a Windows host: never the agent', async () => {
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Copilot',
      foregroundProcess: 'node',
      connectionId: 'ssh-1',
      remoteWindowsHost: true,
      launchAgent: 'copilot',
      data: ''
    })

    await expect(
      runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'copilot')
    ).resolves.toBe('unknown')
  })
})
