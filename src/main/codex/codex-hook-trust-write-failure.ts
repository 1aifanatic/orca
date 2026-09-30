import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { reportCodexHookTrustWriteRefusals } from './codex-config-toml-checked-edit'

// Why: a refused trust write recurs every launch until the user fixes the file; launch prep must not re-log it.
const reportedRefusalStatuses = new WeakSet<AgentHookInstallStatus>()

/** Returns `status` for trust entries that could not be written, logging a refused write once per file. */
export function reportCodexHookTrustWriteFailure(
  error: unknown,
  status: AgentHookInstallStatus
): AgentHookInstallStatus {
  if (reportCodexHookTrustWriteRefusals(error).length === 0) {
    reportedRefusalStatuses.add(status)
  }
  return status
}

export function isReportedCodexHookTrustWriteRefusal(status: AgentHookInstallStatus): boolean {
  return reportedRefusalStatuses.has(status)
}
