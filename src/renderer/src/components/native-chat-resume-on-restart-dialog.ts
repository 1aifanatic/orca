import type { RestartMachineKey } from './native-chat-restart-machines'

/** An open request, and the machine it was opened for (that machine's row starts expanded). */
export type NativeChatResumeOnRestartDialogRequest = Readonly<{
  focus: RestartMachineKey | null
}>

let pending: NativeChatResumeOnRestartDialogRequest | null = null
/** Whether the dialog is drawn right now, as the dialog itself reports it. */
let showing = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the launch load, the status-bar entry and a reconnect toast all open this dialog, and any
// can fire before it subscribes. Keeping the request as an external snapshot prevents mount
// ordering from losing it.
export function requestNativeChatResumeOnRestartDialog(
  focus: RestartMachineKey | null = null
): void {
  // An open dialog stays as it is: a later request (this computer's launch read landing under it)
  // would move its focus and reset the user's ticks, and the dialog lists every machine anyway.
  if (pending) {
    return
  }
  pending = { focus }
  notify()
}

export function consumeNativeChatResumeOnRestartDialogRequest(): void {
  if (!pending) {
    return
  }
  pending = null
  notify()
}

export function getNativeChatResumeOnRestartDialogRequest(): NativeChatResumeOnRestartDialogRequest | null {
  return pending
}

/** Set by the dialog: an open request with something to list. */
export function setNativeChatResumeDialogShowing(next: boolean): void {
  showing = next
}

/** Whether the user is looking at the dialog now; a pending request alone does not say so. */
export function isNativeChatResumeDialogShowing(): boolean {
  return showing
}

export function subscribeNativeChatResumeOnRestartDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatResumeOnRestartDialog(): void {
  pending = null
  showing = false
}
