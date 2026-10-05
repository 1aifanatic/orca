import type { MobileSessionView } from './session-view-preferences'

/** The per-device default view; `settled` is false only until the first read answers. */
export type DefaultSessionViewState = { value: MobileSessionView; settled: boolean }

// Why its own module: launch builders read it synchronously without loading device storage.
let state: DefaultSessionViewState | null = null

export function readDefaultSessionViewState(): DefaultSessionViewState | null {
  return state
}

export function writeDefaultSessionViewState(next: DefaultSessionViewState | null): void {
  state = next
}

/** The view this phone asks for on a launch: its settled default, or nothing before it loads. */
export function settledLaunchSessionView(): MobileSessionView | undefined {
  return state?.settled ? state.value : undefined
}
