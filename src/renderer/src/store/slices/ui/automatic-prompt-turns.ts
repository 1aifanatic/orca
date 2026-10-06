/**
 * Turn-taking for dialogs the app opens by itself (resume offer, crash report, feature tip, tours).
 *
 * Exactly one automatic prompt is visible at a time and the next opens after it closes. Dialogs the
 * user opened, or that answer something in flight (an SSH credential, a confirmation), are never
 * scheduled: they only register as visible, and while any is up every automatic prompt waits. One
 * that was already showing is hidden and keeps its turn until they close.
 */

/** Lower goes first. The resume offer leads because it describes the restart the user just saw. */
export const AUTOMATIC_PROMPT_PRIORITY = {
  'native-chat-resume': 0,
  'crash-report': 1,
  'feature-tip': 2
} as const

export type AutomaticPromptId = keyof typeof AUTOMATIC_PROMPT_PRIORITY

/** Marks a modal-slot entry as an automatic prompt's own, so the slot alone never reads as a user
 *  modal that the prompt has to wait for. */
export const AUTOMATIC_PROMPT_MODAL_KEY = 'automaticPromptId'

/** How long automatic prompts wait at launch for this machine's resume read, measured from when the
 *  read starts. Local only; a remote host is never awaited. Expiry only changes the order: a resume
 *  offer read later still takes its turn after whatever went first. */
export const LAUNCH_PROMPT_DISCOVERY_BOUND_MS = 2000

/** The wait's backstop when the read never starts and nothing says none is needed (no bridge). */
export const LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS = 10_000

/** One queued item. `key` tells an owner's successive items apart, so each takes its own turn and
 *  being shown belongs to that item, never to the next one the same owner queues. */
export type AutomaticPromptRequest = Readonly<{
  id: AutomaticPromptId
  key: string | null
  seq: number
  /** Its dialog has been on screen. It keeps the turn until released, so a request with a higher
   *  priority that arrives later waits rather than replacing it. */
  shown: boolean
}>

export type PromptTurnState = {
  automaticPromptRequests: readonly AutomaticPromptRequest[]
  promptBlockingDialogIds: readonly string[]
  /** Mirrors lib/dialog-presence: a dialog other than an automatic prompt's own is rendered. */
  otherDialogOnScreen: boolean
  /** Mirrors lib/dialog-presence: a modal surface is showing its error fallback instead. */
  modalSurfaceFailed: boolean
  launchPromptDiscoveryPending: boolean
  /** When the launch wait ends regardless (epoch ms): the backstop from boot, then the bound from
   *  the start of the resume read. */
  launchPromptDiscoveryDeadline: number
}

type PromptTurnInputs = PromptTurnState & {
  activeModal: string
  modalData: Record<string, unknown>
  activeContextualTourId: string | null
}

/** Modal-slot entries that are a handoff, not a dialog: they render nothing while they hold the slot. */
const MODAL_SLOTS_WITHOUT_DIALOG: ReadonlySet<string> = new Set(['project-added'])

/** The user's modal counts from the moment it takes the slot, before its code has even loaded, so
 *  nothing opens in that gap; not once its surface failed, since then no dialog is coming. */
function modalSlotHeldByUser(state: PromptTurnInputs): boolean {
  return (
    state.activeModal !== 'none' &&
    state.modalData[AUTOMATIC_PROMPT_MODAL_KEY] === undefined &&
    !MODAL_SLOTS_WITHOUT_DIALOG.has(state.activeModal) &&
    !state.modalSurfaceFailed
  )
}

/** A user dialog or a response dialog is up; automatic prompts not yet shown wait behind it. */
export function selectUserDialogVisible(state: PromptTurnInputs): boolean {
  return (
    state.promptBlockingDialogIds.length > 0 ||
    state.otherDialogOnScreen ||
    modalSlotHeldByUser(state)
  )
}

function compareRequests(a: AutomaticPromptRequest, b: AutomaticPromptRequest): number {
  return AUTOMATIC_PROMPT_PRIORITY[a.id] - AUTOMATIC_PROMPT_PRIORITY[b.id] || a.seq - b.seq
}

/** The request whose dialog is rendered now. One already shown stays rendered under a dialog opened
 *  over it; AutomaticPromptDialogScope only hides it, so nothing it holds is lost. */
export function selectVisibleAutomaticPrompt(
  state: PromptTurnInputs
): AutomaticPromptRequest | null {
  const requests = state.automaticPromptRequests
  const shown = requests.find((request) => request.shown)
  if (shown) {
    return shown
  }
  if (selectUserDialogVisible(state)) {
    return null
  }
  // A running tour holds the turn; it never queues, so it starts only when nothing else is waiting.
  if (state.launchPromptDiscoveryPending || state.activeContextualTourId !== null) {
    return null
  }
  let first: AutomaticPromptRequest | null = null
  for (const request of requests) {
    if (first === null || compareRequests(request, first) < 0) {
      first = request
    }
  }
  return first
}

export function selectVisibleAutomaticPromptId(state: PromptTurnInputs): AutomaticPromptId | null {
  return selectVisibleAutomaticPrompt(state)?.id ?? null
}

/** Whether this owner's item, not just its prompt type, is the one to render. */
export function selectAutomaticPromptTurnHeld(
  state: PromptTurnInputs,
  id: AutomaticPromptId,
  key: string | null
): boolean {
  const visible = selectVisibleAutomaticPrompt(state)
  return visible !== null && visible.id === id && visible.key === key
}

/** The modal slot holds an automatic prompt that is not its turn; that modal stays hidden. */
export function selectAutomaticPromptSlotSuspended(state: PromptTurnInputs): boolean {
  const owner = state.modalData[AUTOMATIC_PROMPT_MODAL_KEY]
  return (
    state.activeModal !== 'none' &&
    owner !== undefined &&
    owner !== selectVisibleAutomaticPromptId(state)
  )
}

/** Whatever a running tour must give way to: something modal is on screen. */
export function selectPromptSurfaceVisible(state: PromptTurnInputs): boolean {
  return state.promptBlockingDialogIds.length > 0 || selectVisibleAutomaticPrompt(state) !== null
}

/**
 * Whether a tour may start. A tour the user asked for (forced) only yields to what is on screen; an
 * automatic one also waits for the launch read, since the prompts it may raise go first. A queued
 * prompt that cannot show yet (a user dialog holds the screen) does not hold back a tour inside it.
 */
export function selectTourBlockedByPrompts(state: PromptTurnInputs, forced: boolean): boolean {
  if (selectPromptSurfaceVisible(state)) {
    return true
  }
  return !forced && state.launchPromptDiscoveryPending
}
