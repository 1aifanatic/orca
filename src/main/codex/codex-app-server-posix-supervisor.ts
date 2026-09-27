import type { CodexAppServerLaunch } from './codex-app-server-connection'

/**
 * Time the provider gets to exit on its own after stdin ends or an owner signal, before SIGKILL.
 * Session recovery's SIGTERM window is sized from it; a longer launch grace must widen that too.
 */
export const DEFAULT_PROVIDER_SUPERVISOR_GRACE_MS = 1250
/** How long the supervisor waits for a SIGKILLed provider group to disappear. */
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1500

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid
// Orca can die before this runs; spawning then would start a provider nothing watches.
if (ownerGone()) process.exit(1)
const childEnv = { ...process.env }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true
})
let timer
let ownerShutdownTimer
let settling = false
const providerGroupExists = () => {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const waitForProviderGroupExit = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (providerGroupExists()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}
const reapOwnedProviderGroup = async () => {
  if (!child.pid) return false
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error && error.code !== 'ESRCH') return false
  }
  return waitForProviderGroupExit(${PROVIDER_GROUP_REAP_TIMEOUT_MS})
}
const terminateOwnedGroup = () => {
  if (settling) return
  settling = true
  clearInterval(timer)
  void reapOwnedProviderGroup().then((reaped) => process.exit(reaped ? 137 : 1))
}
const scheduleOwnerShutdown = () => {
  if (settling || ownerShutdownTimer) return
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(terminateOwnedGroup, spec.graceMs)
  ownerShutdownTimer.unref()
}
process.stdin.once('end', scheduleOwnerShutdown)
process.stdin.once('close', scheduleOwnerShutdown)
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const stream of [process.stdin, child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
const finishWithProviderOutcome = (code, signal) => {
  if (!signal) return process.exit(code ?? 1)
  // Re-raise with the default action; this supervisor's own handler would swallow it.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  finishWithProviderOutcome(code, signal)
}
// Whoever stops this pid is judging the provider by it: stay alive until the group is gone,
// so a dead supervisor always means a dead provider group.
const stopOnOwnerSignal = (signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  try { process.kill(-child.pid, signal) } catch {}
  void waitForProviderGroupExit(spec.graceMs)
    .then((exited) => exited || reapOwnedProviderGroup())
    .then((reaped) => (reaped ? finishWithProviderOutcome(null, signal) : process.exit(1)))
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stopOnOwnerSignal(signal))
timer = setInterval(() => {
  if (ownerGone()) terminateOwnedGroup()
}, 100)
timer.unref()
child.once('error', () => {
  clearInterval(timer)
  process.exit(127)
})
child.once('exit', (code, signal) => {
  void reapProviderExit(code, signal)
})
`

export type ProviderSupervisorOptions = {
  cwd?: string
  /** The process the supervisor serves; it must be the supervisor's parent. */
  ownerPid?: number
  graceMs?: number
}

export function supervisedPosixLaunch(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  {
    cwd = launch.cwd ?? process.cwd(),
    ownerPid = process.pid,
    graceMs = DEFAULT_PROVIDER_SUPERVISOR_GRACE_MS
  }: ProviderSupervisorOptions = {}
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      command: launch.command,
      args: launch.args,
      cwd,
      ownerPid,
      graceMs
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT],
    // Electron's executable needs Node mode for the inline supervisor. The
    // marker is removed above so providers never inherit Electron semantics.
    env: {
      ...childEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    }
  }
}

export function createProviderSpawnSpec(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { program: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; detached: boolean } {
  const supervised = platform === 'win32' ? null : supervisedPosixLaunch(launch, childEnv)
  return {
    program: supervised?.command ?? launch.command,
    args: supervised?.args ?? launch.args,
    env: supervised?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32'
  }
}
