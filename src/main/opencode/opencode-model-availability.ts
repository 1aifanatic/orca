import { getFirstCommandToken } from '../../shared/command-token-scanner'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'

export async function probeOpenCodeModelAvailability(options: {
  command: string | undefined
  model: string
  env: NodeJS.ProcessEnv
  cwd?: string
  wsl?: { distro?: string }
}): Promise<boolean> {
  // WSL needs the same guest account/profile environment as its actual launch.
  if (options.wsl || !options.cwd) {
    return false
  }
  const executable = await resolveCommandOnLocalPath(getFirstCommandToken(options.command ?? ''), {
    env: options.env,
    cwd: options.cwd
  })
  if (!executable) {
    return false
  }
  try {
    const result = await runProcess({
      program: executable,
      args: ['models'],
      cwd: options.cwd,
      env: options.env,
      timeoutMs: 10_000,
      maxOutputBytes: 1_048_576
    })
    return (
      result.code === 0 &&
      !result.timedOut &&
      result.stdout.split(/\r?\n/).some((line) => line === options.model)
    )
  } catch {
    return false
  }
}
