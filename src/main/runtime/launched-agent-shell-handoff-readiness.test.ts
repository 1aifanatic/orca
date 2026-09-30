/**
 * A launched agent's ready signal must come from the agent, not from the shell that ran it.
 *
 * Replayed from captures: zsh turns bracketed paste on at its prompt and off when it runs the
 * typed command, then on again at its next prompt (`zsh-prompt-runs-command.txt`); Claude turns it
 * on when it draws (`claude-dialog-trust-workspace-answered.txt`). Read as the agent's, the shell's
 * prompt settled the quiet window before Claude had drawn anything, and after an agent that exited.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

const QUIET_WINDOW_MS = 1_500

function readFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

/** The shell's prompt and the launch line it runs, up to where it hands the terminal over. */
function shellRunsLaunchLine(): string {
  const zsh = readFixture('zsh-prompt-runs-command')
  const handoff = zsh.indexOf('\x1b[?2004l')
  return zsh.slice(0, zsh.indexOf('\n', handoff) + 1)
}

/** The prompt the shell draws again once the command it ran has exited. */
function shellPromptAfterCommandExits(): string {
  const zsh = readFixture('zsh-prompt-runs-command')
  return zsh.slice(zsh.indexOf('\n', zsh.indexOf('\x1b[?2004l')) + 1)
}

function launchedPane() {
  let listener = (_data: string): void => {}
  let foreground = 'zsh'
  const host = {
    getPtyId: () => 'pty-1',
    getForegroundProcess: async () => foreground,
    subscribeToData: (_ptyId: string, onData: (data: string) => void) => {
      listener = onData
      return () => {
        listener = () => {}
      }
    },
    readRecentOutput: () => undefined,
    write: vi.fn()
  }
  const ready = waitForWorktreeStartupDraft(host, 'term-1', 'claude', {
    timeoutMs: 30_000,
    agentOwnsTerminal: async () => foreground !== 'zsh'
  })
  const settled = vi.fn()
  void ready.then(settled)
  return {
    settled,
    emit: (data: string) => listener(data),
    setForeground: (name: string) => {
      foreground = name
    }
  }
}

describe('a launched agent’s ready signal, after the shell that ran it', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for the agent’s own bracketed paste when the agent starts well after the shell’s prompt', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()
    const launchLine = shellRunsLaunchLine()
    // Presence precondition: the shell enabled bracketed paste before it handed the terminal over.
    expect(launchLine).toContain('\x1b[?2004h')

    pane.emit(launchLine)
    // The agent's process takes the terminal, then draws nothing for 3 s while it starts.
    pane.setForeground('claude')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(pane.settled).not.toHaveBeenCalled()

    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS - 100)
    expect(pane.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })

  it('never reads the shell’s next prompt as the agent’s composer after the agent exits', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.emit(shellRunsLaunchLine())
    // The agent exits at startup: its shell is back in the foreground and draws its prompt.
    pane.emit('claude: failed to start\r\n')
    pane.emit(shellPromptAfterCommandExits())
    await vi.advanceTimersByTimeAsync(30_000)

    expect(pane.settled).toHaveBeenCalledWith(null)
  })
})
