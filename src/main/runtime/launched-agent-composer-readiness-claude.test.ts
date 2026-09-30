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
import { waitForLaunchedAgentComposer } from './launched-agent-composer-readiness'

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

describe('whether a shell is proven in front of a launched agent’s terminal', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  describe('macOS and Linux: a fresh foreground read', () => {
    beforeEach(() => setPlatform('darwin'))

    it.each([
      // For its first 5 s the daemon's cached read names the launch agent while zsh is in front.
      ['claude', 'zsh', true],
      ['claude', 'claude', false],
      ['zsh', 'zsh', true],
      ['-zsh', '-zsh', true],
      ['bash', 'bash', true],
      [null, 'zsh', true],
      [null, null, false]
    ])('cached %s, scan %s: %s', async (foregroundProcess, scanned, shellInFront) => {
      const scan = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        confirmedForegroundProcess: scanned,
        onForegroundScan: scan,
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        shellInFront
      )
      expect(scan).toHaveBeenCalledOnce()
    })

    // The terminal daemon answers the shell-foreground check from its recovery state, which an
    // agent that exits without leaving a full-screen mode up never sets.
    it('an agent that exited: the scan names zsh while the daemon’s shell check says no', async () => {
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'copilot',
        foregroundProcess: 'copilot',
        confirmedForegroundProcess: 'zsh',
        shellForegroundProven: false,
        onShellForegroundProof: proof,
        launchAgent: 'copilot',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'copilot')).resolves.toBe(
        true
      )
      expect(proof).not.toHaveBeenCalled()
    })

    it('takes the cached read on a controller without a scan', async () => {
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: 'zsh',
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        true
      )
    })
  })

  describe('Windows: only the shell-foreground check', () => {
    beforeEach(() => setPlatform('win32'))

    // The scan names the pane's shell for an agent it cannot recognize (an npm agent as
    // `node.exe`); only the shell alone in the pane's job proves one.
    it.each([
      ['powershell.exe', false, false],
      ['powershell.exe', true, true],
      ['claude', true, true],
      ['claude', false, false]
    ])('cached %s, shell check %s: %s', async (foregroundProcess, proven, shellInFront) => {
      const scan = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        confirmedForegroundProcess: 'powershell.exe',
        onForegroundScan: scan,
        shellForegroundProven: proven,
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        shellInFront
      )
      expect(scan).not.toHaveBeenCalled()
    })

    it('proves nothing on a controller without a shell check', async () => {
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: 'powershell.exe',
        confirmedForegroundProcess: 'powershell.exe',
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        false
      )
    })
  })

  // The stubs always disagree with the relay's name, so asking either would flip the answer.
  it.each([
    ['claude', false],
    ['bash', true]
  ])(
    'SSH: takes the relay’s own read %s (shell %s), without a scan or check',
    async (relayRead, shell) => {
      const scan = vi.fn()
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: relayRead,
        confirmedForegroundProcess: shell ? 'claude' : 'zsh',
        onForegroundScan: scan,
        shellForegroundProven: !shell,
        onShellForegroundProof: proof,
        connectionId: 'ssh-1',
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        shell
      )
      expect(scan).not.toHaveBeenCalled()
      expect(proof).not.toHaveBeenCalled()
    }
  )

  // Why no read: a native Claude names itself by its version, which the cached read gives at once.
  it.each([
    ['darwin', '2.1.285'],
    ['darwin', 'node'],
    ['win32', 'node']
  ] as const)(
    '%s: takes the non-shell name %s, other than the agent’s own, at once',
    async (platform, foregroundProcess) => {
      setPlatform(platform)
      const scan = vi.fn()
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        confirmedForegroundProcess: 'zsh',
        onForegroundScan: scan,
        shellForegroundProven: true,
        onShellForegroundProof: proof,
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        false
      )
      expect(scan).not.toHaveBeenCalled()
      expect(proof).not.toHaveBeenCalled()
    }
  )
})
