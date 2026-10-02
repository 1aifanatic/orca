import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const TAB_ID = 'tab-existing'
const SOURCE = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const SIBLING = '33333333-3333-4333-8333-333333333333'

async function scenario() {
  const harness = await setupTerminalCreateSurfacing(() => false)
  const layout: TerminalLayoutSnapshot = {
    root: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.7,
      first: { type: 'leaf', leafId: SIBLING },
      second: { type: 'leaf', leafId: SOURCE }
    },
    activeLeafId: SIBLING,
    expandedLeafId: null,
    ptyIdsByLeafId: { [SIBLING]: 'pty-sibling', [SOURCE]: 'pty-source' },
    titlesByLeafId: { [SIBLING]: 'Keep sibling title', [SOURCE]: 'Keep source title' }
  }
  harness.storeState.tabsByWorktree = {
    'wt-2': [{ id: TAB_ID, ptyId: 'pty-source', title: 'Terminal 1' }]
  }
  harness.storeState.ptyIdsByTabId = { [TAB_ID]: ['pty-source', 'pty-sibling'] }
  harness.storeState.terminalLayoutsByTabId = { [TAB_ID]: layout }
  const reveal = (ratio?: number) =>
    harness.createTerminalListenerRef.current?.({
      requestId: 'req-ratio',
      worktreeId: 'wt-2',
      tabId: TAB_ID,
      leafId: NEW_LEAF,
      ptyId: 'pty-new',
      splitFromLeafId: SOURCE,
      splitDirection: 'vertical',
      ...(ratio !== undefined ? { splitRatio: ratio } : {}),
      activate: false,
      presentation: 'background'
    })
  return { ...harness, layout, reveal }
}

describe('local split ratio reveal consumption', () => {
  it('sets only the new source split and passes the ratio to the mounted pane event', async () => {
    const harness = await scenario()
    harness.reveal(0.85)
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toEqual({
      ...harness.layout,
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.7,
        first: { type: 'leaf', leafId: SIBLING },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.85,
          first: { type: 'leaf', leafId: SOURCE },
          second: { type: 'leaf', leafId: NEW_LEAF }
        }
      },
      ptyIdsByLeafId: { [SIBLING]: 'pty-sibling', [SOURCE]: 'pty-source', [NEW_LEAF]: 'pty-new' }
    })
    expect(harness.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: expect.objectContaining({
          ratio: 0.85,
          sourceLeafId: SOURCE,
          newLeafId: NEW_LEAF,
          ptyId: 'pty-new'
        })
      })
    )
    expect(harness.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-ratio',
        tabId: TAB_ID,
        identity: expect.objectContaining({ leafId: NEW_LEAF })
      })
    )
  })

  it('preserves a user-changed ratio when the same leaf is revealed again', async () => {
    const harness = await scenario()
    harness.reveal(0.85)
    const saved = JSON.stringify({
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: harness.storeState.terminalLayoutsByTabId
    })
    const restored = parseWorkspaceSession(JSON.parse(saved))
    if (!restored.ok) {
      throw new Error(restored.error)
    }
    const created = restored.value.terminalLayoutsByTabId[TAB_ID]
    if (created?.root?.type !== 'split' || created.root.second.type !== 'split') {
      throw new Error('nested split was not created')
    }
    expect(created.root.second.ratio).toBe(0.85)
    created.root.second.ratio = 0.63
    harness.storeState.terminalLayoutsByTabId[TAB_ID] = created
    harness.reveal(0.85)
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toEqual(created)
  })

  it('keeps the omitted-ratio reveal at the existing equal default', async () => {
    const harness = await scenario()
    harness.reveal()
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toMatchObject({
      root: { ratio: 0.7, second: { ratio: 0.5 } }
    })
    const splitEvent = harness.dispatchEvent.mock.calls.find(
      (call) => call[0] instanceof CustomEvent && call[0].type === 'orca-split-terminal-pane'
    )?.[0]
    expect(splitEvent).toBeInstanceOf(CustomEvent)
    if (splitEvent instanceof CustomEvent) {
      expect(splitEvent.detail).not.toHaveProperty('ratio')
    }
  })

  it('refuses a vanished source instead of synthesizing an equal split', async () => {
    const harness = await scenario()
    harness.layout.root = { type: 'leaf', leafId: SIBLING }
    harness.reveal(0.85)
    expect(harness.setTabLayout).not.toHaveBeenCalled()
    expect(harness.dispatchEvent).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-ratio',
        error: 'terminal_split_source_not_found'
      })
    )
  })
})
