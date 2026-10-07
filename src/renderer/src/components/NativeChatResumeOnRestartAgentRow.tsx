import { Checkbox } from './ui/checkbox'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { translate } from '@/i18n/i18n'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'
import { ResumeFailureGuidanceLine, ResumeFailureStatus } from './NativeChatResumeFailureDetails'
import { resumeActivityLabel } from './native-chat-resume-activity-label'

/**
 * One offered chat as a row of the resume list: its checkbox in the list's shared left column, then,
 * indented for its depth, the provider glyph, "name - what it was doing", the model and an age —
 * the pieces of the sidebar's compact agent row.
 *
 * The sidebar's own `CompactAgentRow` cannot be reused — it takes a `DashboardAgentRow`, which
 * requires a live pane, tab and status entry, and every chat here is by definition stopped. The
 * pieces that do NOT need a live session are reused directly: `AgentIcon`, `agentTypeToIconAgent`,
 * `formatAgentTypeLabel`, `formatShortTimeAgo`, and the same model treatment (monospace, truncated,
 * hidden when empty).
 *
 * No state dot, deliberately. Every `AgentDotState` would mislead: `idle` and `unverifiable` both
 * presuppose a live pane, `interrupted` claims a stop or a newer message ended the turn, `failed`
 * a fault, `done` a finish, `working` a spinner. A missing dot beats a dot that says these agents
 * are running.
 *
 * After the name, what the chat was doing when Orca went away — mid-reply, waiting on the user,
 * subagents or monitoring — so rows the sidebar showed as working for different reasons differ.
 *
 * A chat an earlier resume could not carry on is the same row — selectable where a retry can run,
 * so Resume retries it — plus a status icon, a dismiss control, and a line saying what to do.
 *
 * The enclosing list sets `--resume-chat-indent` for the row's depth.
 */
export function ResumeCandidateRow({
  candidate,
  workspaceName,
  listedAt,
  checked,
  disabled,
  onCheckedChange,
  failure,
  onFailureAction
}: {
  candidate: ResumeCandidate
  /** Named in the checkbox's accessible name: several rows otherwise read identically. */
  workspaceName: string
  listedAt: number
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  /** Present when an earlier resume of this chat did not carry on. */
  failure?: ResumeFailure
  onFailureAction?: (action: ResumeFailureAction, sessionId: string) => void
}): React.JSX.Element {
  const agentLabel = formatAgentTypeLabel(candidate.agent)
  const title =
    candidate.latestPrompt.trim() ||
    translate('auto.components.NativeChatResumeOnRestartModal.untitled', 'Untitled chat')
  const model = candidate.model?.trim() ?? ''
  const activity = resumeActivityLabel(candidate.activity)
  const row = (
    <label className="grid h-7 min-w-0 flex-1 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] items-center hover:bg-worktree-sidebar-accent has-[:disabled]:cursor-default">
      <span className="flex justify-center">
        {/* Identifies the agent AND its workspace: the accessible name has to distinguish rows that
            would otherwise all read the same. */}
        <Checkbox
          checked={checked}
          disabled={disabled || (failure !== undefined && !resumeFailureSelectable(failure))}
          onCheckedChange={(next) => onCheckedChange(next === true)}
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.selectAgent',
            'Resume {{value0}} chat "{{value1}}" in {{value2}}',
            { value0: agentLabel, value1: title, value2: workspaceName }
          )}
        />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pr-2.5 pl-(--resume-chat-indent) text-[11px] leading-none text-muted-foreground">
        {/* AgentIcon carries no label of its own, so the provider was invisible to assistive tech. */}
        <span role="img" aria-label={agentLabel} className="inline-flex shrink-0">
          <AgentIcon agent={agentTypeToIconAgent(candidate.agent)} size={13} />
        </span>
        <span
          className="min-w-0 flex-1 truncate"
          title={activity ? `${title} - ${activity.detail || activity.summary}` : title}
        >
          <span className="text-foreground/90">{title}</span>
          {activity && <span className="text-muted-foreground/80"> - {activity.summary}</span>}
        </span>
        {model && (
          <span
            className="min-w-0 max-w-24 shrink-0 truncate font-mono text-[10px] text-muted-foreground/70"
            title={model}
          >
            {model}
          </span>
        )}
        {/* `formatShortTimeAgo` takes (timestamp, now) and subtracts internally — NOT a delta. */}
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          {formatShortTimeAgo(candidate.recordedAt, listedAt)}
        </span>
      </span>
    </label>
  )
  if (!failure) {
    return <li className="border-worktree-sidebar-border not-first:border-t">{row}</li>
  }
  const act = (action: ResumeFailureAction) => onFailureAction?.(action, candidate.sessionId)
  return (
    <li className="flex flex-col border-worktree-sidebar-border not-first:border-t">
      {/* Outside the label, so pressing them never toggles the checkbox. */}
      <div className="flex items-center gap-1 pr-1">
        {row}
        <ResumeFailureStatus
          failure={failure}
          title={title}
          workspaceName={workspaceName}
          disabled={disabled}
          onAction={act}
        />
      </div>
      {/* Lined up with the row's content, past the checkbox column. */}
      <div className="pr-2.5 pl-[calc(1.75rem+var(--resume-chat-indent,0px))]">
        <ResumeFailureGuidanceLine failure={failure} disabled={disabled} onAction={act} />
      </div>
    </li>
  )
}
