import { isKnownTimeZone } from '../../../shared/automations/scheduling/automation-schedule-calendar'
import { automationTerminalLaunchInputs } from '../../../shared/automations/launch/automation-launch-setup'
import { hostQualifiedRepoSelector } from '../../runtime/workspaces/catalog/runtime-repo-selector'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { buildAutomationWorkspaceProvenance } from '../../../shared/automations/ownership/automation-workspace-provenance'
import type { Repo } from '../../../shared/repository/repo-types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type HeadlessAutomationRunForWorkspace = Pick<AutomationRun, 'id' | 'title' | 'scheduledFor'>
type RuntimeCreateManagedWorktreeArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]

export function buildHeadlessAutomationWorkspaceName(
  runTitle: string,
  scheduledFor: number,
  timezone?: string | null
): string {
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const zone = timezone?.trim()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone && isKnownTimeZone(zone) ? zone : undefined,
    timeZoneName: 'longOffset',
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(scheduledFor)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  const stamp = `${part('year')}${part('month')}${part('day')}T${part('hour')}${part('minute')}`
  const offset = part('timeZoneName').replace('GMT', '').replaceAll(':', '') || 'Z'
  return `auto-${slug || 'run'}-${stamp}${offset}`
}

export function buildAutomationWorktreeCreateArgs({
  automation,
  run,
  repo,
  createdAt = Date.now()
}: {
  automation: Automation
  run: HeadlessAutomationRunForWorkspace
  repo: Repo
  createdAt?: number
}): RuntimeCreateManagedWorktreeArgs {
  const setup = automationTerminalLaunchInputs(automation)
  return {
    repoSelector: hostQualifiedRepoSelector(`id:${repo.id}`, getRepoExecutionHostId(repo)),
    name: buildHeadlessAutomationWorkspaceName(run.title, run.scheduledFor, automation.timezone),
    baseBranch: automation.baseBranch ?? undefined,
    setupDecision: automation.setupDecision ?? 'skip',
    // Only the approved content runs; a branch that changed it skips setup.
    ...(automation.setupTrustHash ? { approvedSetupHash: automation.setupTrustHash } : {}),
    activate: false,
    createdWithAgent: automation.agentId,
    startupAgent: automation.agentId,
    startupPrompt: automation.prompt,
    startupSuppressUpdatePrompt: true,
    startupTitle: run.title,
    ...(setup.extraAgentArgs ? { startupExtraAgentArgs: setup.extraAgentArgs } : {}),
    ...(setup.agentArgs !== undefined ? { startupAgentArgs: setup.agentArgs } : {}),
    ...(setup.sessionOptions ? { startupSessionOptions: setup.sessionOptions } : {}),
    telemetrySource: 'unknown',
    automationProvenance: buildAutomationWorkspaceProvenance(automation, run, repo, createdAt)
  }
}
