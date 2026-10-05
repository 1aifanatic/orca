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

/** How long automatic prompts wait at launch for this machine's resume offer to be read. Local only;
 *  a remote host is never awaited. */
export const LAUNCH_PROMPT_DISCOVERY_BOUND_MS = 2000

export type AutomaticPromptRequest = Readonly<{ id: AutomaticPromptId; seq: number }>

export type PromptTurnState = {
  automaticPromptRequests: readonly AutomaticPromptRequest[]
  /** The prompt that has actually been displayed. It keeps the turn until released, so a request
   *  with a higher priority that arrives later waits rather than replacing it. */
  automaticPromptShownId: AutomaticPromptId | null
  promptBlockingDialogIds: readonly string[]
  launchPromptDiscoveryPending: boolean
  /** When the launch wait ends regardless (epoch ms), fixed at boot. */
  launchPromptDiscoveryDeadline: number
}

type PromptTurnInputs = PromptTurnState & {
  activeModal: string
  modalData: Record<string, unknown>
  activeContextualTourId: string | null
}

function modalSlotHeldByUser(state: PromptTurnInputs): boolean {
  return state.activeModal !== 'none' && state.modalData[AUTOMATIC_PROMPT_MODAL_KEY] === undefined
}

/** A user dialog or a response dialog is up; automatic prompts wait behind it. */
export function selectUserDialogVisible(state: PromptTurnInputs): boolean {
  return state.promptBlockingDialogIds.length > 0 || modalSlotHeldByUser(state)
}

function compareRequests(a: AutomaticPromptRequest, b: AutomaticPromptRequest): number {
  return AUTOMATIC_PROMPT_PRIORITY[a.id] - AUTOMATIC_PROMPT_PRIORITY[b.id] || a.seq - b.seq
}

export function selectVisibleAutomaticPromptId(state: PromptTurnInputs): AutomaticPromptId | null {
  if (selectUserDialogVisible(state)) {
    return null
  }
  const requests = state.automaticPromptRequests
  const shown = state.automaticPromptShownId
  if (shown !== null && requests.some((request) => request.id === shown)) {
    return shown
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
  return first?.id ?? null
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
  return state.promptBlockingDialogIds.length > 0 || selectVisibleAutomaticPromptId(state) !== null
}

/**
 * Whether a tour may start. A tour the user asked for (forced) only yields to what is on screen; an
 * automatic one also waits for queued prompts and the launch read, since those go first.
 */
export function selectTourBlockedByPrompts(state: PromptTurnInputs, forced: boolean): boolean {
  if (selectPromptSurfaceVisible(state)) {
    return true
  }
  return !forced && (state.launchPromptDiscoveryPending || state.automaticPromptRequests.length > 0)
}
