type ScreencastGuest = {
  isDestroyed: () => boolean
  setBackgroundThrottling: (allowed: boolean) => void
}

type HostingWindow = {
  on: (event: 'hide' | 'minimize', listener: () => void) => unknown
  removeListener: (event: 'hide' | 'minimize', listener: () => void) => unknown
}

// Why: Electron's SetBackgroundThrottling(false) re-shows a hidden guest widget and blocks its
// later WasHidden, but the attach-time call can predate the widget it needs to reach.
export function keepScreencastGuestPainting(
  guest: ScreencastGuest,
  window: HostingWindow | null
): () => void {
  const reapply = (): void => {
    if (!guest.isDestroyed()) {
      guest.setBackgroundThrottling(false)
    }
  }
  reapply()
  if (!window) {
    return () => {}
  }
  window.on('hide', reapply)
  window.on('minimize', reapply)
  return () => {
    window.removeListener('hide', reapply)
    window.removeListener('minimize', reapply)
  }
}
