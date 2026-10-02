import { cachedPwshAvailability } from '../pwsh'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { localLaunchArtifactsWritable } from '../providers/local-launch-artifact-directory'
import { wslLaunchDirectoryKnownBroken } from '../providers/wsl-launch-directory-resolution'
import {
  describeLaunchHost,
  spawnedWindowsShell,
  type LaunchHost,
  type WindowsShellSettings
} from '../../shared/launch-host'

/** The host facts for a launch this Orca runs itself, locally or over its own SSH connection. */
export function thisOrcaLaunchHost(args: {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  settings: WindowsShellSettings
  /** The shell this launch asked for (`--shell`), which outranks the setting. */
  windowsShellOverride?: string | null
  /** Where the pane opens; a WSL path names the distro its line and file are written into. */
  workspacePath?: string
}): LaunchHost {
  const local = !args.isRemote && args.launchPlatform === 'win32' && process.platform === 'win32'
  return describeLaunchHost({
    launchPlatform: args.launchPlatform,
    isRemote: args.isRemote,
    hostPlatform: process.platform,
    paired: false,
    windowsPaneShell: local
      ? spawnedWindowsShell({
          settings: args.settings,
          windowsShellOverride: args.windowsShellOverride,
          pwshAvailable: cachedPwshAvailability()
        })
      : null,
    writesLaunchArtifacts: writesLaunchArtifacts(args)
  })
}

/** Whether this host can write the folder a staged line and a launch file go in. An SSH host's is
 *  the relay's, which this client cannot check. */
function writesLaunchArtifacts(args: {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
  workspacePath?: string
}): boolean {
  if (args.isRemote) {
    return true
  }
  if (process.platform === 'win32' && args.launchPlatform !== 'win32') {
    const distro = args.workspacePath ? parseWslUncPath(args.workspacePath)?.distro : undefined
    return !distro || !wslLaunchDirectoryKnownBroken(distro)
  }
  return localLaunchArtifactsWritable()
}
