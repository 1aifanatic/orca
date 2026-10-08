// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'

function createHandlers(scope: HTMLElement, setSearchOpen: (open: boolean) => void) {
  const pane = { id: 1, leafId: 'leaf-1', terminal: { element: scope } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the complete find path; unused runtime dependencies intentionally remain absent.
  return createTerminalKeyboardEventHandlers({
    isMac: false,
    isWindows: false,
    shortcutPlatform: 'linux',
    keyboardScopeRef: { current: scope },
    resolveShortcutEvent: () => ({ type: 'toggleSearch' }),
    createCapturedInputSender: () => vi.fn(),
    nativeOnlyShortcutTracker: {
      prepareKeyDown: vi.fn(),
      armKeyDown: vi.fn()
    },
    observedEnterKeydownTimeStamps: new Map(),
    modifiedEnterChordOwner: {
      ownsRedispatchedEnter: () => false,
      absorb: () => false,
      claim: () => true
    },
    deferredNewlineSender: {
      absorbRedispatchedEnter: () => false,
      defer: vi.fn()
    },
    deferredChordSender: { defer: vi.fn() },
    getModifiedEnterChord: () => null,
    reconcileHeldImeEnterModifiers: vi.fn(),
    optionKittyReleases: { arm: vi.fn(), armNativeDeadKey: vi.fn() },
    terminalImeEnterModifierKeydowns: new Set(),
    paneKittyKeyboardModesRef: { current: new Map() },
    managerRef: {
      current: {
        getActivePane: () => pane,
        getPanes: () => [pane],
        setActivePane: vi.fn()
      }
    },
    paneTransportsRef: { current: new Map() },
    panePtyBindingsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    tabId: 'tab-1',
    worktreeId: 'worktree-1',
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen,
    focusSearchInput: vi.fn(),
    onSearchSelectedText: vi.fn(),
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    searchOpenRef: { current: false },
    searchStateRef: {
      current: { query: '', caseSensitive: false, regex: false }
    },
    keybindings: undefined,
    terminalShortcutPolicy: 'orca-first',
    getKeyboardSplitTelemetrySource: () => 'keyboard'
  } as never)
}

function pressFind(
  target: HTMLElement,
  handlers: ReturnType<typeof createHandlers>
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'f',
    ctrlKey: true
  })
  target.dispatchEvent(event)
  handlers.onKeyDown(event)
  return event
}

describe('terminal find under a native chat cover', () => {
  it('leaves Mod+F to the chat instead of opening search over the hidden terminal', () => {
    const scope = document.createElement('div')
    const cover = document.createElement('div')
    cover.className = 'native-chat-pane-shell'
    const transcript = document.createElement('div')
    cover.append(transcript)
    scope.append(cover)
    document.body.append(scope)
    const setSearchOpen = vi.fn()
    const handlers = createHandlers(scope, setSearchOpen)

    expect(pressFind(transcript, handlers).defaultPrevented).toBe(false)
    expect(setSearchOpen).not.toHaveBeenCalled()

    pressFind(scope, handlers)
    expect(setSearchOpen).toHaveBeenCalledWith(true)
  })
})
