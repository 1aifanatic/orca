// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useTerminalPaneLayoutBindings } from './use-terminal-pane-layout-bindings'
import type { TerminalPaneLayoutController } from './use-terminal-pane-layout-persistence'

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

const store = vi.hoisted((): { terminalLayoutsByTabId: Record<string, unknown> } => ({
  terminalLayoutsByTabId: {}
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))

function splitBoundTo(left: string, right: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    },
    activeLeafId: LEFT,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEFT]: left, [RIGHT]: right }
  }
}

function renderBindings(layout: TerminalLayoutSnapshot) {
  store.terminalLayoutsByTabId = { tab: layout }
  const setTabLayout = vi.fn()
  const controller = {
    containerRef: { current: null },
    expandedPaneIdRef: { current: null },
    expandedStyleSnapshotRef: { current: new Map() },
    managerRef: { current: { getLeafId: (paneId: number) => (paneId === 1 ? LEFT : RIGHT) } },
    paneTransportsRef: { current: new Map() },
    pendingPaneSizeRefreshFrameIdsRef: { current: [] },
    persistLayoutSnapshot: vi.fn(),
    setExpandedPaneId: vi.fn(),
    setTabLayout,
    setTabPaneExpanded: vi.fn(),
    tabId: 'tab'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding writers read only these controller fields.
  const typed = controller as unknown as TerminalPaneLayoutController
  const { result } = renderHook(() => useTerminalPaneLayoutBindings(typed))
  return { bindings: result.current, setTabLayout }
}

afterEach(cleanup)

// R17: main keeps an exited pane's binding, so its remount does one stale reattach, then spawns.
describe("a pane's PTY binding", () => {
  it('is never written by the window for a local or SSH pane, on spawn or on exit', () => {
    const { bindings, setTabLayout } = renderBindings(splitBoundTo('pty-left', 'ssh:t@@pty-right'))

    bindings.syncPanePtyLayoutBinding(1, 'pty-fresh')
    bindings.syncPanePtyLayoutBinding(2, null)
    bindings.clearExitedPanePtyLayoutBinding(1, 'pty-left')
    bindings.clearExitedPanePtyLayoutBindingForLeaf(RIGHT, 'ssh:t@@pty-right')

    expect(setTabLayout).not.toHaveBeenCalled()
  })

  it("is still written by the window for a remote runtime's pane, for the push to its host", () => {
    const { bindings, setTabLayout } = renderBindings(
      splitBoundTo('remote:env@@pty-left', 'remote:env@@pty-right')
    )

    bindings.clearExitedPanePtyLayoutBinding(1, 'remote:env@@pty-left')

    expect(setTabLayout).toHaveBeenCalledExactlyOnceWith(
      'tab',
      expect.objectContaining({ ptyIdsByLeafId: { [RIGHT]: 'remote:env@@pty-right' } })
    )
  })
})
