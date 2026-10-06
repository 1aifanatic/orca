/** Main → renderer: this desktop's browser host for an environment parked or resumed. */
export const BROWSER_CLIENT_HOST_PARKED_CHANNEL = 'runtimeEnvironments:browserClientHostParked'

export type BrowserClientHostParkedEvent = { environmentId: string; parked: boolean }
