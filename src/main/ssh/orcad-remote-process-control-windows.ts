/**
 * Stopping a Windows orcad: the slot's stop-request file, never a signal.
 *
 * `kill -TERM` and `process.kill(pid, 'SIGTERM')` are TerminateProcess on Windows, which skips
 * the durable shutdown and leaves the instance lock behind, so a build whose readiness does not
 * advertise `health.stopRequests` is refused rather than terminated. The tokens and their
 * meaning match the POSIX command, plus UNSUPPORTED.
 */
import {
  ORCAD_STOP_REQUEST_FILENAME,
  ORCAD_STOP_REQUESTS_CAPABILITY
} from '../../shared/orcad-stop-request'
import { ORCAD_READINESS_FILENAME, ORCAD_READINESS_MAX_BYTES } from './orcad-remote-launch'
import { ORCAD_WINDOWS_PROCESS_STATE_JS } from './orcad-remote-liveness-windows'
import { orcadWindowsSlotNodeCommand } from './orcad-remote-windows-node'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export const ORCAD_WINDOWS_STOP_JS = [
  ORCAD_WINDOWS_PROCESS_STATE_JS,
  'const [dir,waitArg,launchedArg]=process.argv.slice(1);',
  'const answer=(t)=>process.stdout.write(t,()=>process.exit(0));',
  'const main=()=>{',
  'const r=orcadRecord(dir);',
  'if(!r)return answer("NO_PID");',
  'let ready=null;',
  `try{const fd=fs.openSync(path.join(dir,${JSON.stringify(ORCAD_READINESS_FILENAME)}),"r");`,
  `let b=Buffer.alloc(${ORCAD_READINESS_MAX_BYTES + 1});`,
  'try{b=b.subarray(0,fs.readSync(fd,b,0,b.length,0))}finally{fs.closeSync(fd)}',
  `if(b.length<=${ORCAD_READINESS_MAX_BYTES}){const line=b.toString("utf8").split("\\n").find((l)=>l.trim().startsWith("{"));ready=line?JSON.parse(line):null}}catch{ready=null}`,
  'if(ready&&ready.type==="orca_server_ready"){',
  // The readiness PID must corroborate the launcher's, so a reused PID is never addressed.
  'const h=ready.health||{};',
  'if(h.pid!==r.pid)return answer("UNKNOWN");',
  `if(h.stopRequests!==${ORCAD_STOP_REQUESTS_CAPABILITY})return answer("UNSUPPORTED");`,
  // A candidate this client just launched may not have published readiness yet; its listener
  // consumes a request written before it started.
  '}else if(launchedArg!=="1")return answer("UNKNOWN");',
  'const first=orcadState(dir,r);',
  'if(first==="dead")return answer("ALREADY_EXITED");',
  'if(first!=="alive")return answer("UNKNOWN");',
  `try{fs.writeFileSync(path.join(dir,${JSON.stringify(ORCAD_STOP_REQUEST_FILENAME)}),"",{mode:0o600})}catch{return answer("SIGNAL_FAILED")}`,
  'const end=Date.now()+Number(waitArg)*1000;',
  'const tick=()=>{const s=orcadState(dir,r);',
  'if(s==="dead")return answer("STOPPED");',
  'if(Date.now()>=end)return answer(s==="alive"?"STILL_RUNNING":"UNKNOWN");',
  'setTimeout(tick,250)};',
  'tick()};',
  'main();'
].join('')

export function windowsStopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  options: { waitSeconds: number; justLaunched: boolean }
): string {
  return orcadWindowsSlotNodeCommand(host, remoteInstallDir, [
    '-e',
    ORCAD_WINDOWS_STOP_JS,
    remoteInstallDir,
    String(options.waitSeconds),
    options.justLaunched ? '1' : '0'
  ])
}
