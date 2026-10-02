import { posix } from 'node:path'
import { quotePosixShell, RESOLVE_WSL_LOGIN_SHELL } from '../../shared/wsl-login-shell-command'
import type { WslLaunchDirectory } from '../../shared/wsl-launch-directory'
import type { LaunchFile } from '../../shared/launch-prompt-file'
import { spawnNeedsWslLaunchDirectory } from '../../shared/launch-file-writing'
import type { TuiAgent } from '../../shared/tui-agent'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'

const ORCA_CACHE_RELATIVE = '.cache/orca'

const probes = new Map<string, Promise<WslLaunchDirectory | undefined>>()

/** A failed probe is answered from memory this long, so a broken distro does not cost every spawn
 *  a `wsl.exe` round trip, yet a distro that comes back is found again. */
export const WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS = 30_000

/** The directory for a spawn that needs one (`spawnNeedsWslLaunchDirectory`); no probe, and no
 *  await for the caller, otherwise. */
export function resolveSpawnWslLaunchDirectory(
  distro: string | null | undefined,
  spawn: {
    command?: string
    launchFile?: LaunchFile
    launchAgent?: TuiAgent
    attachOnly?: boolean
  }
): Promise<WslLaunchDirectory | undefined> | undefined {
  const needed =
    Boolean(distro) &&
    spawn.attachOnly !== true &&
    spawnNeedsWslLaunchDirectory({
      ...spawn,
      orcaBuiltLine: spawn.launchAgent !== undefined
    })
  return needed ? resolveWslLaunchDirectory(distro) : undefined
}

/**
 * The distro directory a WSL spawn's staged line and launch file are written to, and the login
 * shell the pane runs, which decides how a staged line is sourced; undefined when the distro cannot
 * be asked, and the write site then refuses a launch that needs one. Probed once per distro; a
 * success is kept, a failure for `WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS`.
 */
export async function resolveWslLaunchDirectory(
  distro: string | null | undefined
): Promise<WslLaunchDirectory | undefined> {
  if (process.platform !== 'win32' || !distro) {
    return undefined
  }
  let probe = probes.get(distro)
  if (!probe) {
    probe = probeWslLaunchDirectory(distro)
    probes.set(distro, probe)
    const pending = probe
    void pending.then((found) => {
      if (!found) {
        setTimeout(() => {
          if (probes.get(distro) === pending) {
            probes.delete(distro)
          }
        }, WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS).unref?.()
      }
    })
  }
  return await probe
}

async function probeWslLaunchDirectory(distro: string): Promise<WslLaunchDirectory | undefined> {
  const script = [
    ...RESOLVE_WSL_LOGIN_SHELL,
    `_orca_root="$HOME"/${quotePosixShell(ORCA_CACHE_RELATIVE)}`,
    // Why chmod in the distro: files written over the UNC share take 9P's default mode, so the
    // 0700 directory is what keeps a launch file's prompt from other distro users.
    'mkdir -p "$_orca_root" && chmod 700 "$_orca_root" || exit 1',
    `printf '%s\\n%s\\n' "$HOME" "$_orca_wsl_shell"`
  ].join('\n')
  try {
    const result = await runWslProcess({
      distro,
      loginPath: 'none',
      script,
      shell: 'sh',
      timeoutMs: 10_000
    })
    const [home, shell] = result.stdout.split('\n').map((line) => line.trim())
    if (result.code !== 0 || !home?.startsWith('/') || home.includes('\\')) {
      return undefined
    }
    const linuxPath = posix.join(home, ORCA_CACHE_RELATIVE)
    return {
      distro,
      windowsPath: toWindowsWslUncPath(linuxPath, distro),
      linuxPath,
      ...(shell?.startsWith('/') ? { shell } : {})
    }
  } catch {
    return undefined
  }
}
