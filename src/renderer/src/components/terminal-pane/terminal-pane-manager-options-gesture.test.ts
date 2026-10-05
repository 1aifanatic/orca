import { describe, expect, it, vi } from 'vitest'
import { createTerminalPaneManagerOptions } from './terminal-pane-manager-options'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

function createOptions(shouldPersistLayout = true) {
  const persistLayoutSnapshot = vi.fn()
  const context = {
    deps: {
      persistLayoutSnapshot,
      syncExpandedLayout: vi.fn(),
      tabId: 'tab',
      worktreeId: 'wt',
      isVisibleRef: { current: true },
      settingsRef: { current: null }
    },
    ptyDeps: {},
    syncCanExpandState: vi.fn(),
    syncPaneCount: vi.fn(),
    syncPaneLayoutRevision: vi.fn(),
    queueResizeAll: vi.fn(),
    shouldPersistLayout: () => shouldPersistLayout
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building options and running onLayoutChanged read only these fields.
  const optionsContext = context as unknown as TerminalPaneManagerOptionsContext
  const options = createTerminalPaneManagerOptions(optionsContext)
  return { options, persistLayoutSnapshot }
}

describe('terminal pane manager layout gesture wiring', () => {
  it.each(['divider-drag', 'divider-reset', 'pane-reorder', 'equalize'] as const)(
    'persists a %s gesture with the gesture marker',
    (gesture) => {
      const { options, persistLayoutSnapshot } = createOptions()
      options.onLayoutChanged?.(gesture)
      expect(persistLayoutSnapshot).toHaveBeenCalledExactlyOnceWith({ intent: 'gesture' })
    }
  )

  it('persists an automatic layout change without options, as before', () => {
    const { options, persistLayoutSnapshot } = createOptions()
    options.onLayoutChanged?.()
    expect(persistLayoutSnapshot).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('keeps the persist gate for gestures', () => {
    const { options, persistLayoutSnapshot } = createOptions(false)
    options.onLayoutChanged?.('divider-drag')
    expect(persistLayoutSnapshot).not.toHaveBeenCalled()
  })
})
