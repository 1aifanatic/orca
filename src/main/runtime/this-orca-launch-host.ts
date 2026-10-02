import { cachedPwshAvailability } from '../pwsh'
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
      : null
  })
}
