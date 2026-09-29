import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'
import { getShellLaunchConfig } from './daemon/shell-ready'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'
import { getPowerShellCodexLaunchScriptPath } from './providers/local-pty-shell-ready-wrapper-fileset'
import { getShellReadyWrapperRoot } from './providers/local-pty-shell-ready-wrapper-root'
import { getPowerShellCodexShellLaunchPreflightLoader } from './pty/codex-shell-launch-preflight'
import { STARTUP_COMMAND_FEATURES } from './shell-startup-launch-intent-fixtures'

describe('PowerShell OSC 133 bootstrap', () => {
  it('wraps prompt/readline without bypassing profiles or execution policy', () => {
    const script = getPowerShellOsc133Bootstrap()

    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()')
    expect(script).toContain('ORCA_OPENCODE_CONFIG_DIR')
    expect(script).toContain('ORCA_MIMOCODE_HOME')
    expect(script).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(script).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(script).toContain('ORCA_OMP_STATUS_EXTENSION')
    expect(script).toContain('function Global:omp')
    expect(script).toContain('--extension $env:ORCA_OMP_STATUS_EXTENSION')
    expect(script).toContain('ORCA_CODEX_HOME')
    expect(script).toContain('ORCA_CODEX_LAUNCH_PREFLIGHT')
    expect(script).toContain('function Global:codex')
    expect(script).not.toContain('$Global:__OrcaCodexExecutable')
    expect(script).toContain('function Global:prompt')
    expect(script).toContain('function Global:PSConsoleHostReadLine')
    expect(script).toContain('Esc = [char]27')
    expect(script).toContain('Bel = [char]7')
    expect(script).toContain(')]133;D;$fakeExitCode$(')
    expect(script).toContain(')]133;A$(')
    expect(script).toContain(')]133;B$(')
    expect(script).toContain(')]133;C$(')
    expect(script).not.toContain('`e]133')
    expect(script).not.toContain('$PROFILE')
    expect(script).not.toContain('ExecutionPolicy')
    expect(script).not.toContain('NoProfile')

    const codexHomeRestore = script.indexOf('if ($env:ORCA_CODEX_HOME)')
    expect(codexHomeRestore).toBeGreaterThan(-1)
    expect(codexHomeRestore).toBeLessThan(script.indexOf('Test-Path variable:global:'))
    expect(codexHomeRestore).toBeLessThan(script.indexOf('LanguageMode -eq "FullLanguage"'))
  })

  it('encodes commands as UTF-16LE base64 for PowerShell -EncodedCommand', () => {
    expect(encodePowerShellCommand('Write-Output ok')).toBe(
      Buffer.from('Write-Output ok', 'utf16le').toString('base64')
    )
  })

  // Why pinned: the MDE review (see powershell-osc133-bootstrap.ts) declined a
  // switch to -Command. Any future delivery shape must still hand PowerShell this
  // payload byte for byte -- comments, quotes, `$` and newlines included.
  describe.each([
    [
      'daemon shell-ready',
      () => getShellLaunchConfig('powershell.exe', STARTUP_COMMAND_FEATURES).args ?? [],
      () => getPowerShellOsc133Bootstrap()
    ],
    [
      'windows shell args',
      () => resolveWindowsShellLaunchArgs('pwsh.exe', 'C:\\repo', 'C:\\repo').shellArgs,
      // Why: Windows loads the Codex wrapper from the generated tree to keep command-line room.
      () =>
        getPowerShellOsc133Bootstrap(
          getPowerShellCodexShellLaunchPreflightLoader(
            getPowerShellCodexLaunchScriptPath(getShellReadyWrapperRoot())
          )
        )
    ]
  ])('%s PowerShell launch', (_name, getArgs, getExpectedBootstrap) => {
    let previousUserDataPath: string | undefined
    let userDataPath: string

    beforeEach(() => {
      previousUserDataPath = process.env.ORCA_USER_DATA_PATH
      userDataPath = mkdtempSync(join(tmpdir(), 'powershell-bootstrap-test-'))
      process.env.ORCA_USER_DATA_PATH = userDataPath
    })

    afterEach(() => {
      if (previousUserDataPath === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = previousUserDataPath
      }
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('delivers the bootstrap unmangled', () => {
      const args = getArgs()
      const encodedIndex = args.indexOf('-EncodedCommand')

      expect(encodedIndex).toBeGreaterThanOrEqual(0)
      expect(args).not.toContain('-Command')
      expect(args).not.toContain('-ExecutionPolicy')

      const delivered = Buffer.from(args[encodedIndex + 1] ?? '', 'base64').toString('utf16le')

      expect(delivered.startsWith(getExpectedBootstrap())).toBe(true)
    })
  })
})
