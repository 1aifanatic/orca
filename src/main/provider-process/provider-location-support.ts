import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

/** The runtime may supervise only processes it can identify on its execution host. */
export function supportsProviderProcessLocation(
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof: () => boolean = isWindowsProcessStartTimeAvailable
): boolean {
  return (
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform !== 'win32' || hasWindowsProcessStartTimeProof())
  )
}
