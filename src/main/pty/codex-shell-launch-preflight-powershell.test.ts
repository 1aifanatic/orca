import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getPowerShellCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflightLoader
} from './codex-shell-launch-preflight'
import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'

const roots: string[] = []
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('PowerShell Codex shell launch preflight', () => {
  it('preserves a user-defined command', () => {
    expect(getPowerShellCodexShellLaunchPreflight()).toContain(
      '$orcaCodexCommand.CommandType -in @("Application", "ExternalScript")'
    )
  })

  it.skipIf(!pwshAvailable).each([
    { accepts: '1', expected: 'args=--no-daemon hi' },
    { accepts: '0', expected: 'args=hi' }
  ])('adds --no-daemon only when that Codex accepts it: $accepts', ({ accepts, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-probe-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const isWindows = process.platform === 'win32'
    // Like clap: an unknown --no-daemon fails before --version is reached.
    writeExecutable(
      join(bin, isWindows ? 'codex.cmd' : 'codex'),
      isWindows
        ? '@echo off\r\nif "%~1"=="--no-daemon" if not "%TEST_CODEX_ACCEPTS%"=="1" exit /b 2\r\nif "%~2"=="--version" (echo codex-cli 0.158.0 & exit /b 0)\r\necho args=%*\r\n'
        : '#!/bin/sh\nif [ "$1" = --no-daemon ] && [ "$TEST_CODEX_ACCEPTS" != 1 ]; then exit 2; fi\nif [ "$2" = --version ]; then echo "codex-cli 0.158.0"; exit 0; fi\necho "args=$*"\n'
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ORCA_CODEX_LAUNCH_POLICY: '1',
      TEST_CODEX_ACCEPTS: accepts
    }
    // Why no launcher: the launch policy must not depend on a CLI this build can verify.
    delete env.ORCA_CODEX_LAUNCH_PREFLIGHT
    delete env.ORCA_CODEX_HOME

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `${getPowerShellCodexShellLaunchPreflight()}\ncodex hi`
      ],
      { encoding: 'utf-8', env }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(expected)
  })

  it.skipIf(!pwshAvailable)('installs the wrapper when loaded from a quoted script path', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-loader-'))
    const bin = join(root, 'bin')
    // Why a quote: the Windows bootstrap names this file by a PowerShell literal.
    const scriptPath = join(root, "wrapper's dir", 'codex-launch.ps1')
    roots.push(root)
    mkdirSync(bin)
    mkdirSync(join(root, "wrapper's dir"))
    writeFileSync(scriptPath, getPowerShellCodexShellLaunchPreflight())
    const isWindows = process.platform === 'win32'
    writeExecutable(
      join(bin, isWindows ? 'codex.cmd' : 'codex'),
      isWindows ? '@echo args=%*\r\n' : '#!/bin/sh\necho "args=$*"\n'
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ORCA_CODEX_LAUNCH_POLICY: '1',
      ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, 'unused-preflight')
    }
    delete env.ORCA_CODEX_HOME

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `${getPowerShellCodexShellLaunchPreflightLoader(scriptPath)}\ncodex hi`
      ],
      { encoding: 'utf-8', env }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('args=--no-daemon hi')
  })

  it.skipIf(!pwshAvailable).each([
    { home: 'no managed home', managedHome: false },
    // Why: hook prep is a native call whose own exit 0 must not reach the caller.
    { home: 'a managed home', managedHome: true }
  ])(
    'leaves LASTEXITCODE as it was when that Codex cannot run at all ($home)',
    ({ managedHome }) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-blocked-'))
      const bin = join(root, 'bin')
      roots.push(root)
      mkdirSync(bin)
      // Stands in for npm's codex.ps1 under an execution policy that refuses it.
      writeFileSync(join(bin, 'codex.ps1'), "throw 'blocked by execution policy'\n")
      const isWindows = process.platform === 'win32'
      const preflight = join(bin, isWindows ? 'orca-test.cmd' : 'orca-test')
      writeExecutable(preflight, isWindows ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ORCA_CODEX_LAUNCH_POLICY: '1',
        ORCA_CODEX_LAUNCH_PREFLIGHT: preflight,
        ORCA_CODEX_HOME: join(root, 'managed-home')
      }
      if (!managedHome) {
        delete env.ORCA_CODEX_HOME
      }

      const result = spawnSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-Command',
          [
            getPowerShellCodexShellLaunchPreflight(),
            "if ($IsWindows) { cmd /c 'exit 5' } else { sh -c 'exit 5' }",
            'try { codex hi } catch { }',
            '"exit=$LASTEXITCODE"'
          ].join('\n')
        ],
        { encoding: 'utf-8', env }
      )

      expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe('exit=5')
    }
  )

  it.skipIf(!pwshAvailable)(
    'launches under Set-StrictMode before any native command has set $LASTEXITCODE',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-strict-'))
      const bin = join(root, 'bin')
      roots.push(root)
      mkdirSync(bin)
      const isWindows = process.platform === 'win32'
      writeExecutable(
        join(bin, isWindows ? 'codex.cmd' : 'codex'),
        isWindows
          ? '@echo off\r\nif "%~2"=="--version" exit /b 0\r\necho args=%*\r\n'
          : '#!/bin/sh\nif [ "$2" = --version ]; then exit 0; fi\necho "args=$*"\n'
      )
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ORCA_CODEX_LAUNCH_POLICY: '1'
      }
      // Why no managed home: hook prep is a native call that would set $LASTEXITCODE first.
      delete env.ORCA_CODEX_HOME
      delete env.ORCA_CODEX_LAUNCH_PREFLIGHT

      const result = spawnSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-Command',
          [
            'Set-StrictMode -Version Latest',
            '$ErrorActionPreference = "Stop"',
            getPowerShellCodexShellLaunchPreflight(),
            'codex hi'
          ].join('\n')
        ],
        { encoding: 'utf-8', env }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('args=--no-daemon hi')
      expect(result.stderr).toBe('')
    }
  )

  // Why both: pwsh 7 ignores Stop for redirected native stderr (5.1 does not), so only the
  // script's error record goes red here without the pinned preferences.
  it.skipIf(!pwshAvailable).each([
    { report: 'an error record from a codex.ps1', kind: 'script' },
    { report: 'native stderr', kind: 'native' }
  ])(
    "keeps --no-daemon and hook prep when the probe emits $report under the user's Stop",
    ({ kind }) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-stop-'))
      const bin = join(root, 'bin')
      roots.push(root)
      mkdirSync(bin)
      const isWindows = process.platform === 'win32'
      if (kind === 'script') {
        writeFileSync(
          join(bin, 'codex.ps1'),
          "if ($args[0] -eq '--no-daemon' -and $args[1] -eq '--version') { Write-Error 'note'; exit 0 }\n\"args=$args\"\n"
        )
      } else {
        writeExecutable(
          join(bin, isWindows ? 'codex.cmd' : 'codex'),
          isWindows
            ? '@echo off\r\nif "%~2"=="--version" (echo note 1>&2 & exit /b 0)\r\necho args=%*\r\n'
            : '#!/bin/sh\nif [ "$2" = --version ]; then echo note >&2; exit 0; fi\necho "args=$*"\n'
        )
      }
      const marker = join(root, 'prep-ran')
      const preflight = join(bin, isWindows ? 'orca-test.cmd' : 'orca-test')
      writeExecutable(
        preflight,
        isWindows
          ? '@echo note 1>&2\r\n@type nul > "%TEST_PREP_MARKER%"\r\n'
          : '#!/bin/sh\necho note >&2\n: > "$TEST_PREP_MARKER"\n'
      )

      const result = spawnSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-Command',
          [
            'Set-StrictMode -Version Latest',
            '$ErrorActionPreference = "Stop"',
            getPowerShellCodexShellLaunchPreflight(),
            'codex hi'
          ].join('\n')
        ],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
            ORCA_CODEX_LAUNCH_POLICY: '1',
            ORCA_CODEX_LAUNCH_PREFLIGHT: preflight,
            ORCA_CODEX_HOME: join(root, 'managed-home'),
            TEST_PREP_MARKER: marker
          }
        }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('args=--no-daemon hi')
      expect(result.stderr).toBe('')
      expect(existsSync(marker)).toBe(true)
    }
  )

  it.skipIf(!pwshAvailable)('reports 127 under Stop when codex was removed after startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-removed-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const isWindows = process.platform === 'win32'
    const codexPath = join(bin, isWindows ? 'codex.cmd' : 'codex')
    writeExecutable(codexPath, isWindows ? '@echo args=%*\r\n' : '#!/bin/sh\necho "args=$*"\n')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ORCA_CODEX_LAUNCH_POLICY: '1'
    }
    delete env.ORCA_CODEX_HOME
    delete env.ORCA_CODEX_LAUNCH_PREFLIGHT

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        [
          getPowerShellCodexShellLaunchPreflight(),
          // Why PATH narrowed: the lookup must not fall through to a host Codex.
          `$env:PATH = ${quotePowerShellLiteral(bin)}`,
          `Remove-Item -LiteralPath ${quotePowerShellLiteral(codexPath)}`,
          '$ErrorActionPreference = "Stop"',
          '$global:LASTEXITCODE = 5',
          'try { codex hi } catch { "caught=$_" }',
          '"exit=$LASTEXITCODE"'
        ].join('\n')
      ],
      { encoding: 'utf-8', env }
    )

    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      'caught=codex executable not found',
      'exit=127'
    ])
  })

  it.skipIf(!pwshAvailable)('passes piped input through to Codex', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-stdin-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const isWindows = process.platform === 'win32'
    writeExecutable(
      join(bin, isWindows ? 'codex.cmd' : 'codex'),
      isWindows ? '@findstr "^"\r\n' : '#!/bin/sh\ncat\n'
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ORCA_CODEX_LAUNCH_POLICY: '1'
    }
    delete env.ORCA_CODEX_HOME
    delete env.ORCA_CODEX_LAUNCH_PREFLIGHT

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `${getPowerShellCodexShellLaunchPreflight()}\n'piped prompt' | codex exec -`
      ],
      { encoding: 'utf-8', env }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('piped prompt')
  })

  it.skipIf(!pwshAvailable)('fails open when native errors are promoted', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-failure-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
    writeExecutable(
      join(bin, `orca-test${executableSuffix}`),
      process.platform === 'win32' ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n'
    )
    writeExecutable(
      join(bin, `codex${executableSuffix}`),
      process.platform === 'win32' ? '@echo launched\r\n' : '#!/bin/sh\nprintf "launched\\n"\n'
    )

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          '$PSNativeCommandUseErrorActionPreference = $true',
          getPowerShellCodexShellLaunchPreflight(),
          'codex'
        ].join('\n')
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          ORCA_CODEX_LAUNCH_POLICY: '1',
          ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, `orca-test${executableSuffix}`),
          ORCA_CODEX_HOME: '/orca/managed/home'
        }
      }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('launched')
  })
})
