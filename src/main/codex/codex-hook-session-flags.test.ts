import { describe, expect, it } from 'vitest'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  type CodexHookSessionTrust
} from './codex-hook-session-flags'

function trustFor(prefix: string): CodexHookSessionTrust {
  return Object.fromEntries(
    CODEX_EVENTS.map((eventName) => {
      const label = CODEX_EVENT_LABEL[eventName]
      return [label, { key: `${prefix}:${label}:0:0`, trustedHash: `sha256:${label}` }]
    })
  )
}

describe('buildCodexHookSessionFlag', () => {
  it('defines every managed event and approves each with its reported hash (POSIX)', () => {
    const flag = buildCodexHookSessionFlag(
      ': form; /bin/sh "$HOME/x"',
      trustFor('/<session-flags>/config.toml'),
      'darwin'
    )
    expect(flag).not.toBeNull()
    expect(flag!.startsWith('hooks={')).toBe(true)
    for (const eventName of CODEX_EVENTS) {
      const label = CODEX_EVENT_LABEL[eventName]
      expect(flag).toContain(
        `${eventName}=[{hooks=[{type="command",command=": form; /bin/sh \\"$HOME/x\\"",timeout=10}]}]`
      )
      expect(flag).toContain(
        `"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="sha256:${label}"}`
      )
    }
  })

  it('spells Windows values with single quotes and spaces, and no double quote or percent', () => {
    const flag = buildCodexHookSessionFlag(
      'C:/Users/me/.orca/agent-hooks/codex-hook.cmd',
      trustFor('C:\\<session-flags>\\config.toml'),
      'win32'
    )
    expect(flag).not.toBeNull()
    expect(flag).toContain(' ')
    expect(flag).not.toMatch(/["%]/)
    expect(flag).toContain(
      "'C:\\<session-flags>\\config.toml:stop:0:0' = { trusted_hash = 'sha256:stop' }"
    )
  })

  it('carries nothing on Windows when the command needs a quote the shells would mangle', () => {
    const cmdSpelling =
      'C:\\Windows\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/a b/codex-hook.cmd"'
    expect(
      buildCodexHookSessionFlag(cmdSpelling, trustFor('C:\\<session-flags>\\config.toml'), 'win32')
    ).toBeNull()
    expect(buildCodexHookDefinitionFlag(cmdSpelling, 'win32')).toBeNull()
  })

  it('carries nothing when any event lacks its approval, since that event would open a review', () => {
    const partial = { ...trustFor('/<session-flags>/config.toml') }
    delete partial[CODEX_EVENT_LABEL.Stop]
    expect(buildCodexHookSessionFlag('x', partial, 'linux')).toBeNull()
  })

  it('defines the hook without any approval for the hash lookup', () => {
    const flag = buildCodexHookDefinitionFlag('x', 'linux')
    expect(flag).toContain('Stop=[{hooks=[{type="command",command="x",timeout=10}]}]')
    expect(flag).not.toContain('state')
  })
})
