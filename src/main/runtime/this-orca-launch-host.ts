import { describeLaunchHost, type LaunchHost } from '../../shared/launch-host'

/** The host facts for a launch this Orca runs itself, locally or over its own SSH connection. */
export function thisOrcaLaunchHost(args: {
  launchPlatform: NodeJS.Platform
  isRemote: boolean
}): LaunchHost {
  return describeLaunchHost({ ...args, hostPlatform: process.platform, paired: false })
}
