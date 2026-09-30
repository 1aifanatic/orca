import { describe, expect, it } from 'vitest'
import {
  CODEX_CMD_HOOK_FLAG_MACRO_COMMAND,
  getCodexCmdHookFlagGateScript
} from './codex-cmd-hook-flag-gate'

describe('cmd codex status hook flag gate', () => {
  const script = getCodexCmdHookFlagGateScript()

  it('sets the flag argument only after the version and file-entry checks pass', () => {
    const lines = script.split('\r\n')
    const setArg = lines.findIndex((line) => line.startsWith('@set ORCA_CODEX_HOOK_ARG='))
    const versionGate = lines.findIndex((line) =>
      line.includes('ORCA_CODEX_HOOK_VERSION%" goto orca_done')
    )
    const entryGate = lines.findIndex(
      (line) => line.includes('findstr') && line.includes('goto orca_done')
    )
    expect(lines[0]).toBe('@set "ORCA_CODEX_HOOK_ARG="')
    expect(versionGate).toBeGreaterThan(0)
    expect(entryGate).toBeGreaterThan(versionGate)
    expect(setArg).toBeGreaterThan(entryGate)
  })

  it('expands the flag only inside quotes, where cmd treats < and > as text', () => {
    expect(script).toContain('@set ORCA_CODEX_HOOK_ARG="%ORCA_CODEX_HOOK_CONFIG%"')
    expect(script.match(/%ORCA_CODEX_HOOK_CONFIG%/g)).toHaveLength(1)
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
