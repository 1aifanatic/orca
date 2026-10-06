import { BrowserWindow } from 'electron'
import {
  BROWSER_CLIENT_HOST_PARKED_CHANNEL,
  type BrowserClientHostParkedEvent
} from '../../shared/browser-client-host-parked'

const parkedEnvironmentIds = new Set<string>()

export function isBrowserClientHostEnvironmentParked(environmentId: string): boolean {
  return parkedEnvironmentIds.has(environmentId)
}

/** Tells every renderer, so the offline strip follows the browser host and not the control link. */
export function publishBrowserClientHostParked(
  environmentId: string,
  parked: boolean,
  error?: Error
): void {
  if (parked) {
    parkedEnvironmentIds.add(environmentId)
    console.warn('[browser-client-host] runtime unreachable; keeping pages until it returns:', {
      environmentId,
      error: error?.message
    })
  } else {
    parkedEnvironmentIds.delete(environmentId)
  }
  const event: BrowserClientHostParkedEvent = { environmentId, parked }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(BROWSER_CLIENT_HOST_PARKED_CHANNEL, event)
    } catch {
      /* A renderer can close during publication. */
    }
  }
}
