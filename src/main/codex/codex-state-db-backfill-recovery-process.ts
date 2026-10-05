import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { buildWslCodexAppServerArgs } from '../codex-accounts/wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import { createProviderSpawnSpec } from './codex-app-server-posix-supervisor'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import { stopSupervisedChildProcess } from './supervised-child-process-stop'

export type CodexBackfillRecoveryProcess = { child: ChildProcessHandle; supervised: boolean }

/** Starts the read-only app-server whose presence lets Codex finish its own backfill. */
export function spawnCodexBackfillRecoveryProcess(
  codexHomePath: string,
  spawnProcess: CodexAppServerSpawn,
  resolveCommand: () => string
): CodexBackfillRecoveryProcess {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  if (wslHome) {
    const child = spawnProcess(
      'wsl.exe',
      buildWslCodexAppServerArgs(
        wslHome.distro,
        wslHome.linuxPath,
        CODEX_READ_ONLY_APP_SERVER_ARGS
      ),
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: process.env
      }
    )
    return { child, supervised: false }
  }
  const command = resolveCommand()
  // Kept alive up to an hour; on POSIX the supervisor stops it with Orca, however Orca exits.
  const spawnSpec = createProviderSpawnSpec(
    { command, args: [...CODEX_READ_ONLY_APP_SERVER_ARGS], cwd: codexHomePath },
    withCliRuntimeOnPath(command, { ...process.env, CODEX_HOME: codexHomePath }),
    process.platform,
    { lifetime: 'session' }
  )
  const child = spawnProcess(spawnSpec.program, spawnSpec.args, {
    cwd: codexHomePath,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: spawnSpec.env,
    ...(spawnSpec.supervised ? { detached: true } : {})
  })
  return { child, supervised: spawnSpec.supervised }
}

export async function stopCodexBackfillRecoveryProcess(
  child: ChildProcessHandle,
  supervised: boolean
): Promise<void> {
  if (supervised) {
    // A session supervisor turns stdin end into its group stop, as a Codex connection close does.
    await stopSupervisedChildProcess(child, () => child.stdin?.end())
    return
  }
  await terminateCodexProbeChild(child)
}
