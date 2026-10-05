/**
 * Window documents that missed a host editor commit while they were alive and not the editor
 * authority. Such a document holds a stale editor view, so it must never publish a graph or
 * replace the session again. Process-local and never persisted: obsolescence ends only when the
 * window commits a new main-frame document or closes.
 */
type WindowDocumentState = {
  generation: number
  obsoleteGeneration: number | null
  reloadRequested: boolean
  loggedDiscard: boolean
  reload: () => void
}

export class ObsoleteWindowDocuments {
  private readonly documentsByWebContentsId = new Map<number, WindowDocumentState>()

  registerWindow(webContentsId: number, reload: () => void): void {
    this.documentsByWebContentsId.set(webContentsId, {
      generation: 0,
      obsoleteGeneration: null,
      reloadRequested: false,
      loggedDiscard: false,
      reload
    })
  }

  unregisterWindow(webContentsId: number): void {
    this.documentsByWebContentsId.delete(webContentsId)
  }

  /** A new main-frame document committed; it is assigned authority before it reads the session. */
  onDocumentCommitted(webContentsId: number): void {
    const state = this.documentsByWebContentsId.get(webContentsId)
    if (!state) {
      return
    }
    state.generation += 1
    state.obsoleteGeneration = null
    state.reloadRequested = false
    state.loggedDiscard = false
  }

  /** Called on every host editor commit; while the host commits, no window is the editor authority. */
  markAllObsolete(): void {
    for (const state of this.documentsByWebContentsId.values()) {
      state.obsoleteGeneration = state.generation
    }
  }

  isObsolete(webContentsId: number): boolean {
    const state = this.documentsByWebContentsId.get(webContentsId)
    return state !== undefined && state.obsoleteGeneration === state.generation
  }

  /** Reloads an obsolete document once; a cancelled reload leaves it obsolete with no retry. */
  requestReloadOnce(webContentsId: number): boolean {
    const state = this.documentsByWebContentsId.get(webContentsId)
    if (!state || state.obsoleteGeneration !== state.generation || state.reloadRequested) {
      return false
    }
    state.reloadRequested = true
    state.reload()
    return true
  }

  /** True the first time a document's write is discarded, so the log says it once. */
  shouldLogDiscard(webContentsId: number): boolean {
    const state = this.documentsByWebContentsId.get(webContentsId)
    if (!state || state.loggedDiscard) {
      return false
    }
    state.loggedDiscard = true
    return true
  }

  resetForTests(): void {
    this.documentsByWebContentsId.clear()
  }
}

export const obsoleteWindowDocuments = new ObsoleteWindowDocuments()

export const OBSOLETE_WINDOW_GRAPH_ERROR =
  'Runtime graph publisher document missed host editor changes'

/**
 * Runs before a window graph can attach: a recovered promotion would otherwise re-attach a
 * document whose editor view predates host editor changes. One reload gives it a fresh read.
 */
export function refuseObsoleteWindowGraph(webContentsId: number): void {
  if (obsoleteWindowDocuments.isObsolete(webContentsId)) {
    obsoleteWindowDocuments.requestReloadOnce(webContentsId)
    throw new Error(OBSOLETE_WINDOW_GRAPH_ERROR)
  }
}

export type RendererSessionWriteEvent = {
  sender?: { id?: unknown; mainFrame?: unknown } | null
  senderFrame?: unknown
}

export type RendererSessionWriteAdmission = 'admit' | 'obsolete' | 'superseded-frame'

/** Classifies a renderer session write; senders without window identity are admitted as before. */
export function classifyRendererSessionWrite(
  event: RendererSessionWriteEvent | null | undefined
): RendererSessionWriteAdmission {
  const sender = event?.sender
  if (!sender || typeof sender.id !== 'number') {
    return 'admit'
  }
  // Why: a disposed main frame can leave a write queued after its replacement commits.
  if ('mainFrame' in sender && event?.senderFrame !== sender.mainFrame) {
    return 'superseded-frame'
  }
  return obsoleteWindowDocuments.isObsolete(sender.id) ? 'obsolete' : 'admit'
}
