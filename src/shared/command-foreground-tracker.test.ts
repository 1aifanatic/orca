import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandForegroundTracker } from './command-foreground-tracker'
import { FOREGROUND_COMMAND_READS } from './foreground-command-settle'

let foreground: string | null = 'zsh'
let available = true
const tracker = () =>
  new CommandForegroundTracker({
    read: async () => ({ available, process: foreground }),
    now: () => Date.now()
  })

beforeEach(() => {
  vi.useFakeTimers()
  foreground = 'zsh'
  available = true
})
afterEach(() => vi.useRealTimers())

describe('CommandForegroundTracker', () => {
  it('names the agent its command ran, read after the command starts', async () => {
    const commands = tracker()
    commands.started('pty')
    foreground = 'codex'
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    foreground = 'zsh'
    await expect(commands.finished('pty')).resolves.toMatchObject({
      foreground: { kind: 'agent', agent: 'codex' }
    })
  })

  it("names the real foreground on a guest's event, whatever order agents report in (e2e i)", async () => {
    const commands = tracker()
    commands.started('pty')
    foreground = 'claude'
    // A detached Codex reports first: the read still sees Claude in the foreground.
    commands.observeActivity('pty')
    await vi.advanceTimersByTimeAsync(0)
    foreground = 'zsh'
    await expect(commands.finished('pty')).resolves.toMatchObject({
      foreground: { kind: 'agent', agent: 'claude' }
    })
  })

  it('lets an agent that becomes foreground later win over a program before it', async () => {
    const commands = tracker()
    commands.started('pty')
    foreground = 'sleep'
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    foreground = 'codex'
    commands.observeActivity('pty')
    await vi.advanceTimersByTimeAsync(0)
    foreground = 'zsh'
    await expect(commands.finished('pty')).resolves.toMatchObject({
      foreground: { kind: 'agent', agent: 'codex' }
    })
  })

  it('reports a program, or nothing when no read named the command', async () => {
    const commands = tracker()
    commands.started('a')
    foreground = 'ls'
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    foreground = 'zsh'
    await expect(commands.finished('a')).resolves.toMatchObject({ foreground: { kind: 'program' } })
    available = false
    commands.started('b')
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    await expect(commands.finished('b')).resolves.toMatchObject({ foreground: { kind: 'unknown' } })
    await expect(commands.finished('never-started')).resolves.toMatchObject({ startedAt: null })
  })

  it('reports nothing while the agent still holds the foreground (a leaked command end)', async () => {
    const commands = tracker()
    commands.started('pty')
    foreground = 'codex'
    await expect(commands.finished('pty')).resolves.toBeNull()
  })
})
