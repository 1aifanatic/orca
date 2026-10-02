import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { orcadLivenessProbeCommand, type OrcadLaunchSpec } from './orcad-remote-launch'
import {
  OrcadWindowsLaunchRefusedError,
  readWindowsOrcadLaunchReport,
  windowsOrcadLaunchCommand
} from './orcad-remote-launch-windows'
import { parseOrcadStopOutcome, stopOrcadCommand } from './orcad-remote-process-control'
import { orcadReadinessWaitCommand } from './orcad-remote-readiness-wait'
import { remoteOrcadBuildHashCommand, readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import {
  readBoundedOrcadRemoteRecord,
  writeAtomicOrcadRemoteRecord
} from './orcad-remote-record-file'
import { launchOrcadAndAwaitReadiness } from './orcad-remote-runtime-control'
import { completeRemoteOrcadManagedStop } from './orcad-managed-remote-stop'
import type { OrcadSlotOptions } from './orcad-recovery-slot'

const mockExec = vi.mocked(execCommand)
const host = getRemoteHostPlatform('win32-x64')
const slot = "C:/Users/O'Brien/.orca-remote/orcad-0.2.0+bb01"
const NODE = 'C:/Users/u/.orca-remote/runtimes/node-ab/node.exe'
const spec: OrcadLaunchSpec = {
  remoteInstallDir: slot,
  nodePath: 'C:/host/node.exe',
  fullVersion: '0.2.0+bb01',
  userDataDir: 'C:/Users/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777
}

function windowsConn(): { conn: SshConnection; writes: [string, string][] } {
  const writes: [string, string][] = []
  const conn: SshConnection = Object.assign(Object.create(null), {
    writeFile: async (path: string, contents: string) => {
      writes.push([path, contents])
    }
  })
  return { conn, writes }
}

beforeEach(() => {
  mockExec.mockReset()
})

describe('Windows orcad commands stay inside the EDR posture', () => {
  const commands = (): [string, string][] => [
    ['launch', windowsOrcadLaunchCommand(host, spec)],
    ['readiness wait', orcadReadinessWaitCommand(host, slot, 20)],
    ['liveness', orcadLivenessProbeCommand(host, slot)],
    ['stop', stopOrcadCommand(host, slot, { waitSeconds: 20, nodePath: spec.nodePath })],
    ['build hash', remoteOrcadBuildHashCommand(host, slot)]
  ]

  it.each(commands())(
    '%s: one encoded powershell.exe, one node.exe, no policy switch, WMI or signal',
    (_name, command) => {
      expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand \S+$/)
      const script = decodeRemotePowerShellScript(command)
      expect(script).not.toMatch(
        /ExecutionPolicy|Add-Type|\.ps1|Import-Module|Cim|Wmi|Win32_Process|Stop-Process|taskkill|SIGTERM|kill -/i
      )
      expect(script.match(/(?:^|\()& /gmu)).toHaveLength(1)
      expect(script).not.toContain('bun')
    }
  )

  it('never polls across SSH: one launch exec and one host-side wait', async () => {
    mockExec
      .mockResolvedValueOnce(
        'ORCA_ORCAD_LAUNCH {"method":"breakaway","pid":4242,"inJob":false}\r\n'
      )
      .mockImplementationOnce(async () => {
        const line = JSON.stringify({ type: 'orca_server_ready', runtimeId: 'r1' })
        return `__ORCAD_READINESS__ ${Buffer.from(`${line}\n`).toString('base64')}\r\n`
      })
    const sleep = vi.fn(async () => {})
    const result = await launchOrcadAndAwaitReadiness(
      { conn: Object.create(null), host, readinessTimeoutMs: 60_000, sleep },
      spec
    )
    expect(result).toMatchObject({ state: 'ready', readiness: { runtimeId: 'r1' } })
    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('Windows launch', () => {
  it('starts the slot runtime once, as a breakaway launcher, with no WMI route', () => {
    expect(decodeRemotePowerShellScript(windowsOrcadLaunchCommand(host, spec)))
      .toMatchInlineSnapshot(`
        "try { $orcadSha = [IO.File]::ReadAllText('C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01/.runtime-node').Trim() } catch { exit 78 }
        if ($orcadSha -cnotmatch '^[0-9a-f]{64}$') { exit 78 }
        $orcadRuntime = 'C:/Users/O''Brien/.orca-remote/runtimes/node-' + $orcadSha + '/node.exe'
        if (-not (Test-Path -LiteralPath $orcadRuntime -PathType Leaf)) { exit 78 }
        Set-Location -ErrorAction Stop -LiteralPath 'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01'
        Remove-Item -LiteralPath 'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01/.orcad-stop-request' -Force -ErrorAction SilentlyContinue
        $env:ORCA_VERSION = '0.2.0+bb01'
        $env:ORCA_USER_DATA = 'C:/Users/u/.orca'
        (& $orcadRuntime 'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01/orcad.js' '--windows-breakaway-launch' '--stdout-file' 'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01/.orcad-readiness' '--stderr-file' 'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01/orcad.log' '--process-file' 'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01/.orcad-process.json' '--orcad-args' '--json' '--bind' '127.0.0.1' '--port' '7777') -join ' '
        exit 0"
      `)
  })

  it('reads the report: a PID, a refusal, or a failure', () => {
    expect(
      readWindowsOrcadLaunchReport('ORCA_ORCAD_LAUNCH {"method":"breakaway","pid":9,"inJob":false}')
    ).toBe(9)
    expect(() =>
      readWindowsOrcadLaunchReport(
        'ORCA_ORCAD_LAUNCH {"method":"unavailable","reason":"breakaway-denied","step":"create-process","code":5}'
      )
    ).toThrow(OrcadWindowsLaunchRefusedError)
    expect(() =>
      readWindowsOrcadLaunchReport(
        'ORCA_ORCAD_LAUNCH {"method":"failed","reason":"failed","step":"open-stdout","code":32}'
      )
    ).toThrow('open-stdout (code 32)')
    // The relay's report is not orcad's.
    expect(() =>
      readWindowsOrcadLaunchReport('ORCA_RELAY_LAUNCH {"method":"breakaway","pid":9,"inJob":false}')
    ).toThrow('no launch report')
  })
})

describe('Windows stop', () => {
  it('passes only the slot, the wait and the launch flag to the fixed script', () => {
    const script = decodeRemotePowerShellScript(
      stopOrcadCommand(host, slot, { waitSeconds: 20, justLaunched: true })
    )
    const invocation = script.split('\n').find((line) => line.startsWith('& '))
    expect(invocation?.endsWith(`'C:/Users/O''Brien/.orca-remote/orcad-0.2.0+bb01' '20' '1'`)).toBe(
      true
    )
  })

  it('reads UNSUPPORTED as a refusal that does not free the host', () => {
    expect(parseOrcadStopOutcome('UNSUPPORTED')).toBe('unsupported')
  })
})

describe('Windows build hash', () => {
  it('hashes orcad.js with the slot node and reads the same marker', async () => {
    mockExec.mockResolvedValueOnce('__ORCAD_BUILD_HASH__ ABC123DEF4567890\r\n')
    await expect(readRemoteOrcadBuildHash({ conn: Object.create(null), host }, slot)).resolves.toBe(
      'abc123def4567890'
    )
  })
})

describe('Windows host records', () => {
  it('decodes a present record and reads absent as absent', async () => {
    const { conn } = windowsConn()
    const target = { conn, host, windowsNodePath: NODE }
    mockExec.mockResolvedValueOnce(
      `__ORCAD_RECORD_PRESENT__ ${Buffer.from('{"owner":"Zoë"}').toString('base64')}\r\n`
    )
    await expect(readBoundedOrcadRemoteRecord(target, 'C:/r.json', 64)).resolves.toEqual({
      state: 'present',
      raw: '{"owner":"Zoë"}'
    })
    mockExec.mockResolvedValueOnce('__ORCAD_RECORD_ABSENT__\r\n')
    await expect(readBoundedOrcadRemoteRecord(target, 'C:/r.json', 64)).resolves.toEqual({
      state: 'absent'
    })
    mockExec.mockResolvedValueOnce('')
    await expect(readBoundedOrcadRemoteRecord(target, 'C:/r.json', 64)).rejects.toThrow(
      'no verifiable answer'
    )
  })

  it('stages the contents as a file and never puts them on a command line', async () => {
    const { conn, writes } = windowsConn()
    mockExec.mockResolvedValueOnce('')
    const contents = '{"secret-ish":"record body"}'
    await writeAtomicOrcadRemoteRecord({ conn, host, windowsNodePath: NODE }, 'C:/r.json', contents)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toMatch(/^C:\/r\.json\.partial\./u)
    expect(writes[0]?.[1]).toBe(contents)
    const script = decodeRemotePowerShellScript(String(mockExec.mock.calls[0]?.[1]))
    expect(script).not.toContain('record body')
    expect(script).toContain(`& '${NODE}'`)
  })
})

describe('Windows managed stop', () => {
  it('hands orcad a staged request file, not JSON on argv', async () => {
    const { conn, writes } = windowsConn()
    const request = {
      schemaVersion: 1 as const,
      transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
      version: '0.2.0+bb01',
      runtimeId: 'r1',
      instance: { pid: 9, startedAtMs: 5, nonce: 'n', lockPath: 'C:/Users/u/.orca/orcad.lock' }
    }
    mockExec
      .mockResolvedValueOnce(
        `${JSON.stringify({ ...request, kind: 'orcad_managed_stop_completion', verdict: 'live', receiptPersisted: false })}\r\n`
      )
      .mockResolvedValueOnce('')
    const options: OrcadSlotOptions = {
      conn,
      host,
      remoteHome: 'C:/Users/u',
      nodePath: 'C:/host/node.exe',
      userDataDir: 'C:/Users/u/.orca',
      bindHost: '127.0.0.1',
      port: 7777
    }
    await expect(completeRemoteOrcadManagedStop(options, request)).resolves.toMatchObject({
      verdict: 'live'
    })
    expect(writes).toHaveLength(1)
    const [stagedPath, stagedBody] = writes[0] ?? ['', '']
    expect(JSON.parse(stagedBody)).toEqual(request)
    const script = decodeRemotePowerShellScript(String(mockExec.mock.calls[0]?.[1]))
    expect(script).not.toContain(request.transactionId)
    expect(script).toContain(`'--complete-managed-stop' '--request-file' '${stagedPath}'`)
    // The staged request is removed once the command answered.
    expect(decodeRemotePowerShellScript(String(mockExec.mock.calls[1]?.[1]))).toContain(
      `Remove-Item -LiteralPath '${stagedPath}'`
    )
  })
})
