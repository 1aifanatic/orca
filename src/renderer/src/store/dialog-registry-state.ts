export type DialogOrigin = 'automatic' | 'user' | 'response' | 'tour'
export type DialogPhase = 'queued' | 'opening' | 'visible' | 'closing'
export const AUTOMATIC_DIALOG_ORDER = ['crash-report', 'feature-tip', 'native-chat-resume'] as const
export type AutomaticDialogKind = (typeof AUTOMATIC_DIALOG_ORDER)[number]
export type StartupSourceAnswer = 'pending' | 'ready' | 'none' | 'unavailable'
export type DialogEntry = Readonly<{
  token: string
  kind: string
  origin: DialogOrigin
  phase: DialogPhase
}>
export type DialogRegistry = Readonly<{
  dialogEntries: readonly DialogEntry[]
  startupSources: Readonly<Record<AutomaticDialogKind, StartupSourceAnswer>>
}>

export const INITIAL_DIALOG_REGISTRY: DialogRegistry = {
  dialogEntries: [],
  startupSources: {
    'crash-report': 'pending',
    'feature-tip': 'pending',
    'native-chat-resume': 'pending'
  }
}

function onScreen(entry: DialogEntry): boolean {
  return entry.phase === 'visible' || entry.phase === 'closing'
}

const TURN_ORDER: readonly string[] = AUTOMATIC_DIALOG_ORDER

// Until content commits, admission is re-derived without changing the item's place in line.
function admitNext(registry: DialogRegistry): DialogRegistry {
  // Stable priority sorting preserves the registry array's FIFO order.
  const next = registry.dialogEntries.some(onScreen)
    ? undefined
    : registry.dialogEntries
        .filter((entry) => entry.origin === 'automatic')
        .sort((a, b) => TURN_ORDER.indexOf(a.kind) - TURN_ORDER.indexOf(b.kind))
        .find((entry) =>
          AUTOMATIC_DIALOG_ORDER.slice(0, TURN_ORDER.indexOf(entry.kind)).every(
            (kind) => registry.startupSources[kind] !== 'pending'
          )
        )
  let changed = false
  const dialogEntries = registry.dialogEntries.map((entry) => {
    if (entry.origin !== 'automatic' || onScreen(entry)) {
      return entry
    }
    const phase = entry === next ? 'opening' : 'queued'
    if (entry.phase === phase) {
      return entry
    }
    changed = true
    return { ...entry, phase } satisfies DialogEntry
  })
  return changed ? { ...registry, dialogEntries } : registry
}

function putEntry(registry: DialogRegistry, entry: DialogEntry): DialogRegistry {
  const existing = registry.dialogEntries.find((item) => item.token === entry.token)
  return {
    ...registry,
    dialogEntries: existing
      ? registry.dialogEntries.map((item) => (item === existing ? entry : item))
      : [...registry.dialogEntries, entry]
  }
}

export function enqueueAutomaticDialog(
  registry: DialogRegistry,
  token: string,
  kind: AutomaticDialogKind
): DialogRegistry {
  return registry.dialogEntries.some((entry) => entry.token === token)
    ? registry
    : admitNext(putEntry(registry, { token, kind, origin: 'automatic', phase: 'queued' }))
}

// User-requested automatic content opens immediately, reusing its queued or shown entry.
export function openDialogEntry(
  registry: DialogRegistry,
  opened: { token: string; kind: string; origin: Exclude<DialogOrigin, 'automatic'> }
): DialogRegistry {
  const existing = registry.dialogEntries.find((entry) => entry.token === opened.token)
  return admitNext(
    putEntry(registry, { ...opened, phase: existing && onScreen(existing) ? 'visible' : 'opening' })
  )
}

export function endDialogEntry(registry: DialogRegistry, token: string): DialogRegistry {
  return admitNext({
    ...registry,
    dialogEntries: registry.dialogEntries.filter((entry) => entry.token !== token)
  })
}

export function closeDialogEntry(registry: DialogRegistry, token: string): DialogRegistry {
  const entry = registry.dialogEntries.find((item) => item.token === token)
  return entry?.phase === 'visible'
    ? admitNext(putEntry(registry, { ...entry, phase: 'closing' }))
    : entry?.phase === 'closing'
      ? registry
      : endDialogEntry(registry, token)
}

// Ordinary dialogs exist only for their mounted content, including the exit animation.
export function dialogContentMounted(
  registry: DialogRegistry,
  token: string,
  kind = 'dialog',
  origin: Exclude<DialogOrigin, 'automatic'> = 'user'
): DialogRegistry {
  const entry = registry.dialogEntries.find((item) => item.token === token)
  if (entry?.phase === 'queued' || (entry && onScreen(entry))) {
    return registry
  }
  return admitNext(putEntry(registry, { token, kind, origin, ...entry, phase: 'visible' }))
}

export function dialogContentUnmounted(registry: DialogRegistry, token: string): DialogRegistry {
  const entry = registry.dialogEntries.find((item) => item.token === token)
  return entry?.origin === 'automatic' && entry.phase === 'visible'
    ? admitNext(putEntry(registry, { ...entry, phase: 'queued' }))
    : endDialogEntry(registry, token)
}

// The answer and its item enter together, leaving no gap for a later startup kind.
export function settleStartupSource(
  registry: DialogRegistry,
  kind: AutomaticDialogKind,
  answer: Exclude<StartupSourceAnswer, 'pending'>,
  itemToken?: string
): DialogRegistry {
  const next = itemToken ? enqueueAutomaticDialog(registry, itemToken, kind) : registry
  return next.startupSources[kind] !== 'pending'
    ? next
    : admitNext({ ...next, startupSources: { ...next.startupSources, [kind]: answer } })
}

export function selectDialogOnScreen(registry: DialogRegistry): boolean {
  return registry.dialogEntries.some((entry) => onScreen(entry) && entry.origin !== 'tour')
}

export function selectDialogPhase(registry: DialogRegistry, token: string): DialogPhase | null {
  return registry.dialogEntries.find((entry) => entry.token === token)?.phase ?? null
}

export function selectAdmittedDialog(
  registry: DialogRegistry,
  kind: AutomaticDialogKind
): DialogEntry | undefined {
  return registry.dialogEntries.find((entry) => entry.kind === kind && entry.phase !== 'queued')
}

export function selectTourParentToken(
  registry: DialogRegistry,
  allowedModals: readonly string[] = []
): string | null {
  return (
    registry.dialogEntries.find(
      (entry) => entry.phase === 'visible' && allowedModals.includes(entry.kind)
    )?.token ?? null
  )
}

export function selectTourInterrupted(
  registry: DialogRegistry,
  parentToken?: string | null
): boolean {
  return registry.dialogEntries.some(
    (entry) => onScreen(entry) && entry.origin !== 'tour' && entry.token !== parentToken
  )
}

export function selectTourBlocked(
  registry: DialogRegistry,
  forced: boolean,
  parentToken?: string | null
): boolean {
  return (
    selectTourInterrupted(registry, parentToken) ||
    (!forced &&
      (registry.dialogEntries.some((entry) => entry.origin === 'automatic') ||
        Object.values(registry.startupSources).includes('pending')))
  )
}
