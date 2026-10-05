import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

export function supportsCodexStructuredLocation(
  location: AgentSessionExecutionLocation,
  // Injected by the adapter, which owns this dep for every other Codex gate too.
  hasWindowsProcessStartTimeProof: () => boolean = isWindowsProcessStartTimeAvailable
): boolean {
  return supportsSupervisedProviderChildLocation(location, hasWindowsProcessStartTimeProof)
}
