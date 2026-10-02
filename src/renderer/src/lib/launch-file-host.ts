import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { isWebClientLocation } from './web-client-location'

/**
 * Whether a launch lands on a paired Orca: another Orca this client drives, which may be an older
 * build that neither stages a long line nor writes a launch file. `carryLaunchPrompt` then keeps
 * the line to the typed budget and pastes the rest after the agent is ready. Temporary, until paired
 * hosts advertise both.
 */
export function launchHostIsPaired(runtimeEnvironmentId: string | null | undefined): boolean {
  return isWebClientLocation() || isWebRuntimeSessionActive(runtimeEnvironmentId)
}
