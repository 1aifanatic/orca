import type { Dispatch, SetStateAction } from 'react'
import type { MobileDisplayMode } from './mobile-session-route-types'

export function updateMobileTerminalDisplayMode(
  setModes: Dispatch<SetStateAction<Map<string, MobileDisplayMode>>>,
  handle: string,
  value: unknown
): void {
  if (value !== 'auto' && value !== 'phone' && value !== 'desktop') {
    return
  }
  // Unchanged metadata must not rerender the entire session route.
  setModes((previous) =>
    previous.get(handle) === value ? previous : new Map(previous).set(handle, value)
  )
}
