import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  buildCodexHookCommand,
  CODEX_HOOK_COMMAND_FORM,
  readCodexHookCommandForm
} from './codex-hook-command-form'

// Why goldens: these bytes are shared by every Orca on a HOME. Changing them
// without a form bump makes builds rewrite each other's entry again.
const POSIX_GOLDEN =
  ': orca-agent-hook-form=1; if [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_PORT-}" ] && [ -f "${HOME-}/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "${HOME-}/.orca/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi'
const WINDOWS_BARE_GOLDEN = 'C:/Users/alice/.orca/agent-hooks/codex-hook.cmd'
const WINDOWS_POWERSHELL_GOLDEN =
  "<# orca-agent-hook-form=1 #> if ($env:ORCA_PANE_KEY -and $env:ORCA_AGENT_HOOK_ROOT -and (Test-Path -LiteralPath (Join-Path $env:ORCA_AGENT_HOOK_ROOT 'agent-hooks\\codex-hook.cmd') -PathType Leaf)) { & (Join-Path $env:ORCA_AGENT_HOOK_ROOT 'agent-hooks\\codex-hook.cmd') } elseif (-not $env:ORCA_AGENT_HOOK_ROOT -and $env:ORCA_PANE_KEY -and $env:ORCA_AGENT_HOOK_PORT -and (Test-Path -LiteralPath 'C:/Users/测试 O''Brien/.orca/agent-hooks/codex-hook.cmd' -PathType Leaf)) { & 'C:/Users/测试 O''Brien/.orca/agent-hooks/codex-hook.cmd' } else { if (-not $env:ORCA_AGENT_HOOK_PORT -or -not $env:ORCA_AGENT_HOOK_TOKEN -or -not $env:ORCA_PANE_KEY) { exit 0 }; [Console]::In.ReadToEnd() | Out-Null }; exit 0"

describe('frozen Codex hook command', () => {
  it('matches the form 1 goldens', () => {
    expect(CODEX_HOOK_COMMAND_FORM).toBe(1)
    expect(buildCodexHookCommand('/home/a/.orca/agent-hooks/codex-hook.sh', 'linux')).toBe(
      POSIX_GOLDEN
    )
    expect(
      buildCodexHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd', 'win32')
    ).toBe(WINDOWS_BARE_GOLDEN)
    expect(
      buildCodexHookCommand("C:\\Users\\测试 O'Brien\\.orca\\agent-hooks\\codex-hook.cmd", 'win32')
    ).toBe(WINDOWS_POWERSHELL_GOLDEN)
  })

  it('writes identical POSIX bytes whatever the home or build', () => {
    expect(buildCodexHookCommand('/Users/a/.orca/agent-hooks/codex-hook.sh', 'darwin')).toBe(
      buildCodexHookCommand('/home/b/.orca/agent-hooks/codex-hook.sh', 'linux')
    )
  })

  it.each([POSIX_GOLDEN, WINDOWS_BARE_GOLDEN, WINDOWS_POWERSHELL_GOLDEN])(
    'keeps the script name in plain text so every older build still recognizes it',
    (command) => {
      const isOrca = createManagedCommandMatcher(
        command === POSIX_GOLDEN ? 'codex-hook.sh' : 'codex-hook.cmd'
      )
      expect(isOrca(command)).toBe(true)
    }
  )

  it('reads the form: current, higher, and unmarked older forms', () => {
    expect(readCodexHookCommandForm(POSIX_GOLDEN, POSIX_GOLDEN)).toBe(1)
    expect(readCodexHookCommandForm(WINDOWS_BARE_GOLDEN, WINDOWS_BARE_GOLDEN)).toBe(1)
    expect(readCodexHookCommandForm(POSIX_GOLDEN.replace('form=1', 'form=2'), POSIX_GOLDEN)).toBe(2)
    expect(
      readCodexHookCommandForm(
        "if [ -f '/h/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/h/.orca/agent-hooks/codex-hook.sh'; fi",
        POSIX_GOLDEN
      )
    ).toBe(0)
    expect(
      readCodexHookCommandForm(
        'C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd',
        WINDOWS_BARE_GOLDEN
      )
    ).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32')('frozen Codex hook command under /bin/sh', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makeScripts(): { home: string; root: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-hook-form-'))
    roots.push(dir)
    const home = join(dir, 'home')
    const root = join(dir, 'root')
    const marker = join(dir, 'ran')
    for (const [base, label] of [
      [join(home, '.orca'), 'shared'],
      [root, 'root']
    ]) {
      mkdirSync(join(base, 'agent-hooks'), { recursive: true })
      writeFileSync(
        join(base, 'agent-hooks', 'codex-hook.sh'),
        `cat >/dev/null; printf ${label} >> '${marker}'; exit 2\n`
      )
    }
    return { home, root, marker }
  }

  async function run(env: Record<string, string>): Promise<{ code: number | null; ran: string }> {
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', POSIX_GOLDEN],
      input: '{"hook_event_name":"Stop"}',
      env: { PATH: process.env.PATH ?? '', ...env },
      timeoutMs: 10_000
    })
    const ran = existsSync(env.MARKER) ? readFileSync(env.MARKER, 'utf-8') : ''
    return { code: result.code, ran }
  }

  it.each([
    ['outside Orca', {}, ''],
    ['a pane with hooks off', { ORCA_PANE_KEY: 'tab:leaf' }, ''],
    ['a pane with hooks on', { ORCA_PANE_KEY: 'tab:leaf', ORCA_AGENT_HOOK_PORT: '1' }, 'shared'],
    [
      'a structured child with a root',
      { ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_ROOT: 'R' },
      ''
    ],
    [
      'a pane with a hook root',
      { ORCA_PANE_KEY: 'tab:leaf', ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_ROOT: 'R' },
      'root'
    ]
  ])('runs the right script for %s and always exits 0', async (_case, env, expected) => {
    const scripts = makeScripts()
    const resolved: Record<string, string> = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value === 'R' ? scripts.root : value])
    )
    expect(await run({ ...resolved, HOME: scripts.home, MARKER: scripts.marker })).toEqual({
      code: 0,
      ran: expected
    })
  })
})
