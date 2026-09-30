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
import {
  waitForWorktreeStartupDraft,
  type LaunchedAgentForeground
} from './runtime-worktree-startup-readiness'

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

type Foreground = LaunchedAgentForeground

function launchedPane(options: { readForeground?: (name: string) => Foreground } = {}) {
  let listener = (_data: string): void => {}
  let foreground = 'zsh'
  const reads: Foreground[] = []
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
  const readForeground =
    options.readForeground ?? ((name: string): Foreground => (name === 'zsh' ? 'shell' : 'agent'))
  const ready = waitForWorktreeStartupDraft(host, 'term-1', 'claude', {
    timeoutMs: 30_000,
    readAgentForeground: async () => {
      const read = readForeground(foreground)
      reads.push(read)
      return read
    }
  })
  const settled = vi.fn()
  void ready.then(settled)
  return {
    settled,
    reads,
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

  // Why: a quiet agent never signals again, so a fired signal must outlive a foreground read that
  // could not answer yet. Dropping it left Claude idle until the 8 s fallback.
  it('keeps a fired signal until the agent is seen in front, rather than dropping it', async () => {
    vi.useFakeTimers()
    let unanswered = 2
    const pane = launchedPane({
      readForeground: (name) => (name === 'zsh' ? 'shell' : unanswered-- > 0 ? 'unknown' : 'agent')
    })

    pane.emit(shellRunsLaunchLine())
    pane.setForeground('2.1.285')
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS + 2 * 250 + 50)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })

  it('settles a Claude that is in front the moment its signal fires, with one foreground read', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.emit(shellRunsLaunchLine())
    pane.setForeground('2.1.285')
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
    // The shell handed over in the stream, so nothing was read before the signal.
    expect(pane.reads).toEqual(['agent'])
  })

  it('asks who is in front when the shell never enables bracketed paste to hand over', async () => {
    vi.useFakeTimers()
    const pane = launchedPane()

    pane.emit('$ claude\r\n')
    pane.setForeground('2.1.285')
    await vi.advanceTimersByTimeAsync(300)
    pane.emit(readFixture('claude-dialog-trust-workspace-answered'))
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)

    expect(pane.settled).toHaveBeenCalledWith('pty-1')
  })
})
