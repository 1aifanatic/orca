import { describe, expect, it } from 'vitest'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { isRetiredCodexHookCommand } from './codex-hook-retired-commands'

describe('isRetiredCodexHookCommand', () => {
  it.each([
    ['the #1019 double-quoted form', '/bin/sh "/u/Library/orca/agent-hooks/codex-hook.sh"'],
    [
      'the #1536 exec-guarded form',
      "if [ -x '/u/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/u/.orca/agent-hooks/codex-hook.sh'; fi"
    ],
    [
      'an exec-guarded form with a quoted apostrophe',
      "if [ -x '/u/o'\\''k/agent-hooks/codex-hook.sh' ]; then /bin/sh '/u/o'\\''k/agent-hooks/codex-hook.sh'; fi"
    ],
    [
      'a per-userData Windows path',
      'C:\\Users\\u\\AppData\\Roaming\\orca\\agent-hooks\\codex-hook.cmd'
    ]
  ])('matches %s', (_case, command) => {
    expect(isRetiredCodexHookCommand(command)).toBe(true)
  })

  // Why: every build and instance still writes these, so sweeping them strips a live entry.
  it.each([
    ["this build's command", getManagedCommand(getManagedScriptPath())],
    [
      "another HOME's current command",
      wrapPosixHookCommand('/other/.orca/agent-hooks/codex-hook.sh')
    ],
    ['a user script with the same name', '/bin/sh "/u/bin/codex-hook.sh"'],
    ['a user hook', 'my-stop-hook.sh'],
    ['no command', undefined]
  ])('leaves %s alone', (_case, command) => {
    expect(isRetiredCodexHookCommand(command)).toBe(false)
  })
})
