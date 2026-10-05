import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalChatViewRequest } from '../../../../shared/terminal-chat-view-request'
import { useAppStore } from '../../store'
import { registerTerminalUiRoutingIpcBridge } from './terminal-ui-routing-ipc-bridge'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../store', async () => {
  const { createTestStore } = await import('../../store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const WT = 'repo1::/tmp/local'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('renderer side of the desktop chat-view relay', () => {
  let onRequest: ((request: TerminalChatViewRequest) => void) | null
  const respond = vi.fn()

  beforeEach(() => {
    onRequest = null
    respond.mockClear()
    const subscribe = () => () => {}
    globalThis.window = {
      api: {
        // @ts-expect-error -- partial window stub: only the subscriptions this bridge registers
        ui: {
          set: vi.fn(),
          onSplitTerminal: subscribe,
          onRenameTerminal: subscribe,
          onFocusTerminal: subscribe,
          onFocusEditorTab: subscribe,
          onTerminalChatViewRequest: (callback: (request: TerminalChatViewRequest) => void) => {
            onRequest = callback
            return () => {}
          },
          respondTerminalChatView: respond
        }
      }
    }
    registerTerminalUiRoutingIpcBridge([])
  })

  it('applies the pair before replying and replies with what the store holds', () => {
    const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
    useAppStore.getState().setTabLayout(tab.id, {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: B }
      },
      activeLeafId: A,
      expandedLeafId: null
    })

    onRequest!({ requestId: 'r-1', worktreeId: WT, tabId: tab.id, leafId: B, viewMode: 'chat' })

    expect(useAppStore.getState().terminalLayoutsByTabId[tab.id]?.chatLeafId).toBe(B)
    expect(respond).toHaveBeenCalledWith({
      requestId: 'r-1',
      chatView: { viewMode: 'chat', chatLeafId: B }
    })
  })

  it('reports an unknown tab', () => {
    onRequest!({
      requestId: 'r-2',
      worktreeId: WT,
      tabId: 'missing',
      leafId: null,
      viewMode: 'chat'
    })
    expect(respond).toHaveBeenCalledWith({ requestId: 'r-2', error: 'tab_not_found' })
  })
})
