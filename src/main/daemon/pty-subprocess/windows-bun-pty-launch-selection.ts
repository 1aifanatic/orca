import type { BunPtySpawnArgs, BunRuntime, SpawnBunPtyDeps } from './bun-pty-process-contract'
import { supportsWindowsDirectJobSpawn } from './windows-bun-direct-job-spawn'
import {
  createWindowsBunPtyJob,
  prepareWindowsBunPtyJob,
  type PreparedWindowsBunPtyJob,
  type WindowsBunPtyJob
} from './windows-bun-pty-job'
import {
  createWindowsBunPtyLaunch,
  createWindowsDirectBunPtyLaunch,
  type WindowsBunPtyLaunch
} from './windows-bun-pty-launch'

/** Prefers a shell born inside its job; falls back to the resident gate on stock runtimes. */
export function selectWindowsBunPtyLaunch(
  args: BunPtySpawnArgs,
  runtime: BunRuntime,
  deps: SpawnBunPtyDeps
): { launch: WindowsBunPtyLaunch; preparedJob: PreparedWindowsBunPtyJob | null } {
  if (!(deps.supportsDirectJobSpawn ?? supportsWindowsDirectJobSpawn)(runtime)) {
    return {
      launch: (deps.createWindowsLaunch ?? createWindowsBunPtyLaunch)(args),
      preparedJob: null
    }
  }
  const preparedJob = (deps.prepareJob ?? prepareWindowsBunPtyJob)(
    undefined,
    args.windowsJobKillOnClose === true
  )
  if (!preparedJob) {
    throw new Error('Windows Bun PTY job ownership is unavailable')
  }
  try {
    return { launch: createWindowsDirectBunPtyLaunch(args), preparedJob }
  } catch (error) {
    preparedJob.discard()
    throw error
  }
}

/** Adopts the prepared job only if the shell is really inside it; otherwise assigns the gate. */
export function acquireWindowsBunPtyJob(
  pid: number,
  preparedJob: PreparedWindowsBunPtyJob | null,
  args: BunPtySpawnArgs,
  deps: SpawnBunPtyDeps
): WindowsBunPtyJob | null {
  return preparedJob
    ? preparedJob.adopt(pid)
    : (deps.createJob ?? createWindowsBunPtyJob)(
        pid,
        undefined,
        args.windowsJobKillOnClose === true
      )
}
