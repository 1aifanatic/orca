/**
 * Starting a candidate orcad on a Windows SSH host.
 *
 * Win32-OpenSSH kills the session's job when the session ends, so orcad must leave that job.
 * `orcad.js --windows-breakaway-launch` does it the way the relay does: one CreateProcessW with
 * CREATE_BREAKAWAY_FROM_JOB through the slot's staged process-tree addon. Unlike the relay there
 * is no WMI fallback: Win32_Process.Create is EDR-scored remote execution and refused to a
 * standard user's network logon, so a host that cannot break away refuses the launch.
 *
 * The launcher records the PID with its creation time; a PID alone is not an identity on
 * Windows, which reuses them aggressively.
 */
import {
  ORCAD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG
} from '../../shared/windows-breakaway-launch'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'
import { orcadWindowsSlotRuntimeLines } from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_PROCESS_FILENAME } from './orcad-remote-host-support'
import {
  ORCAD_LOG_FILENAME,
  ORCAD_READINESS_FILENAME,
  type OrcadLaunchSpec
} from './orcad-remote-launch'

export class OrcadWindowsLaunchRefusedError extends Error {
  readonly code = 'orcad_windows_launch_refused'
  constructor(reason: string) {
    super(
      `The Windows host refused to start orcad outside the SSH session (${reason}). orcad needs ` +
        'a job that allows breakaway and a slot with the process-tree launcher; it never falls ' +
        'back to WMI.'
    )
    this.name = 'OrcadWindowsLaunchRefusedError'
  }
}

export function windowsOrcadLaunchCommand(host: RemoteHostPlatform, spec: OrcadLaunchSpec): string {
  const dir = spec.remoteInstallDir
  const launcherArgs = [
    joinRemotePath(host, dir, 'orcad.js'),
    WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    // The addon creates both with CREATE_ALWAYS, so a previous run's readiness line is gone
    // before the launcher returns.
    WINDOWS_BREAKAWAY_STDOUT_FLAG,
    joinRemotePath(host, dir, ORCAD_READINESS_FILENAME),
    WINDOWS_BREAKAWAY_STDERR_FLAG,
    joinRemotePath(host, dir, ORCAD_LOG_FILENAME),
    WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
    joinRemotePath(host, dir, ORCAD_WINDOWS_PROCESS_FILENAME),
    ORCAD_WINDOWS_BREAKAWAY_CONTRACT.argsFlag,
    '--json',
    '--bind',
    spec.bindHost,
    '--port',
    String(spec.port)
  ]
  return powerShellCommand(
    [
      ...orcadWindowsSlotRuntimeLines(host, dir),
      `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(dir)}`,
      // A stop request the previous process never consumed must not stop this one.
      `Remove-Item -LiteralPath ${powerShellLiteral(joinRemotePath(host, dir, ORCAD_STOP_REQUEST_FILENAME))} -Force -ErrorAction SilentlyContinue`,
      `$env:ORCA_VERSION = ${powerShellLiteral(spec.fullVersion)}`,
      `$env:ORCA_USER_DATA = ${powerShellLiteral(spec.userDataDir)}`,
      `(& $orcadRuntime ${launcherArgs.map(powerShellNativeArg).join(' ')}) -join ' '`,
      // The report, not the exit code, carries the verdict.
      'exit 0'
    ].join('\n')
  )
}

/** The launched PID, or a refusal (no breakaway route) or failure the deploy must surface. */
export function readWindowsOrcadLaunchReport(output: string): number {
  const report = parseWindowsBreakawayLaunchReport(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, output)
  if (report?.method === 'breakaway') {
    return report.pid
  }
  if (report?.method === 'unavailable') {
    throw new OrcadWindowsLaunchRefusedError(
      report.step ? `${report.reason} at ${report.step}` : report.reason
    )
  }
  const detail =
    report?.method === 'failed'
      ? `${report.reason}${report.step ? ` at ${report.step}` : ''} (code ${String(report.code ?? 0)})`
      : 'no launch report'
  throw new Error(`orcad's Windows launcher did not start the candidate: ${detail}.`)
}
