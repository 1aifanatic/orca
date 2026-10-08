import { useCallback, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { ResumeMachineSection } from './NativeChatResumeOnRestartMachineSection'
import type { ResumeFailureAction } from './native-chat-resume-failure-guidance'
import { consumeNativeChatResumeOnRestartDialogRequest } from './native-chat-resume-on-restart-dialog'
import {
  continueNativeChatRestartOffers,
  dismissNativeChatRestartOffer
} from './native-chat-restart-offer-actions'
import { useNativeChatRestartResuming } from './native-chat-resume-on-restart-store'
import type { MachineView } from './native-chat-resume-machine-views'
import { useNativeChatResumeDialogOpening } from './native-chat-resume-dialog-opening'
import { actOnResumeRow } from './native-chat-resume-failure-action'
import { resumeOwnershipLabel } from './native-chat-resume-ownership'
import { resumeSelectionState } from './native-chat-resume-on-restart-grouping'
import {
  chosenResumeRows,
  dismissedRows,
  resumeRowKey,
  resumeRowSelectedByDefault,
  selectableResumeRows
} from './native-chat-resume-selection'

/**
 * What would be resumed, shown before anything runs — on every machine with chats to resume.
 *
 * Resuming reattaches a chat AND asks the agent to carry on, so the list is the point: the user
 * sees which chats each machine's last teardown recorded as mid-turn before a message goes
 * anywhere. Every string here has to say that a message is sent and that the user's own prompt is
 * not re-sent.
 *
 * Each machine is a row with a select-all box, opening onto its workspaces and chats; every box,
 * from Select all down to each chat, sits in one left column. The user's own chats start ticked;
 * chats another device, an automation or the server itself started are listed unticked with where
 * they came from, and Select all counts and ticks them like any other. Only this computer, alone,
 * keeps the flat list.
 *
 * The "don't ask again" box removes the PROMPT, never a safety check — an opted-in launch or
 * reconnect calls the same RPC, which re-derives the same predicate and staggers the same way.
 *
 * Resume closes the dialog at once and the status-bar entry carries the run, then any chat it could
 * not carry on. A chat an earlier resume could not carry on is listed too, as the same row plus
 * what went wrong and what to do; selecting it and resuming is a retry. Row actions act on their
 * row and leave the dialog open. It closes only on the user's own way out, or once no machine has
 * anything left.
 *
 * Closing is a SNOOZE, so looking around before deciding cannot remove the recovery. Dismiss is the
 * explicit path that deletes the durable records, and only the user's own; any other chat ends when
 * it moves on, when its tab is closed, or by its own row's dismiss.
 */

/** Says where the chats were cut off: on several machines, by this computer's update, or its close. */
function resumeDialogBody(flat: boolean, interruptedByUpdate: boolean): string {
  if (!flat) {
    return translate(
      'auto.components.NativeChatResumeOnRestartModal.machinesBody',
      'These chats were working when Orca on their machine closed or installed an update. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
    )
  }
  return interruptedByUpdate
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.updateBody',
        'These chats were working when Orca installed an update. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.body',
        'These chats were working when Orca closed. Resuming restores each one where it stopped, with its full context, and asks the agent to check what it was doing before carrying on. Your own prompt is not re-sent.'
      )
}

/** Mid-run with nothing left to choose, the button says the run is going rather than "Resume 0". */
function resumeButtonLabel(chosenCount: number, running: boolean): string {
  if (chosenCount === 0 && running) {
    return translate('auto.components.NativeChatResumeOnRestartModal.resuming', 'Resuming…')
  }
  return chosenCount === 1
    ? translate('auto.components.NativeChatResumeOnRestartModal.resumeSelectedOne', 'Resume 1 chat')
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.resumeSelected',
        'Resume {{value0}} chats',
        { value0: chosenCount }
      )
}

/** Up/Down step between the list's checkboxes; Space toggles the focused one natively. */
function moveCheckboxFocus(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return
  }
  const target = event.target
  if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'checkbox') {
    return
  }
  const boxes = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="checkbox"]:not(:disabled)')
  ]
  const next = boxes[boxes.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)]
  event.preventDefault()
  next?.focus()
}

