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
      // The relay offers no shell proof; one that claimed a shell would refuse this signal.
      { connectionId: 'ssh-1', shellForegroundProven: true }
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
  it.each([
    ['claude', true, true],
    ['claude', false, false],
    ['zsh', true, true],
    ['-zsh', true, true],
    ['bash', true, true],
    // A bash-script agent: the pane's own shell is not the one in front.
    ['bash', false, false],
    // An unread foreground leaves it to the proof.
    [null, true, true],
    [null, false, false],
    // Windows names the shell for an agent it cannot recognize (an npm agent as `node.exe`); only
    // the shell alone in the pane's job proves one.
    ['powershell.exe', false, false],
    ['powershell.exe', true, true]
  ])('foreground %s, shell proof %s: %s', async (foregroundProcess, proven, shellInFront) => {
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess,
      shellForegroundProven: proven,
      launchAgent: 'claude',
      data: ''
    })

    await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
      shellInFront
    )
  })

  it('proves nothing on a controller without a shell proof', async () => {
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess: 'zsh',
      launchAgent: 'claude',
      data: ''
    })

    await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
      false
    )
  })

  // Measured on a zsh pane with the daemon's foreground tracker: for its first 5 s the cached read
  // names the launch agent while zsh is in front, so only the proof can tell.
  it.each([
    ['a shell in front', true],
    ['the agent in front', false]
  ])('cached as the launch agent, with %s: asks the proof', async (_moment, proven) => {
    const proof = vi.fn()
    const { runtime } = await createTranscriptPane({
      paneTitle: 'copilot',
      foregroundProcess: 'copilot',
      shellForegroundProven: proven,
      onShellForegroundProof: proof,
      launchAgent: 'copilot',
      data: ''
    })

    await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'copilot')).resolves.toBe(
      proven
    )
    expect(proof).toHaveBeenCalledOnce()
  })

  // The stub's proof always disagrees with the relay's name, so asking it would flip the answer.
  it.each([
    ['claude', false],
    ['bash', true]
  ])('SSH: takes the relay’s own read %s (shell %s), without a proof', async (relayRead, shell) => {
    const proof = vi.fn()
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess: relayRead,
      shellForegroundProven: !shell,
      onShellForegroundProof: proof,
      connectionId: 'ssh-1',
      launchAgent: 'claude',
      data: ''
    })

    await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
      shell
    )
    expect(proof).not.toHaveBeenCalled()
  })

  // Why no proof: it runs a process scan, and a native Claude names itself by its version, which
  // the cached read gives straight away.
  it.each(['2.1.285', 'node'])(
    'takes the non-shell name %s, other than the agent’s own, at once, without a proof',
    async (foregroundProcess) => {
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        shellForegroundProven: true,
        onShellForegroundProof: proof,
        launchAgent: 'claude',
        data: ''
      })

      await expect(runtime.isLaunchShellInFront(TRANSCRIPT_PANE_PTY_ID, 'claude')).resolves.toBe(
        false
      )
      expect(proof).not.toHaveBeenCalled()
    }
  )
})
