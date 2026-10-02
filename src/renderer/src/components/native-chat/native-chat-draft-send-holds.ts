// A send empties its chat's box at once but holds back saving that, so a crash before the host has
// the message restores it unsent. Each hold ends with `save`, which writes the chat's draft as it
// is then; sends on a chat are numbered, and a save is skipped while a later send still waits.

export type NativeChatDraftSendHolds = {
  /** Runs `clear` without saving it, unless `saveAtOnce`; returns the hold's `save`. */
  clearForSend: (
    draftKey: string,
    clear: () => void,
    options: { saveAtOnce: boolean; releaseAtQuit: boolean }
  ) => () => void
  /** Whether a send is clearing this chat's box right now, so the write waits for `save`. */
  isClearingForSend: (draftKey: string) => boolean
  /** Forgets the holds of chats that ended. */
  forget: (draftKeys: Iterable<string>) => void
  sendsAwaitingForTests: (draftKey: string) => number
  clearForTests: () => void
}

export function createNativeChatDraftSendHolds(
  persist: (draftKey: string) => void
): NativeChatDraftSendHolds {
  const clearing = new Set<string>()
  // Per chat, the sends whose message the host does not have yet, by send order.
  const awaitingByChat = new Map<string, Set<number>>()
  // Holds a graceful quit ends: the outbox, committed at a quit, still has an undelivered message.
  const releasedAtQuit = new Set<() => void>()
  let sequence = 0
  let quitListenersInstalled = false

  const releaseAtQuit = (): void => {
    for (const save of Array.from(releasedAtQuit)) {
      save()
    }
  }

  const installQuitListeners = (): void => {
    if (
      quitListenersInstalled ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return
    }
    quitListenersInstalled = true
    window.addEventListener('beforeunload', releaseAtQuit)
    window.addEventListener('pagehide', releaseAtQuit)
  }

  return {
    clearForSend: (draftKey, clear, options) => {
      const send = (sequence += 1)
      const awaiting = awaitingByChat.get(draftKey) ?? new Set()
      awaitingByChat.set(draftKey, awaiting.add(send))
      if (options.saveAtOnce) {
        clear()
      } else {
        clearing.add(draftKey)
        try {
          clear()
        } finally {
          clearing.delete(draftKey)
        }
      }
      const save = (): void => {
        releasedAtQuit.delete(save)
        if (!awaiting.delete(send)) {
          return
        }
        if (awaiting.size === 0 && awaitingByChat.get(draftKey) === awaiting) {
          awaitingByChat.delete(draftKey)
        }
        // A later send still waiting keeps its own message saved, and saves once the host has it.
        // An earlier one that never lands (held for Retry) holds nothing up.
        if (Array.from(awaiting).some((later) => later > send)) {
          return
        }
        persist(draftKey)
      }
      if (options.releaseAtQuit) {
        installQuitListeners()
        releasedAtQuit.add(save)
      }
      return save
    },
    isClearingForSend: (draftKey) => clearing.has(draftKey),
    forget: (draftKeys) => {
      for (const draftKey of draftKeys) {
        awaitingByChat.get(draftKey)?.clear()
        awaitingByChat.delete(draftKey)
      }
    },
    sendsAwaitingForTests: (draftKey) => awaitingByChat.get(draftKey)?.size ?? 0,
    clearForTests: () => {
      awaitingByChat.clear()
      releasedAtQuit.clear()
    }
  }
}
