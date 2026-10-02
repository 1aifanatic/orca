/**
 * Waiting for a launched orcad's readiness line on the host, not across SSH.
 *
 * The client used to re-read the readiness file every 500 ms, one exec each, for up to three
 * minutes. On Windows every exec is a powershell.exe, and a burst of short-lived interpreters
 * under sshd is itself an EDR signal (docs/reference/windows-edr-posture.md). One exec now
 * waits host-side for a complete line, an oversized file, or its own bounded deadline.
 */
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  ORCAD_READINESS_FILENAME,
  ORCAD_READINESS_MAX_BYTES,
  parseOrcadReadinessOutput,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  orcadWindowsEncodedAnswerJs,
  orcadWindowsSlotNodeCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'

/** Under the 30 s exec timeout, so one wait never reads as an unanswered host. */
export const ORCAD_READINESS_WAIT_MAX_SECONDS = 20
export const ORCAD_WINDOWS_READINESS_MARKER = '__ORCAD_READINESS__'

/** Settles on a newline (a finished line) or more than the cap; both are final for the parser. */
function posixReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const file = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  const read = `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${file} 2>/dev/null`
  return [
    // Fractional sleep is not POSIX; probe it once so the deadline stays in seconds either way.
    'if sleep 0.25 2>/dev/null; then orcad_readiness_wait_step=0.25; orcad_readiness_wait_per=4;',
    'else orcad_readiness_wait_step=1; orcad_readiness_wait_per=1; fi;',
    `orcad_readiness_wait_left=$((${waitSeconds} * orcad_readiness_wait_per));`,
    'while [ "$orcad_readiness_wait_left" -gt 0 ]; do',
    `[ "$(${read} | wc -l)" -gt 0 ] && break;`,
    `[ "$(${read} | wc -c)" -gt ${ORCAD_READINESS_MAX_BYTES} ] && break;`,
    'sleep "$orcad_readiness_wait_step";',
    'orcad_readiness_wait_left=$((orcad_readiness_wait_left - 1)); done;',
    `${read} || true`
  ].join(' ')
}

export const ORCAD_WINDOWS_READINESS_WAIT_JS = [
  'const fs=require("fs");',
  'const [file,capArg,waitArg]=process.argv.slice(1);',
  'const cap=Number(capArg),end=Date.now()+Number(waitArg)*1000;',
  // A missing or unreadable file is "nothing yet", exactly as `head ... || true` reads it.
  'const read=()=>{let fd;try{fd=fs.openSync(file,"r")}catch{return Buffer.alloc(0)}',
  'try{const b=Buffer.alloc(cap+1);return b.subarray(0,fs.readSync(fd,b,0,cap+1,0))}',
  'catch{return Buffer.alloc(0)}finally{fs.closeSync(fd)}};',
  'const tick=()=>{const b=read();',
  `if(b.includes(10)||b.length>cap||Date.now()>=end){${orcadWindowsEncodedAnswerJs(ORCAD_WINDOWS_READINESS_MARKER, 'b')};return}`,
  'setTimeout(tick,200)};',
  'tick();'
].join('')

export function orcadReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const seconds = Math.max(0, Math.min(ORCAD_READINESS_WAIT_MAX_SECONDS, Math.ceil(waitSeconds)))
  if (!isWindowsRemoteHost(host)) {
    return posixReadinessWaitCommand(host, remoteInstallDir, seconds)
  }
  return orcadWindowsSlotNodeCommand(host, remoteInstallDir, [
    '-e',
    ORCAD_WINDOWS_READINESS_WAIT_JS,
    joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME),
    String(ORCAD_READINESS_MAX_BYTES),
    String(seconds)
  ])
}

/** What the readiness file held when the host stopped waiting; `pending` if still unfinished. */
export function parseOrcadReadinessWaitOutput(
  host: RemoteHostPlatform,
  output: string
): OrcadReadinessParse {
  return parseOrcadReadinessOutput(
    isWindowsRemoteHost(host)
      ? (readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_READINESS_MARKER) ?? '')
      : output
  )
}
