/** Who asked: the launch read raises it by itself and takes a turn; the user opens it at once. */
export type NativeChatResumeDialogOrigin = 'launch' | 'user'

let pendingOpen: NativeChatResumeDialogOrigin | null = null
let launchDecided = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the launch load and the status-bar entry both open this dialog, and either can fire before
// it subscribes. Keeping the request as an external snapshot prevents mount ordering from losing it.
export function requestNativeChatResumeOnRestartDialog(origin: NativeChatResumeDialogOrigin): void {
  // A user's request is never demoted to a scheduled one.
  const next = pendingOpen === 'user' ? 'user' : origin
  if (pendingOpen === next) {
    return
  }
  pendingOpen = next
  notify()
}

export function consumeNativeChatResumeOnRestartDialogRequest(): void {
  if (pendingOpen === null) {
    return
  }
  pendingOpen = null
  notify()
}

export function getNativeChatResumeOnRestartDialogRequest(): NativeChatResumeDialogOrigin | null {
  return pendingOpen
}

/** This launch's read has asked, resumed by itself, or found nothing; other launch prompts need
 *  not wait for it any longer. */
export function markNativeChatResumeLaunchDecided(): void {
  if (launchDecided) {
    return
  }
  launchDecided = true
  notify()
}

export function getNativeChatResumeLaunchDecided(): boolean {
  return launchDecided
}

export function subscribeNativeChatResumeOnRestartDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatResumeOnRestartDialog(): void {
  pendingOpen = null
  launchDecided = false
}
