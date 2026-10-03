import { describe, expect, it } from 'vitest'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import { isOpenCodeRunCommand } from './opencode-headless-command'

const matches = (commandLine: string): boolean =>
  isOpenCodeRunCommand(tokenizeCommandLine(commandLine))

describe('isOpenCodeRunCommand', () => {
  it('matches the run subcommand, after global options too', () => {
    expect(matches('opencode run fix the bug')).toBe(true)
    expect(matches('/opt/homebrew/bin/opencode2 run --model x/y hi')).toBe(true)
    expect(matches('opencode --print-logs run hi')).toBe(true)
    expect(matches('opencode --log-level DEBUG run hi')).toBe(true)
    expect(matches('opencode --log-level=DEBUG run hi')).toBe(true)
  })

  it('does not match the TUI or any other subcommand', () => {
    expect(matches('opencode')).toBe(false)
    expect(matches('opencode .')).toBe(false)
    expect(matches('opencode2 --standalone')).toBe(false)
    expect(matches('opencode serve --port 4096')).toBe(false)
    expect(matches('opencode attach http://127.0.0.1:4096')).toBe(false)
    expect(matches('opencode mini')).toBe(false)
    expect(matches('opencode --log-level run')).toBe(false)
  })
})

describe('wrapped OpenCode run command position', () => {
  it.each([
    'CUSTOM_CONFIG=private opencode --log-level debug run --standalone',
    'env CUSTOM_CONFIG=private opencode run --standalone',
    'CUSTOM_CONFIG=private /usr/bin/env -- EXTRA_CONFIG=kept opencode run --standalone'
  ])('recognizes only the executable behind supported POSIX prefixes: %s', (command) => {
    expect(matches(command)).toBe(true)
  })

  it('recognizes a PowerShell call operator before a quoted executable', () => {
    const parsed = tokenizeStartupCommand(
      '& "C:\\Program Files\\opencode\\opencode.exe" run --standalone',
      'powershell'
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    expect(isOpenCodeRunCommand(parsed.tokens, 'powershell')).toBe(true)
    expect(isOpenCodeRunCommand(parsed.tokens, 'cmd')).toBe(false)
  })

  it('does not find executable names inside other commands or prompt arguments', () => {
    expect(matches('env CUSTOM_CONFIG=private echo opencode run')).toBe(false)
    expect(matches('env CUSTOM_CONFIG=private echo run')).toBe(false)
    expect(matches('CUSTOM_CONFIG=private opencode --prompt "opencode run"')).toBe(false)
    expect(matches('env -- opencode serve --title run')).toBe(false)
    expect(matches('opencode attach http://host/run')).toBe(false)
  })
})
