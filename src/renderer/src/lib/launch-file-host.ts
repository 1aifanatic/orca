import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { describeLaunchHost, type LaunchHost } from '../../../shared/launch-host'
import { isWebClientLocation } from './web-client-location'

/**
 * Whether a launch lands on a paired Orca: another Orca this client drives, which may be an older
 * build that neither stages a long line nor writes a launch file. Temporary, until paired hosts
 * advertise both.
 */
export function launchHostIsPaired(runtimeEnvironmentId: string | null | undefined): boolean {
  return isWebClientLocation() || isWebRuntimeSessionActive(runtimeEnvironmentId)
}

/** The host facts for a launch this client starts, from the environment it targets. */
export function clientLaunchHost(args: {
  runtimeEnvironmentId: string | null | undefined
  launchPlatform: NodeJS.Platform
  isRemote: boolean
}): LaunchHost {
  return describeLaunchHost({
    launchPlatform: args.launchPlatform,
    isRemote: args.isRemote,
    hostPlatform: CLIENT_PLATFORM,
    paired: launchHostIsPaired(args.runtimeEnvironmentId)
  })
}
