import type {
  WindowFindBarLabels,
  WindowFindBarQuery,
  WindowFindBarResult,
  WindowFindBarStep
} from '../shared/window-find-bar-contract'

// Why literals, not imports: a module shared with main would land in a chunk, and a sandboxed
// preload cannot load chunks. A test pins these to the shared channel names.
export const PRELOAD_WINDOW_FIND_BAR_QUERY_CHANNEL = 'windowFindBar:query'
export const PRELOAD_WINDOW_FIND_BAR_STEP_CHANNEL = 'windowFindBar:step'
export const PRELOAD_WINDOW_FIND_BAR_CLOSE_CHANNEL = 'windowFindBar:close'
export const PRELOAD_WINDOW_FIND_BAR_RESULT_CHANNEL = 'windowFindBar:result'
export const PRELOAD_WINDOW_FIND_BAR_ACTIVATE_CHANNEL = 'windowFindBar:activate'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseWindowFindBarResult(value: unknown): WindowFindBarResult | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.activeMatchOrdinal) ||
    !Number.isSafeInteger(value.matches)
  ) {
    return null
  }
  return {
    activeMatchOrdinal: Math.max(0, Number(value.activeMatchOrdinal)),
    matches: Math.max(0, Number(value.matches))
  }
}

export function parseWindowFindBarLabels(value: unknown): WindowFindBarLabels | null {
  if (!isRecord(value)) {
    return null
  }
  const { label, previousMatch, nextMatch, close } = value
  if (
    typeof label !== 'string' ||
    typeof previousMatch !== 'string' ||
    typeof nextMatch !== 'string' ||
    typeof close !== 'string'
  ) {
    return null
  }
  return { label, previousMatch, nextMatch, close }
}

export type WindowFindBarIpc = {
  send: (channel: string, payload?: unknown) => void
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
}

/** Wires the find bar page's controls to main. */
export function installWindowFindBar(doc: Document, ipc: WindowFindBarIpc): void {
  const bar = doc.querySelector<HTMLElement>('.bar')
  const input = doc.querySelector<HTMLInputElement>('#find-input')
  const count = doc.querySelector<HTMLElement>('#find-count')
  const previousButton = doc.querySelector<HTMLButtonElement>('button[data-step="previous"]')
  const nextButton = doc.querySelector<HTMLButtonElement>('button[data-step="next"]')
  const closeButton = doc.querySelector<HTMLButtonElement>('button[data-action="close"]')
  if (!bar || !input || !count || !previousButton || !nextButton || !closeButton) {
    return
  }

  const sendQuery = (text: string): void => {
    ipc.send(PRELOAD_WINDOW_FIND_BAR_QUERY_CHANNEL, {
      text
    } satisfies WindowFindBarQuery)
  }
  const sendStep = (forward: boolean): void => {
    if (input.value.length > 0) {
      ipc.send(PRELOAD_WINDOW_FIND_BAR_STEP_CHANNEL, {
        forward
      } satisfies WindowFindBarStep)
    }
  }
  const close = (): void => ipc.send(PRELOAD_WINDOW_FIND_BAR_CLOSE_CHANNEL)

  const showResult = (result: WindowFindBarResult | null): void => {
    const hasMatches = result !== null && result.matches > 0
    count.textContent = result ? `${result.activeMatchOrdinal}/${result.matches}` : ''
    count.dataset.empty = String(result !== null && result.matches === 0)
    previousButton.disabled = !hasMatches
    nextButton.disabled = !hasMatches
  }

  const applyLabels = (labels: WindowFindBarLabels): void => {
    bar.setAttribute('aria-label', labels.label)
    input.placeholder = labels.label
    input.setAttribute('aria-label', labels.label)
    previousButton.setAttribute('aria-label', labels.previousMatch)
    previousButton.title = labels.previousMatch
    nextButton.setAttribute('aria-label', labels.nextMatch)
    nextButton.title = labels.nextMatch
    closeButton.setAttribute('aria-label', labels.close)
    closeButton.title = labels.close
  }

  input.addEventListener('input', () => {
    if (input.value.length === 0) {
      showResult(null)
    }
    sendQuery(input.value)
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) {
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      sendStep(!event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  previousButton.addEventListener('click', () => sendStep(false))
  nextButton.addEventListener('click', () => sendStep(true))
  closeButton.addEventListener('click', close)

  ipc.on(PRELOAD_WINDOW_FIND_BAR_RESULT_CHANNEL, (_event, payload) => {
    const result = parseWindowFindBarResult(payload)
    if (result) {
      showResult(result)
    }
  })
  ipc.on(PRELOAD_WINDOW_FIND_BAR_ACTIVATE_CHANNEL, (_event, payload) => {
    const labels = parseWindowFindBarLabels(payload)
    if (labels) {
      applyLabels(labels)
    }
    input.focus()
    input.select()
    // Reopening re-runs the kept query so the count and highlight come back with the bar.
    if (input.value.length > 0) {
      sendQuery(input.value)
    }
  })
}