export function NativeChatResumeOnRestartModal(): React.JSX.Element | null {
  const { machines, request, showing } = useNativeChatResumeDialogOpening()
  const updateSettings = useAppStore((store) => store.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const resumeButtonRef = useRef<HTMLButtonElement>(null)
  // The store's: the resume outlives this dialog, which can close or reopen mid-run. Busy is per
  // machine, so one slow server never locks this computer's chats.
  const resuming = useNativeChatRestartResuming()
  const allBusy = machines.length > 0 && machines.every((machine) => resuming.has(machine.machine))
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [expandedOverrides, setExpandedOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )
  // Each opening starts from the rows' defaults. This component never unmounts, so an untick made
  // before a close would otherwise greet a reopen, e.g. as "Resume 0 chats" over what a run left.
  // Keyed on the request and the machine it was opened for.
  const opening = request ? `open\u0000${request.focus ?? ''}` : null
  const [openedWith, setOpenedWith] = useState(opening)
  if (openedWith !== opening) {
    setOpenedWith(opening)
    if (opening) {
      setOverrides(new Map())
      setExpandedOverrides(new Map())
    }
  }
  const chosen = useMemo(
    () =>
      machines
        .filter((machine) => !resuming.has(machine.machine))
        .map((machine) => ({ machine, ids: chosenResumeRows(machine, overrides) })),
    [machines, overrides, resuming]
  )
  const dismissals = useMemo(
    () =>
      machines
        .filter((machine) => !resuming.has(machine.machine))
        .map((machine) => ({ machine, ids: dismissedRows(machine) })),
    [machines, resuming]
  )
  // "Dismiss all" only when it clears every chat listed; any chat not the user's own (another
  // device's, an automation's, the server's, or one whose owner the host could not say) stays, and
  // the button must not claim otherwise. With nothing of the user's listed it clears nothing, so it
  // stays put but disabled; each such row's own dismiss is the way out.
  const dismissesEverything = dismissals.every(
    (entry) => entry.ids.length === entry.machine.rows.length
  )
  const dismissesNothing = dismissals.every((entry) => entry.ids.length === 0)
  const chosenCount = chosen.reduce((total, entry) => total + entry.ids.length, 0)
  // One Select all across machines, over every chat a tick can name on a machine not mid-resume;
  // with every machine mid-resume it shows the run, as the rows below do, and stays disabled.
  const allSelection = useMemo(() => {
    const counted = allBusy
      ? machines.map((machine) => ({ machine, ids: resuming.get(machine.machine) ?? [] }))
      : chosen
    const keys = counted.flatMap(({ machine }) =>
      selectableResumeRows(machine).map((sessionId) => resumeRowKey(machine.identity, sessionId))
    )
    const ticked = new Set(
      counted.flatMap(({ machine, ids }) => ids.map((id) => resumeRowKey(machine.identity, id)))
    )
    return { keys, state: resumeSelectionState(keys, ticked) }
  }, [allBusy, chosen, machines, resuming])

  const toggle = useCallback((identity: string, sessionId: string, checked: boolean) => {
    setOverrides((current) => new Map(current).set(resumeRowKey(identity, sessionId), checked))
  }, [])
  const setTicks = useCallback((keys: readonly string[], checked: boolean) => {
    setOverrides((current) => {
      const next = new Map(current)
      for (const key of keys) {
        next.set(key, checked)
      }
      return next
    })
  }, [])

  /** Applied on whichever action the user takes, so the box means the same thing every way out. */
  const persistPreference = useCallback(async (): Promise<void> => {
    if (dontAskAgain) {
      await updateSettings({ nativeChatResumeWorkOnRestart: true }).catch(() => undefined)
    }
  }, [dontAskAgain, updateSettings])

  /** Closing is a snooze: each host keeps its offer and the status bar keeps the way back. */
  const snooze = useCallback((): void => {
    consumeNativeChatResumeOnRestartDialogRequest()
    void persistPreference()
  }, [persistPreference])

  const dismissAll = async (): Promise<void> => {
    void persistPreference()
    // Bookkeeping never gates the user's own action: the dialog closes here whatever each host
    // answers, rather than being trapped open behind a rejected promise.
    consumeNativeChatResumeOnRestartDialogRequest()
    await Promise.all(
      dismissals
        .filter((entry) => entry.ids.length > 0)
        .map((entry) => dismissNativeChatRestartOffer(entry.machine.machine, entry.ids))
    )
  }

  const actOnFailure = (machine: MachineView, action: ResumeFailureAction, sessionId: string) =>
    actOnResumeRow(machine, action, sessionId, persistPreference)

  if (!request || !showing) {
    return null
  }

  const flat = machines.length === 1 && machines[0]!.offer.target.kind === 'local'
  const rowsAcrossMachines = machines.flatMap((machine) => machine.rows)
  const interruptedByUpdate = rowsAcrossMachines.some((row) => row.trigger === 'update')
  const tickedFor = (machine: MachineView): ReadonlySet<string> =>
    new Set(
      // Mid-run the ticks show what is running; this opening's own ticks may name chats left out.
      resuming.get(machine.machine) ?? chosen.find((entry) => entry.machine === machine)?.ids ?? []
    )
  const originLabelFor = (machine: MachineView) => (sessionId: string) =>
    resumeOwnershipLabel(machine.ownershipFor(sessionId), machine.name)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          snooze()
        }
      }}
    >
      {/* Height is capped, never the data: the list scrolls inside the dialog so the header and
          the primary action stay put however many chats were interrupted. */}
      {/* Wide enough for a nested chat row to keep its name, model and age on one line. */}
      <DialogContent
        className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-3xl max-h-[85vh]"
        // Keep the scrollable list out of initial focus, including while Resume is disabled.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const resumeButton = resumeButtonRef.current
          if (resumeButton && !resumeButton.disabled) {
            resumeButton.focus()
          } else if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {/* Plain wrapper owns the icon spacing; DialogTitle owns its own. */}
            <span className="flex items-center gap-2">
              <RotateCcw className="size-4 text-muted-foreground" />
              {translate(
                'auto.components.NativeChatResumeOnRestartModal.title',
                'Resume interrupted chats?'
              )}
            </span>
          </DialogTitle>
          <DialogDescription>{resumeDialogBody(flat, interruptedByUpdate)}</DialogDescription>
        </DialogHeader>

        <div
          role="group"
          tabIndex={0}
          aria-label={translate(
            'auto.components.NativeChatResumeOnRestartModal.listLabel',
            'Chats that would be resumed'
          )}
          // The sidebar's own surface, so its workspaces read here as they do there.
          className="min-h-0 overflow-y-auto scrollbar-sleek rounded-md bg-worktree-sidebar pt-1 pb-1.5"
          onKeyDown={moveCheckboxFocus}
        >
          {/* Here, not in the groups or machine rows: one Select all for every machine listed. */}
          <label className="group/row grid h-7 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] items-center has-[:disabled]:cursor-default">
            <span className="flex justify-center">
              <Checkbox
                checked={allSelection.state.checked}
                disabled={allBusy || allSelection.state.total === 0}
                // Ticks everything unless all already are, as a workspace's box does.
                onCheckedChange={() =>
                  setTicks(
                    allSelection.keys,
                    allSelection.state.selectedCount < allSelection.state.total
                  )
                }
                aria-label={translate(
                  'auto.components.NativeChatResumeOnRestartModal.selectAll',
                  'Select all chats'
                )}
              />
            </span>
            <span className="mr-1.5 flex h-full min-w-0 items-center gap-1.5 pr-2.5 pl-2 group-hover/row:bg-worktree-sidebar-accent">
              <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.selectAllLabel',
                  'Select all'
                )}
              </span>
              <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.selectedCount',
                  '{{value0}} of {{value1}} selected',
                  { value0: allSelection.state.selectedCount, value1: allSelection.state.total }
                )}
              </span>
            </span>
          </label>
          {flat ? (
            <ResumeOnRestartGroups
              candidates={machines[0]!.rows}
              listedAt={machines[0]!.offer.listedAt}
              busy={resuming.has(machines[0]!.machine)}
              selected={tickedFor(machines[0]!)}
              onToggle={(sessionId, checked) => toggle(machines[0]!.identity, sessionId, checked)}
              failureFor={machines[0]!.failureFor}
              onFailureAction={(action, sessionId) =>
                void actOnFailure(machines[0]!, action, sessionId)
              }
              originLabelFor={originLabelFor(machines[0]!)}
            />
          ) : (
            <div className="flex flex-col">
              {machines.map((machine) => {
                const ticked = tickedFor(machine)
                const selectable = selectableResumeRows(machine)
                // Opened for this machine, or nothing on it starts ticked (so its empty box is
                // explained), or it is the only machine listed.
                const expandedByDefault =
                  request.focus === machine.machine ||
                  machines.length === 1 ||
                  !machine.rows.some((row) =>
                    resumeRowSelectedByDefault(
                      machine.ownershipFor(row.sessionId),
                      machine.failureFor(row.sessionId)
                    )
                  )
                return (
                  <ResumeMachineSection
                    key={machine.identity}
                    offer={machine.offer}
                    name={machine.name}
                    expanded={expandedOverrides.get(machine.identity) ?? expandedByDefault}
                    onExpandedChange={(expanded) =>
                      setExpandedOverrides((current) =>
                        new Map(current).set(machine.identity, expanded)
                      )
                    }
                    selected={ticked}
                    selectable={selectable}
                    busy={resuming.has(machine.machine)}
                    onToggle={(sessionId, checked) => toggle(machine.identity, sessionId, checked)}
                    onToggleAll={(checked) =>
                      setTicks(
                        selectable.map((sessionId) => resumeRowKey(machine.identity, sessionId)),
                        checked
                      )
                    }
                    failureFor={machine.failureFor}
                    onFailureAction={(action, sessionId) =>
                      void actOnFailure(machine, action, sessionId)
                    }
                    originLabelFor={originLabelFor(machine)}
                  />
                )
              })}
            </div>
          )}
        </div>

        {/* Two controls: one deletes the offers, one acts on them. Closing snoozes, so it needs none. */}
        <DialogFooter className="sm:items-center">
          {/* Why order-last: the narrow footer stacks bottom-up, so this keeps the option above the actions. */}
          <label className="order-last flex min-w-0 items-start gap-2.5 sm:order-none sm:mr-auto">
            <Checkbox
              checked={dontAskAgain}
              disabled={allBusy}
              onCheckedChange={(next) => setDontAskAgain(next === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.dontAskAgain',
                  "Don't ask again (resume automatically)"
                )}
              </span>
              {/* Where to undo it; what it does is the body copy's job. */}
              <span className="block text-xs text-muted-foreground">
                {translate(
                  'auto.components.NativeChatResumeOnRestartModal.dontAskAgainHint',
                  'You can turn this off in Settings → Experimental → Chat UI.'
                )}
              </span>
            </span>
          </label>
          {/* Quiet, explicit cleanup of the durable records. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={allBusy || dismissesNothing}
            onClick={() => void dismissAll()}
          >
            {dismissesEverything
              ? translate(
                  'auto.components.NativeChatResumeOnRestartModal.dismissAll',
                  'Dismiss all'
                )
              : translate('auto.components.NativeChatResumeOnRestartModal.dismiss', 'Dismiss')}
          </Button>
          <Button
            ref={resumeButtonRef}
            variant="default"
            size="sm"
            disabled={chosenCount === 0}
            onClick={() => {
              // Resume hands the run to the status bar, and its result to one notice.
              consumeNativeChatResumeOnRestartDialogRequest()
              void persistPreference()
              void continueNativeChatRestartOffers(
                chosen.map((entry) => ({ machine: entry.machine.machine, sessionIds: entry.ids }))
              )
            }}
          >
            {resumeButtonLabel(chosenCount, resuming.size > 0)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
