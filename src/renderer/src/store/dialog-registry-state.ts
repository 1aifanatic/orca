/**
 * Every dialog up in this window, and the ones the app wants to open by itself, as one list.
 * Whether a dialog is up, whether a self-opening one may show now and whether a tour may start are
 * all read from here. Transitions are pure; each ends by admitting the next self-opening dialog.
 */

/** automatic: opened by the app itself, waiting its turn. user: opened by the user. response: asks
 *  for something a pending operation needs (an SSH credential). tour: a running contextual tour. */
export type DialogOrigin = 'automatic' | 'user' | 'response' | 'tour'

/** queued: waiting for its turn. opening: admitted, its content not on screen yet. visible: content
 *  on screen. closing: released while its content is still on screen (exit animation). */
export type DialogPhase = 'queued' | 'opening' | 'visible' | 'closing'

/** The dialogs the app opens by itself, in the order they take turns. */
export const AUTOMATIC_DIALOG_ORDER = ['crash-report', 'feature-tip', 'native-chat-resume'] as const

export type AutomaticDialogKind = (typeof AUTOMATIC_DIALOG_ORDER)[number]

export type DialogEntry = Readonly<{
  token: string
  kind: string
  origin: DialogOrigin
  /** The dialog this one was opened from, if any. */
  parentToken: string | null
  seq: number
  phase: DialogPhase
  /** Mounted copies of its content. A closing entry ends when the last one unmounts. */
  mountedContent: number
}>

/** A startup check for one automatic kind: has it said whether there is something to show? */
export type StartupSourceAnswer = 'pending' | 'ready' | 'none' | 'unavailable'

export type DialogRegistry = Readonly<{
  dialogEntries: readonly DialogEntry[]
  startupSources: Readonly<Record<AutomaticDialogKind, StartupSourceAnswer>>
  nextDialogSeq: number
}>

export const INITIAL_DIALOG_REGISTRY: DialogRegistry = {
  dialogEntries: [],
  startupSources: {
    'crash-report': 'pending',
    'feature-tip': 'pending',
    'native-chat-resume': 'pending'
  },
  nextDialogSeq: 1
}

const MODAL_SLOT_KIND_PREFIX = 'modal:'
const TOUR_KIND = 'tour'

function modalSlotKind(modal: string): string {
  return `${MODAL_SLOT_KIND_PREFIX}${modal}`
}

function onScreen(entry: DialogEntry): boolean {
  return entry.phase !== 'queued'
}

const TURN_ORDER: readonly string[] = AUTOMATIC_DIALOG_ORDER

function orderOf(kind: string): number {
  return TURN_ORDER.indexOf(kind)
}

function replaceEntry(
  registry: DialogRegistry,
  token: string,
  next: DialogEntry | null
): DialogRegistry {
  return {
    ...registry,
    dialogEntries: next
      ? registry.dialogEntries.map((entry) => (entry.token === token ? next : entry))
      : registry.dialogEntries.filter((entry) => entry.token !== token)
  }
}

function addEntry(
  registry: DialogRegistry,
  entry: Omit<DialogEntry, 'seq' | 'mountedContent'>
): DialogRegistry {
  return {
    ...registry,
    dialogEntries: [
      ...registry.dialogEntries,
      { ...entry, seq: registry.nextDialogSeq, mountedContent: 0 }
    ],
    nextDialogSeq: registry.nextDialogSeq + 1
  }
}

/** Admitted but not painted: its code may still be loading, so nothing of it is on screen yet. */
function unpainted(entry: DialogEntry): boolean {
  return entry.origin === 'automatic' && entry.phase === 'opening' && entry.mountedContent === 0
}

/**
 * Admits the next self-opening dialog when nothing is on screen: no dialog of any origin open or
 * still closing, and no tour running. Earlier kinds go first, FIFO within a kind, and a kind also
 * waits until every earlier kind's startup check has answered, so a fast late check never shows
 * first. Admission holds only once painted: until then it is decided again on every change, so a
 * dialog opened meanwhile stays on top and an earlier kind queued meanwhile goes first.
 */
