/**
 * Is the orcad a Windows slot launched still running? LIVE / DEAD / UNKNOWN, as on POSIX.
 *
 * A PID is not an identity on Windows, so the launcher's record pairs it with the process
 * creation time and liveness needs both: the PID must be running (libuv's kill(pid, 0), which
 * opens the process and reads its exit code — what `Get-Process -Id` reports, without a second
 * interpreter) and the slot's process-tree addon must report the same creation time. A running
 * PID with another creation time is a reused PID, so the recorded process is gone. Anything the
 * host cannot answer is UNKNOWN, never DEAD: no handle, no addon, no record.
 */
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_WINDOWS_PROCESS_FILENAME } from './orcad-remote-host-support'
import { orcadWindowsSlotNodeCommand } from './orcad-remote-windows-node'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/**
 * Defines `orcadRecord(dir)` (the launcher's record, or null) and `orcadState(dir, record)`
 * ("alive" | "dead" | "unknown") for the liveness and stop scripts.
 */
export const ORCAD_WINDOWS_PROCESS_STATE_JS = [
  'const fs=require("fs"),path=require("path");',
  'function orcadRecord(dir){let r;',
  `try{r=JSON.parse(fs.readFileSync(path.join(dir,${JSON.stringify(ORCAD_WINDOWS_PROCESS_FILENAME)}),"utf8"))}catch{return null}`,
  'return r&&Number.isSafeInteger(r.pid)&&r.pid>0?r:null}',
  'function orcadState(dir,r){',
  // ESRCH is the only proof of absence; EPERM means some process holds the PID.
  'try{process.kill(r.pid,0)}catch(e){return e.code==="ESRCH"?"dead":"unknown"}',
  'if(typeof r.creationTimeMs!=="number")return "unknown";',
  'let created;',
  `try{created=require(path.join(dir,${JSON.stringify(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)})).getProcessCreationTime(r.pid)}catch{return "unknown"}`,
  'if(typeof created!=="number")return "unknown";',
  'return created===r.creationTimeMs?"alive":"dead"}'
].join('')

export const ORCAD_WINDOWS_LIVENESS_JS = [
  ORCAD_WINDOWS_PROCESS_STATE_JS,
  'const dir=process.argv[1];',
  'const r=orcadRecord(dir);',
  'const s=r?orcadState(dir,r):"unknown";',
  'process.stdout.write(s==="alive"?"LIVE":s==="dead"?"DEAD":"UNKNOWN");'
].join('')

export function windowsOrcadLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  return orcadWindowsSlotNodeCommand(host, remoteInstallDir, [
    '-e',
    ORCAD_WINDOWS_LIVENESS_JS,
    remoteInstallDir
  ])
}
