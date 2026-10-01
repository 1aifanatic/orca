import { agentResumeIdentitiesEqual } from '../../../../shared/agent-resume-identity'
import { launchConfigsEqual } from '../../../../shared/sleeping-agent-launch-config'
export { launchConfigsEqual } from '../../../../shared/sleeping-agent-launch-config'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'

export function sleepingRecordsEquivalentIgnoringCaptureTime(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.paneKey === next.paneKey &&
    existing.tabId === next.tabId &&
    existing.worktreeId === next.worktreeId &&
    existing.agent === next.agent &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    agentResumeIdentitiesEqual(
      existing.providerSession.resumeIdentity,
      next.providerSession.resumeIdentity
    ) &&
    existing.prompt === next.prompt &&
    existing.state === next.state &&
    existing.updatedAt === next.updatedAt &&
    existing.terminalTitle === next.terminalTitle &&
    existing.lastAssistantMessage === next.lastAssistantMessage &&
    agentMainAgentVerdict(existing) === agentMainAgentVerdict(next) &&
    existing.origin === next.origin &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

export function recoveryRecordMatches(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  // Why: completion or interruption must replace a pre-status working checkpoint.
  return (
    existing.origin === next.origin &&
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    existing.state === next.state &&
    agentMainAgentVerdict(existing) === agentMainAgentVerdict(next) &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    agentResumeIdentitiesEqual(
      existing.providerSession.resumeIdentity,
      next.providerSession.resumeIdentity
    ) &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

export function recoveryRecordTargetsSameSession(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession)
  )
}