function admitNext(registry: DialogRegistry): DialogRegistry {
  let next: DialogEntry | null = null
  const painted = registry.dialogEntries.some((entry) => onScreen(entry) && !unpainted(entry))
  for (const entry of painted ? [] : registry.dialogEntries) {
    if (entry.phase !== 'queued' && !unpainted(entry)) {
      continue
    }
    if (
      next === null ||
      orderOf(entry.kind) < orderOf(next.kind) ||
      (orderOf(entry.kind) === orderOf(next.kind) && entry.seq < next.seq)
    ) {
      next = entry
    }
  }
  if (
    next !== null &&
    AUTOMATIC_DIALOG_ORDER.slice(0, orderOf(next.kind)).some(
      (kind) => registry.startupSources[kind] === 'pending'
    )
  ) {
    next = null
  }
  const unchanged = registry.dialogEntries.every((entry) =>
    entry === next ? entry.phase === 'opening' : !unpainted(entry)
  )
  if (unchanged) {
    return registry
  }
  return {
    ...registry,
    dialogEntries: registry.dialogEntries.map((entry) => {
      if (entry === next) {
        return { ...entry, phase: 'opening' }
      }
      return unpainted(entry) ? { ...entry, phase: 'queued' } : entry
    })
  }
}

/** Opens a dialog now, never waiting. The user opening an automatic one takes it over in place. */
export function openDialogEntry(
  registry: DialogRegistry,
  opened: { token: string; kind: string; origin: Exclude<DialogOrigin, 'automatic'> } & {
    parentToken?: string | null
  }
): DialogRegistry {
  const existing = registry.dialogEntries.find((entry) => entry.token === opened.token)
  if (!existing) {
    return admitNext(
      addEntry(registry, {
        token: opened.token,
        kind: opened.kind,
        origin: opened.origin,
        parentToken: opened.parentToken ?? null,
        phase: 'opening'
      })
    )
  }
  const phase =
    existing.phase === 'queued' || existing.phase === 'closing'
      ? existing.mountedContent > 0
        ? 'visible'
        : 'opening'
      : existing.phase
  if (phase === existing.phase && existing.origin === opened.origin) {
    return registry
  }
  return admitNext(
    replaceEntry(registry, opened.token, { ...existing, origin: opened.origin, phase })
  )
}

/** Queues a self-opening dialog for its turn. One already listed under this token is left as is. */
export function enqueueAutomaticDialog(
  registry: DialogRegistry,
  token: string,
  kind: AutomaticDialogKind
): DialogRegistry {
  if (registry.dialogEntries.some((entry) => entry.token === token)) {
    return registry
  }
  return admitNext(
    addEntry(registry, { token, kind, origin: 'automatic', parentToken: null, phase: 'queued' })
  )
}

/** Its owner is done with it: gone at once unless its content is still on screen, then closing. */
export function closeDialogEntry(registry: DialogRegistry, token: string): DialogRegistry {
  const existing = registry.dialogEntries.find((entry) => entry.token === token)
  if (!existing || existing.phase === 'closing') {
    return registry
  }
  return admitNext(
    replaceEntry(
      registry,
      token,
      existing.mountedContent > 0 ? { ...existing, phase: 'closing' } : null
    )
  )
}

/** Ends it outright: its surface failed to load or render, so nothing of it is on screen. */
export function endDialogEntry(registry: DialogRegistry, token: string): DialogRegistry {
  if (!registry.dialogEntries.some((entry) => entry.token === token)) {
    return registry
  }
  return admitNext(replaceEntry(registry, token, null))
}

export function dialogContentMounted(registry: DialogRegistry, token: string): DialogRegistry {
  const existing = registry.dialogEntries.find((entry) => entry.token === token)
  if (!existing) {
    return registry
  }
  return replaceEntry(registry, token, {
    ...existing,
    mountedContent: existing.mountedContent + 1,
    phase: existing.phase === 'opening' ? 'visible' : existing.phase
  })
}

export function dialogContentUnmounted(registry: DialogRegistry, token: string): DialogRegistry {
  const existing = registry.dialogEntries.find((entry) => entry.token === token)
  if (!existing) {
    return registry
  }
  const mountedContent = Math.max(0, existing.mountedContent - 1)
  if (mountedContent > 0) {
    return replaceEntry(registry, token, { ...existing, mountedContent })
  }
  if (existing.phase === 'closing') {
    return admitNext(replaceEntry(registry, token, null))
  }
  return replaceEntry(registry, token, {
    ...existing,
    mountedContent,
    phase: existing.phase === 'visible' ? 'opening' : existing.phase
  })
}

