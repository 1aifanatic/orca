import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEX_CMD_HOOK_FLAG_MACRO_COMMAND,
  getCodexCmdHookFlagGateScript
} from './codex-cmd-hook-flag-gate'

describe('cmd codex status hook flag gate', () => {
  const script = getCodexCmdHookFlagGateScript()

  it('sets the flag argument only from a table entry, after the file-entry check', () => {
    const lines = script.split('\r\n')
    const entryLookup = lines.findIndex((line) =>
      line.includes('%ORCA_CODEX_HOOK_FLAGS%\\%%v.flag')
    )
    const entryGate = lines.findIndex(
      (line) => line.includes('findstr') && line.includes('goto orca_done')
    )
    const setArg = lines.findIndex((line) => line.includes('set ORCA_CODEX_HOOK_ARG="%%L"'))
    expect(lines[0]).toBe('@set "ORCA_CODEX_HOOK_ARG="')
    expect(entryLookup).toBeGreaterThan(0)
    expect(entryGate).toBeGreaterThan(entryLookup)
    expect(setArg).toBeGreaterThan(entryGate)
  })

  it('matches the same Orca entry text as the retired-form sweep, with either separator', () => {
    // Why /i: FINDSTR can miss with several case-sensitive literals of different lengths.
    expect(script).toContain('findstr /l /i /c:"agent-hooks/codex-hook."')
    expect(script).toContain('/c:"agent-hooks\\\\\\\\codex-hook."')
    expect(script).not.toMatch(/\/c:"codex-hook\./)
  })

  it('keeps its variables for the caller: no setlocal, and CRLF line ends for cmd', () => {
    expect(script).not.toMatch(/setlocal/i)
    expect(script.split('\r\n').length).toBeGreaterThan(5)
    expect(script.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it("never passes the user's arguments through `call`", () => {
    expect(CODEX_CMD_HOOK_FLAG_MACRO_COMMAND).toMatch(
      /doskey codex=call %ORCA_CODEX_HOOK_GATE% \$T /
    )
    expect(CODEX_CMD_HOOK_FLAG_MACRO_COMMAND).not.toMatch(/call [^$]*\$\*/)
  })
})

// Why run it: every check above is text; only cmd.exe proves the gate's parsing.
describe.runIf(process.platform === 'win32')('cmd codex status hook flag gate on cmd.exe', () => {
  const FLAG =
    "hooks={ Stop = [{ hooks = [{ type = 'command', command = 'x' }] }], state = { 'C:\\<session-flags>\\config.toml:stop:0:0' = { trusted_hash = 'sha256:a' } } }"
  const VERSION = 'codex-cli 9.9.9'
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function sandbox(versionLines: string[]): { root: string; table: string; codexHome: string } {
    const root = mkdtempSync(join(tmpdir(), 'orca cmd gate '))
    roots.push(root)
    const bin = join(root, 'bin')
    const table = join(root, 'codex-hook-flags')
    const codexHome = join(root, 'codex-home')
    for (const dir of [bin, table, codexHome]) {
      mkdirSync(dir)
    }
    writeFileSync(
      join(bin, 'codex.cmd'),
      `@if "%~1"=="--version" (\r\n${versionLines.map((line) => `@echo ${line}`).join('\r\n')}\r\n)\r\n`
    )
    writeFileSync(join(root, 'gate.cmd'), getCodexCmdHookFlagGateScript())
    writeFileSync(join(table, `${VERSION}.flag`), `${FLAG}\n`)
    return { root, table, codexHome }
  }

  function runGate(box: { root: string; table: string; codexHome: string }): string {
    const result = spawnSync(
      'cmd.exe',
      ['/d', '/c', `call "${join(box.root, 'gate.cmd')}" & set ORCA_CODEX_HOOK_ARG`],
      {
        encoding: 'utf-8',
        windowsVerbatimArguments: true,
        env: {
          ...process.env,
          PATH: `${join(box.root, 'bin')};${process.env.PATH ?? ''}`,
          ORCA_CODEX_HOOK_FLAGS: box.table,
          CODEX_HOME: box.codexHome
        }
      }
    )
    return result.stdout.trim()
  }

  it("sets the flag from the entry for the codex on PATH's version", () => {
    expect(runGate(sandbox([VERSION]))).toBe(`ORCA_CODEX_HOOK_ARG="${FLAG}"`)
  })

  it('finds the version line after output the AutoRun printed first', () => {
    expect(runGate(sandbox(['conda activated', VERSION]))).toBe(`ORCA_CODEX_HOOK_ARG="${FLAG}"`)
  })

  it('sets nothing for another version, and requests an entry for it', () => {
    const box = sandbox(['codex-cli 9.9.10'])
    expect(runGate(box)).not.toContain('ORCA_CODEX_HOOK_ARG=')
    expect(existsSync(join(box.table, 'codex-cli 9.9.10.request'))).toBe(true)
  })

  it('probes and requests nothing while hooks are off, which removes the table', () => {
    const box = sandbox(['codex-cli 9.9.10'])
    rmSync(box.table, { recursive: true })
    expect(runGate(box)).not.toContain('ORCA_CODEX_HOOK_ARG=')
    expect(existsSync(box.table)).toBe(false)
  })

  it.each(['C:/x/.orca/agent-hooks/codex-hook.cmd', 'C:\\x\\.orca\\agent-hooks\\codex-hook.cmd'])(
    'sets nothing beside an older Orca entry (%s)',
    (command) => {
      const box = sandbox([VERSION])
      writeFileSync(
        join(box.codexHome, 'hooks.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } })
      )
      expect(runGate(box)).not.toContain('ORCA_CODEX_HOOK_ARG=')
    }
  )
})
