/**
 * Running Orca's fixed host-side scripts with node.exe on a Windows orcad host.
 *
 * Each operation is one powershell.exe through `powerShellCommand` (no policy switch, no
 * `Add-Type`, no WMI) that starts one node.exe; see docs/reference/windows-edr-posture.md. Data
 * the client sends travels in staged files or as plain path and number arguments, never as JSON
 * on the command line. Answers carrying host bytes are base64 behind a marker, because Windows
 * PowerShell 5.1 re-decodes native output through the console code page.
 */
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME
} from '../../shared/orcad-artifacts'
import { joinRemotePath, remoteDirname, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'

/** Same code the POSIX selector exits with when a slot names no usable runtime. */
export const ORCAD_WINDOWS_RUNTIME_MISSING_EXIT = 78

/** PowerShell lines setting `$orcadRuntime` to the node.exe the slot's marker names, or exiting 78. */
export function orcadWindowsSlotRuntimeLines(host: RemoteHostPlatform, slotDir: string): string[] {
  const marker = joinRemotePath(host, slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  const prefix = joinRemotePath(
    host,
    remoteDirname(slotDir.replace(/\/+$/u, ''), host),
    ORCAD_RUNTIMES_DIRNAME,
    ORCAD_NODE_RUNTIME_DIR_PREFIX
  )
  const exit = ORCAD_WINDOWS_RUNTIME_MISSING_EXIT
  return [
    `try { $orcadSha = [IO.File]::ReadAllText(${powerShellLiteral(marker)}).Trim() } catch { exit ${exit} }`,
    // Why validate: the digest becomes a path segment, so only a bare sha256 may reach it.
    `if ($orcadSha -cnotmatch '^[0-9a-f]{64}$') { exit ${exit} }`,
    `$orcadRuntime = ${powerShellLiteral(prefix)} + $orcadSha + ${powerShellLiteral(`/${ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE}`)}`,
    `if (-not (Test-Path -LiteralPath $orcadRuntime -PathType Leaf)) { exit ${exit} }`
  ]
}

function runLine(runtime: string, nodeArgs: readonly string[]): string {
  return [`& ${runtime}`, ...nodeArgs.map(powerShellNativeArg)].join(' ')
}

/** Runs the slot's own pinned node.exe; the exit code passes through. */
export function orcadWindowsSlotNodeCommand(
  host: RemoteHostPlatform,
  slotDir: string,
  nodeArgs: readonly string[]
): string {
  return powerShellCommand(
    [
      ...orcadWindowsSlotRuntimeLines(host, slotDir),
      runLine('$orcadRuntime', nodeArgs),
      'exit $LASTEXITCODE'
    ].join('\n')
  )
}

/** Runs a named node.exe, for host records that belong to no slot. */
export function orcadWindowsNodeCommand(nodePath: string, nodeArgs: readonly string[]): string {
  return powerShellCommand(
    [runLine(powerShellLiteral(nodePath), nodeArgs), 'exit $LASTEXITCODE'].join('\n')
  )
}

/** JS expression writing `marker base64(buffer)` and exiting 0. */
export function orcadWindowsEncodedAnswerJs(marker: string, bufferExpression: string): string {
  return `process.stdout.write(${JSON.stringify(`${marker} `)}+(${bufferExpression}).toString("base64")+"\\n",()=>process.exit(0))`
}

/** The decoded payload after `marker`, or null when the host printed no such line. */
export function readOrcadWindowsEncodedAnswer(output: string, marker: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate === marker || candidate.startsWith(`${marker} `))
  if (line === undefined) {
    return null
  }
  const encoded = line.slice(marker.length).trim()
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    return null
  }
  return Buffer.from(encoded, 'base64').toString('utf8')
}