/**
 * A startup check has answered, once; a later answer is ignored. Its item, if any, is queued in the
 * same step, so no later kind can take the turn between the answer and the item.
 */
export function settleStartupSource(
  registry: DialogRegistry,
  kind: AutomaticDialogKind,
  answer: Exclude<StartupSourceAnswer, 'pending'>,
  itemToken?: string
): DialogRegistry {
  const withItem = itemToken ? enqueueAutomaticDialog(registry, itemToken, kind) : registry
  if (withItem.startupSources[kind] !== 'pending') {
    return withItem
  }
  return admitNext({
    ...withItem,
    startupSources: { ...withItem.startupSources, [kind]: answer }
  })
}

/** Opens the modal slot's entry for `modal`, closing the one it replaces. */
export function openModalSlotEntry(registry: DialogRegistry, modal: string): DialogRegistry {
  const replaced = selectModalSlotToken(registry)
  const without = replaced ? closeDialogEntry(registry, replaced) : registry
  return openDialogEntry(without, {
    token: `modal-slot:${without.nextDialogSeq}`,
    kind: modalSlotKind(modal),
    origin: 'user'
  })
}

export function closeModalSlotEntry(registry: DialogRegistry): DialogRegistry {
  const token = selectModalSlotToken(registry)
  return token ? closeDialogEntry(registry, token) : registry
}

/** Keeps exactly one tour entry, for the running tour, or none. */
export function syncTourEntry(registry: DialogRegistry, tourId: string | null): DialogRegistry {
  const token = tourId === null ? null : `tour:${tourId}`
  let next = registry
  for (const entry of registry.dialogEntries) {
    if (entry.kind === TOUR_KIND && entry.token !== token) {
      next = endDialogEntry(next, entry.token)
    }
  }
  return token === null ? next : openDialogEntry(next, { token, kind: TOUR_KIND, origin: 'tour' })
}

/** Some dialog is up, of any origin: for code that must not act, or take keys, under a dialog. */
export function selectDialogOnScreen(registry: DialogRegistry): boolean {
  return registry.dialogEntries.some((entry) => onScreen(entry) && entry.origin !== 'tour')
}

export function selectDialogPhase(registry: DialogRegistry, token: string): DialogPhase | null {
  return registry.dialogEntries.find((entry) => entry.token === token)?.phase ?? null
}

/** The admitted entry of an automatic kind: the one its owner renders now. */
export function selectAdmittedDialog(
  registry: DialogRegistry,
  kind: AutomaticDialogKind
): DialogEntry | undefined {
  return registry.dialogEntries.find((entry) => entry.kind === kind && onScreen(entry))
}

/** The modal slot's current entry; one being replaced is closing and no longer current. */
export function selectModalSlotToken(registry: DialogRegistry): string | null {
  return (
    registry.dialogEntries.find(
      (entry) => entry.kind.startsWith(MODAL_SLOT_KIND_PREFIX) && entry.phase !== 'closing'
    )?.token ?? null
  )
}

/**
 * A dialog a running tour must give way to: anything on screen but tours, except the modal a tour
 * is written for (the composer's tour runs inside the composer, not inside dialogs opened from it).
 */
export function selectTourInterrupted(
  registry: DialogRegistry,
  allowedModals: readonly string[] = []
): boolean {
  return registry.dialogEntries.some(
    (entry) =>
      onScreen(entry) &&
      entry.origin !== 'tour' &&
      !allowedModals.some((modal) => entry.kind === modalSlotKind(modal))
  )
}

/**
 * Whether a tour may not start. One the user asked for only gives way to what is on screen; one
 * the app starts by itself goes last, after every startup check and every self-opening dialog.
 */
export function selectTourBlocked(
  registry: DialogRegistry,
  forced: boolean,
  allowedModals: readonly string[] = []
): boolean {
  if (selectTourInterrupted(registry, allowedModals)) {
    return true
  }
  if (forced) {
    return false
  }
  return (
    registry.dialogEntries.some((entry) => entry.origin === 'automatic') ||
    Object.values(registry.startupSources).includes('pending')
  )
}
