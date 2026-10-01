import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetPowerShellProfileEnvCache,
  readPowerShellProfileEnvAssignments
} from './powershell-profile-env'

const roots: string[] = []

afterEach(() => {
  __resetPowerShellProfileEnvCache()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-ps-profile-'))
  roots.push(root)
  return root
}

function writeProfile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('readPowerShellProfileEnvAssignments', () => {
  it('reads assignments from both editions in load order, $PSHOME first', () => {
    const root = createRoot()
    const userProfile = join(root, 'me')
    const env = { SystemRoot: join(root, 'Windows'), ProgramFiles: join(root, 'pf') }
    writeProfile(
      join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'profile.ps1'),
      "$env:CODEX_HOME = 'C:\\all-users'\n"
    )
    writeProfile(
      join(userProfile, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      '\uFEFF$Env:Codex_Home="$HOME\\.codex-5"\r\n'
    )
    writeProfile(
      join(userProfile, 'Documents', 'PowerShell', 'profile.ps1'),
      '  ${env:CODEX_HOME} = $env:USERPROFILE\\.codex-7 # pwsh\n'
    )

    expect(readPowerShellProfileEnvAssignments('CODEX_HOME', userProfile, env)).toEqual([
      'C:\\all-users',
      `${userProfile}\\.codex-5`,
      `${userProfile}\\.codex-7`
    ])
  })

  it('reads the registry-named Documents folder, e.g. one OneDrive redirected', () => {
    const root = createRoot()
    const documentsDir = join(root, 'OneDrive', 'Dokumente')
    writeProfile(
      join(documentsDir, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      "$env:CODEX_HOME = 'D:\\codex'\n"
    )

    expect(
      readPowerShellProfileEnvAssignments('CODEX_HOME', join(root, 'me'), {}, documentsDir)
    ).toEqual(['D:\\codex'])
  })

  it('keeps literal and unevaluable values, and ignores other names and empties', () => {
    const root = createRoot()
    writeProfile(
      join(root, 'Documents', 'PowerShell', 'profile.ps1'),
      [
        "$env:CODEX_HOME = '$HOME\\literal # kept'",
        '$env:CODEX_HOME = (Join-Path $HOME .codex-x)',
        '$env:CODEX_HOME = $null',
        "$env:CODEX_HOME = ''",
        "$env:CODEX_HOMEX = 'C:\\other'",
        "# $env:CODEX_HOME = 'C:\\commented'"
      ].join('\n')
    )

    expect(readPowerShellProfileEnvAssignments('CODEX_HOME', root, {})).toEqual([
      '$HOME\\literal # kept',
      `(Join-Path ${root} .codex-x)`
    ])
  })
})
