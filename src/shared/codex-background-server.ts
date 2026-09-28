// Codex's shared background server (its app-server daemon) runs a TUI's turns and subagents in its
// own process, so they keep running after the TUI exits ("Run in background"). An embedded Codex
// runs them in the TUI process, where they end with it, even when it is killed mid-turn.
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Why both: the server keeps the legacy name while its install lives under packages/standalone.
const SERVER_PID_FILES = ['daemon.pid', 'app-server.pid']

/** `<CODEX_HOME>` for a rollout at `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
function codexHomeOfRollout(rolloutPath: string): string | undefined {
  const sessionsDir = dirname(dirname(dirname(dirname(rolloutPath))))
  return basename(sessionsDir) === 'sessions' ? dirname(sessionsDir) : undefined
}

function serverPidAlive(pidFile: string): boolean {
  let record: unknown
  try {
    record = JSON.parse(readFileSync(pidFile, 'utf8'))
  } catch {
    return false
  }
  const pid = typeof record === 'object' && record !== null && 'pid' in record ? record.pid : null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: only ESRCH proves the pid is gone; EPERM is a live process we may not signal.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

/** Whether the shared background server of the Codex home this rollout belongs to is running,
 *  read from the pid record the server keeps under `<CODEX_HOME>/app-server-daemon`. A server
 *  killed without cleanup leaves its record behind, so the pid itself must be alive. */
export function codexBackgroundServerRunning(rolloutPath: string): boolean {
  const codexHome = codexHomeOfRollout(rolloutPath)
  return (
    codexHome !== undefined &&
    SERVER_PID_FILES.some((name) => serverPidAlive(join(codexHome, 'app-server-daemon', name)))
  )
}
