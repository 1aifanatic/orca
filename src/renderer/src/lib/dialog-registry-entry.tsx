import { createContext, useContext, useId, useLayoutEffect, useMemo, useState } from 'react'
import { useDialogRegistry } from '@/store/dialog-registry'
import {
  selectDialogPhase,
  selectModalSlotToken,
  type AutomaticDialogKind,
  type DialogPhase
} from '@/store/dialog-registry-state'

/**
 * How a dialog takes its place in the window's dialog registry. The shared Dialog and Command roots
 * register while open, outside any lazy content. A host that reserved an entry before its dialog's
 * code loaded (the modal slot, the SSH prompt, a self-opening dialog) hands that token down, and the
 * dialog root under it adopts it rather than registering a second entry.
 */

type DialogEntryScope = {
  /** Reserved by the host this dialog renders in, for the dialog root under it to adopt. */
  hostToken: string | null
  /** The nearest dialog's entry: its content reports to it, and dialogs opened in it name it. */
  dialogToken: string | null
}

const DialogEntryContext = createContext<DialogEntryScope>({ hostToken: null, dialogToken: null })

export function AdoptDialogEntry({
  token,
  children
}: {
  token: string | null
  children: React.ReactNode
}): React.JSX.Element {
  const { dialogToken } = useContext(DialogEntryContext)
  const scope = useMemo(() => ({ hostToken: token, dialogToken }), [token, dialogToken])
  return <DialogEntryContext.Provider value={scope}>{children}</DialogEntryContext.Provider>
}

/** For the modal slot's dialogs: they adopt the entry openModal reserved. */
export function ModalSlotDialogScope({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const token = useDialogRegistry(selectModalSlotToken)
  return <AdoptDialogEntry token={token}>{children}</AdoptDialogEntry>
}

/**
 * Around a dialog root. While open it adopts its host's live entry, or registers its own; dialogs
 * opened inside it register their own with it as parent. Closed, it keeps the token it opened with,
 * so its content counts until its exit animation ends.
 */
export function DialogEntryRoot({
  open,
  children
}: {
  open: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { hostToken, dialogToken: parentToken } = useContext(DialogEntryContext)
  const ownToken = `dialog:${useId()}`
  // A host entry that ended (its surface failed, then retried) is not adopted: this one counts itself.
  const hostLive = useDialogRegistry(
    (s) => hostToken !== null && selectDialogPhase(s, hostToken) !== null
  )
  const current = hostLive && hostToken !== null ? hostToken : ownToken
  const [openedToken, setOpenedToken] = useState(current)
  if (open && openedToken !== current) {
    setOpenedToken(current)
  }
  const token = open ? current : openedToken
  const registersOwn = open && current === ownToken

  // Layout effect: registered before this dialog's first paint, so nothing is admitted under it.
  useLayoutEffect(() => {
    if (!registersOwn) {
      return
    }
    useDialogRegistry
      .getState()
      .openDialog({ token: ownToken, kind: 'dialog', origin: 'user', parentToken })
    return () => useDialogRegistry.getState().closeDialog(ownToken)
  }, [ownToken, parentToken, registersOwn])

  const scope = useMemo(() => ({ hostToken: null, dialogToken: token }), [token])
  return <DialogEntryContext.Provider value={scope}>{children}</DialogEntryContext.Provider>
}

/** Rendered inside a dialog's content, which is mounted while open and through its exit animation. */
export function DialogEntryContent(): null {
  const { dialogToken } = useContext(DialogEntryContext)
  useLayoutEffect(() => {
    if (dialogToken === null) {
      return
    }
    useDialogRegistry.getState().dialogContentMounted(dialogToken)
    return () => useDialogRegistry.getState().dialogContentUnmounted(dialogToken)
  }, [dialogToken])
  return null
}

/** A host's entry for a dialog whose code may still be loading; its root adopts it. */
export function useHostDialogEntry(
  token: string,
  kind: string,
  origin: 'user' | 'response',
  open: boolean
): void {
  const { dialogToken: parentToken } = useContext(DialogEntryContext)
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    useDialogRegistry.getState().openDialog({ token, kind, origin, parentToken })
    return () => useDialogRegistry.getState().closeDialog(token)
  }, [kind, open, origin, parentToken, token])
}

/**
 * A self-opening dialog's entry: queued for its turn ('automatic'), opened at once because the user
 * asked ('user', taking over a queued or shown one in place), or withdrawn (null). Unmounting the
 * owner withdraws it. Returns its phase; the owner renders the dialog once it is past 'queued'.
 */
export function useAutomaticDialogEntry(
  token: string,
  kind: AutomaticDialogKind,
  request: 'automatic' | 'user' | null
): DialogPhase | null {
  useLayoutEffect(() => {
    const registry = useDialogRegistry.getState()
    if (request === 'automatic') {
      registry.enqueueAutomaticDialog(token, kind)
    } else if (request === 'user') {
      registry.openDialog({ token, kind, origin: 'user' })
    } else {
      registry.closeDialog(token)
    }
  }, [kind, request, token])
  useLayoutEffect(() => () => useDialogRegistry.getState().closeDialog(token), [token])
  return useDialogEntryPhase(token)
}

export function useDialogEntryPhase(token: string): DialogPhase | null {
  return useDialogRegistry((s) => selectDialogPhase(s, token))
}

/** Rendered by a dialog surface's error fallback: no dialog is coming, so its host's entry ends. */
export function EndFailedDialogEntry(): null {
  const { hostToken } = useContext(DialogEntryContext)
  useLayoutEffect(() => {
    if (hostToken !== null) {
      useDialogRegistry.getState().endDialog(hostToken)
    }
  }, [hostToken])
  return null
}
