import { ChevronDown, ChevronRight, Laptop, Server } from 'lucide-react'
import { Checkbox } from './ui/checkbox'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { resumeSelectionState, type ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { ResumeFailureAction } from './native-chat-resume-failure-guidance'
import type { NativeChatRestartMachineOffer } from './native-chat-resume-on-restart-store'
import { restartMachineExecutionHostId } from './native-chat-restart-machines'

/**
 * One machine in the resume dialog: a row naming it, why it stopped and how many of its chats are
 * picked, with its select-all box in the list's shared checkbox column and a chevron; open, the
 * machine's workspaces and chats below, their content indented one level.
 */
export function ResumeMachineSection({
  offer,
  name,
  expanded,
  onExpandedChange,
  selected,
  selectable,
  busy,
  onToggle,
  onToggleAll,
  failureFor,
  onFailureAction,
  originLabelFor
}: {
  offer: NativeChatRestartMachineOffer
  name: string
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /** The ticked chats on this machine. */
  selected: ReadonlySet<string>
  /** The chats a tick can include; a failure no retry can fix is left out. */
  selectable: readonly string[]
  busy: boolean
  onToggle: (sessionId: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  failureFor: (sessionId: string) => ResumeFailure | undefined
  onFailureAction: (action: ResumeFailureAction, sessionId: string) => void
  originLabelFor: (sessionId: string) => string | undefined
}): React.JSX.Element {
  const rows = [...offer.candidates, ...offer.failed]
  const selection = resumeSelectionState(selectable, selected)
  const latest = Math.max(...rows.map((row) => row.recordedAt))
  const cause = rows.some((row) => row.trigger === 'update')
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.machineCauseUpdate',
        'Installed an update'
      )
    : translate('auto.components.NativeChatResumeOnRestartModal.machineCauseQuit', 'Was quit')
  const MachineIcon = offer.target.kind === 'local' ? Laptop : Server
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <>
      {/* The header over this machine's boxes, never boxed itself: the project's band, in the
          content area, with its checkbox in the column outside. Twice the list's gap sets it off
          from the previous machine's boxes. */}
      <div className="group/row mt-3 grid h-8.5 grid-cols-[1.75rem_minmax(0,1fr)] items-center first:mt-1.5">
        <span className="flex justify-center">
          {/* Ticks everything unless all already are, as a workspace's box does. */}
          <Checkbox
            checked={selection.checked}
            disabled={busy || selection.total === 0}
            onCheckedChange={() => onToggleAll(selection.selectedCount < selection.total)}
            aria-label={translate(
              'auto.components.NativeChatResumeOnRestartModal.selectMachine',
              'Resume every chat on {{value0}}',
              { value0: name }
            )}
          />
        </span>
        <button
          type="button"
          className="mr-1.5 flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--foreground)_5%,var(--worktree-sidebar-accent))] pr-2.5 pl-2 text-left group-hover/row:bg-[color-mix(in_srgb,var(--foreground)_9%,var(--worktree-sidebar-accent))]"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          <MachineIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0 text-[13px] font-semibold">{name}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {cause} · {formatShortTimeAgo(latest, offer.listedAt)}
          </span>
          {selection.total > 0 && (
            <span className="shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.workspaceSelectedCount',
                '{{value0}} of {{value1}}',
                { value0: selection.selectedCount, value1: selection.total }
              )}
            </span>
          )}
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <ResumeOnRestartGroups
          candidates={rows}
          listedAt={offer.listedAt}
          busy={busy}
          selected={selected}
          onToggle={onToggle}
          failureFor={failureFor}
          onFailureAction={onFailureAction}
          originLabelFor={originLabelFor}
          machineHostId={restartMachineExecutionHostId(offer.target)}
        />
      )}
    </>
  )
}
