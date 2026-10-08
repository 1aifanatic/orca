// Find in window: the app renderer asks main to show the find bar, a separate view stacked over
// the window, so the bar's own input is never one of the matches.

export const WINDOW_FIND_OPEN_CHANNEL = 'windowFind:open'
export const WINDOW_FIND_BAR_QUERY_CHANNEL = 'windowFindBar:query'
export const WINDOW_FIND_BAR_STEP_CHANNEL = 'windowFindBar:step'
export const WINDOW_FIND_BAR_CLOSE_CHANNEL = 'windowFindBar:close'
export const WINDOW_FIND_BAR_RESULT_CHANNEL = 'windowFindBar:result'
export const WINDOW_FIND_BAR_ACTIVATE_CHANNEL = 'windowFindBar:activate'

export const WINDOW_FIND_MAX_TEXT_LENGTH = 1024

/** Where the bar's top-right corner sits, in renderer CSS px from the window's top and right edges. */
export type WindowFindOpenRequest = {
  top: number
  rightInset: number
}

export type WindowFindBarQuery = { text: string }
export type WindowFindBarStep = { forward: boolean }
export type WindowFindBarResult = {
  activeMatchOrdinal: number
  matches: number
}

export type WindowFindBarLabels = {
  label: string
  previousMatch: string
  nextMatch: string
  close: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBoundedOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000
}

export function parseWindowFindOpenRequest(value: unknown): WindowFindOpenRequest | null {
  if (!isRecord(value) || !isBoundedOffset(value.top) || !isBoundedOffset(value.rightInset)) {
    return null
  }
  return { top: value.top, rightInset: value.rightInset }
}

export function parseWindowFindBarQuery(value: unknown): WindowFindBarQuery | null {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    value.text.length > WINDOW_FIND_MAX_TEXT_LENGTH
  ) {
    return null
  }
  return { text: value.text }
}

export function parseWindowFindBarStep(value: unknown): WindowFindBarStep | null {
  if (!isRecord(value) || typeof value.forward !== 'boolean') {
    return null
  }
  return { forward: value.forward }
}
