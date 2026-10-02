import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import { isWebClientLocation } from './web-client-location'

/**
 * Whether the host a launch lands on writes the launch file its line names. A paired host (another
 * Orca this client drives) is sent a command and never the file, so a prompt that would need one is
 * pasted after the agent is ready instead. Temporary, until paired hosts are sent the prompt itself.
 */
export function launchHostWritesLaunchFile(
  ownerSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): boolean {
  return !isWebClientLocation() && getActiveRuntimeTarget(ownerSettings).kind === 'local'
}
