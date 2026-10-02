import { posix } from 'node:path'
import { quotePosixShell, RESOLVE_WSL_LOGIN_SHELL } from '../../shared/wsl-login-shell-command'
import type { WslLaunchDirectory } from '../../shared/wsl-launch-directory'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'

const ORCA_CACHE_RELATIVE = '.cache/orca'

const probes = new Map<string, Promise<WslLaunchDirectory | undefined>>()

/**
 * The distro directory a WSL spawn's staged line and launch file are written to, and the login
 * shell the pane runs, which decides how a staged line is sourced; undefined when the distro cannot
 * be asked, and the write site then refuses a launch that needs one. Probed once per distro, and
 * only a success is kept.
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
    void probe.then((found) => found ?? probes.delete(distro))
  }
  return await probe
}

async function probeWslLaunchDirectory(distro: string): Promise<WslLaunchDirectory | undefined> {
  const script = [
    ...RESOLVE_WSL_LOGIN_SHELL,
    `_orca_root="$HOME"/${quotePosixShell(ORCA_CACHE_RELATIVE)}`,
    // Why chmod in the distro: files written over the UNC share take 9P's default mode, so the
    // 0700 directory is what keeps a worker brief from other distro users.
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
