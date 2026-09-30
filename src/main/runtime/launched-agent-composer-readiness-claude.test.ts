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
import { afterEach, describe, expect, it, vi } from 'vitest'
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
async function launchAndStream(name: string, timeoutMs: number) {
  const { data, size } = readCapture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: ''
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

describe('who is in front of a launched agent’s terminal', () => {
  it.each([
    ['claude', 'agent'],
    // macOS reports the native Claude by its version.
    ['2.1.285', 'agent'],
    ['node', 'agent'],
    ['zsh', 'shell'],
    ['-zsh', 'shell'],
    ['bash', 'shell'],
    [null, 'unknown']
  ])('foreground %s: %s', async (foregroundProcess, foreground) => {
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess,
      launchAgent: 'claude',
      data: ''
    })

    await expect(
      runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
    ).resolves.toBe(foreground)
  })

  // Measured on a zsh pane with the daemon's foreground tracker: for its first 5 s the cached read
  // names the launch agent while zsh is in front, before the launch line runs and after an agent
  // that exited; a fresh process-table scan answers `zsh`, and names a script agent by its command.
  it.each([
    ['before the launch line runs', 'copilot', 'zsh', 'shell'],
    ['after the agent exited', 'copilot', 'zsh', 'shell'],
    ['while a script agent runs', 'bash', 'copilot', 'agent'],
    ['while the scan cannot answer', 'copilot', null, 'unknown']
  ])('%s: cached %s, scanned %s, reads %s', async (_moment, cached, scanned, foreground) => {
    const { runtime } = await createTranscriptPane({
      paneTitle: 'copilot',
      foregroundProcess: cached,
      confirmedForegroundProcess: scanned,
      launchAgent: 'copilot',
      data: ''
    })

    await expect(
      runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'copilot')
    ).resolves.toBe(foreground)
  })

  // Why no scan: the scan is the slow read, and a native Claude names itself by its version, which
  // the cached read gives straight away.
  it('takes a non-shell name other than the agent’s own at once, without a process scan', async () => {
    const scan = vi.fn()
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess: '2.1.285',
      confirmedForegroundProcess: 'zsh',
      onForegroundScan: scan,
      launchAgent: 'claude',
      data: ''
    })

    await expect(
      runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
    ).resolves.toBe('agent')
    expect(scan).not.toHaveBeenCalled()
  })
})
