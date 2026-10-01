import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const gate = vi.hoisted(() => ({ enabled: true }))
vi.mock('./claude-profile-routing', () => ({ claudeProfileRoutingEnabled: () => gate.enabled }))
import {
  getPosixClaudeShellFunction,
  getFishClaudeShellFunction,
  getPowerShellClaudeShellFunction
} from './claude-shell-function'
const roots: string[] = []
afterEach(() => {
  gate.enabled = true
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-shell-'))
  roots.push(root)
  const a = join(root, 'account a ü')
  const b = join(root, 'account b')
  const bin = join(root, 'bin')
  for (const dir of [a, b, bin]) {
    mkdirSync(dir)
  }
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\n[ "$1" != hold ] || sleep 0.1\nprintf "HOME=%s KEY=%s ARG=%s\\n" "${CLAUDE_CONFIG_DIR-default}" "${ANTHROPIC_API_KEY-none}" "$1"\nexit 23\n'
  )
  chmodSync(join(bin, 'claude'), 0o700)
  const pointer = join(root, 'selected')
  writeFileSync(pointer, a)
  const run = (shell: string, text: string) =>
    spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        `ORCA_CLAUDE_PROFILE_POINTER=${pointer}`,
        'ANTHROPIC_API_KEY=fake',
        shell,
        ...(shell.endsWith('zsh') ? ['-f'] : []),
        '-c',
        text
      ],
      { encoding: 'utf8' }
    )
  return { root, a, b, pointer, run }
}
describe('Claude invocation account selection', () => {
  it.each(['/bin/bash', '/bin/zsh'])(
    'switches the next invocation in the same %s while a running child keeps its home',
    (shell) => {
      const f = fixture()
      const result = f.run(
        shell,
        `${getPosixClaudeShellFunction()}\nclaude hold & child=$!\nsleep 0.02\nprintf '%s' '${f.b}' > "$ORCA_CLAUDE_PROFILE_POINTER"\nclaude 'two words'\nwait "$child"`
      )
      expect(result.stdout).toContain(`HOME=${f.a} KEY=none ARG=hold`)
      expect(result.stdout).toContain(`HOME=${f.b} KEY=none ARG=two words`)
      expect(result.status).toBe(23)
    }
  )
  it.each(['/bin/bash', '/bin/zsh'])(
    'refuses unreadable/missing and malformed selections and keeps explicit default auth in %s',
    (shell) => {
      const f = fixture()
      for (const value of ['\n', `${f.a}\n`, '/missing-profile', 'relative', `${f.a}\0`]) {
        writeFileSync(f.pointer, value)
        const result = f.run(shell, `${getPosixClaudeShellFunction()}\nclaude test`)
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).not.toBe('')
      }
      rmSync(f.pointer)
      expect(f.run(shell, `${getPosixClaudeShellFunction()}\nclaude test`).status).toBe(1)
      writeFileSync(f.pointer, '')
      expect(f.run(shell, `${getPosixClaudeShellFunction()}\nclaude default`).stdout).toContain(
        'HOME=default KEY=fake'
      )
    }
  )
  it('keeps setup without an account authority on explicit remote defaults', () => {
    const f = fixture()
    const script = `unset ORCA_CLAUDE_PROFILE_POINTER\n${getPosixClaudeShellFunction({ optionalAuthority: true })}\nclaude remote`
    expect(f.run('/bin/bash', script).stdout).toContain('HOME=default KEY=fake ARG=remote')
  })
  it('preserves dormant generated scripts byte for byte', () => {
    gate.enabled = false
    expect([
      getPosixClaudeShellFunction(),
      getFishClaudeShellFunction(),
      getPowerShellClaudeShellFunction()
    ]).toEqual(['', '', ''])
  })
  it.skipIf(!existsSync('/opt/homebrew/bin/fish'))('uses the same pointer in fish', () => {
    const f = fixture()
    const result = f.run(
      '/opt/homebrew/bin/fish',
      `${getFishClaudeShellFunction()}\nclaude 'two words'`
    )
    expect(result.stdout).toContain(`HOME=${f.a} KEY=none ARG=two words`)
    expect(result.status).toBe(23)
    writeFileSync(f.pointer, '\n')
    expect(
      f.run('/opt/homebrew/bin/fish', `${getFishClaudeShellFunction()}\nclaude test`).stdout
    ).toBe('')
  })
  it('emits a PowerShell per-invocation read, visible refusal and finally restoration', () => {
    const script = getPowerShellClaudeShellFunction()
    expect(script).toContain('[IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER)')
    expect(script).toContain("throw 'Selected Claude profile")
    expect(script).toContain('finally { foreach')
    expect(script).toContain('$input | & $binary.Source @args')
  })
})
