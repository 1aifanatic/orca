import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import { supportsProviderProcessLocation } from '../provider-process/provider-location-support'

export function supportsCodexStructuredLocation(
  location: AgentSessionExecutionLocation,
  // Injected by the adapter, which owns this dep for every other Codex gate too.
  hasWindowsProcessStartTimeProof: () => boolean = isWindowsProcessStartTimeAvailable
): boolean {
  return supportsProviderProcessLocation(location, hasWindowsProcessStartTimeProof)
}
