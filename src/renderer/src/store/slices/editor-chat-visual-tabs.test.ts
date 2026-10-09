import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { isMobilePublishableOpenFile } from '@/runtime/sync-runtime-graph/mobile-session-surfaces'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

const visual = {
  target: { kind: 'local' as const },
  sessionId: 'session-1',
  file: 'latency-7c1e.html',
  title: 'Latency by region'
}
const TAB_ID = 'wt-1::chat-visual::session-1::latency-7c1e.html'

function visualTabs(store: ReturnType<typeof createEditorTabsStore>) {
  return (store.getState().unifiedTabsByWorktree['wt-1'] ?? []).filter(
    (tab) => tab.contentType === 'chat-visual'
  )
}

describe('chat visual tabs', () => {
  it('opens a visual as its own tab and focuses that tab when opened again', () => {
    const store = createEditorTabsStore()

    store.getState().openChatVisualTab('wt-1', visual)
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().openChatVisualTab('wt-1', visual)

    expect(store.getState().activeFileId).toBe(TAB_ID)
    expect(store.getState().openFiles.filter((file) => file.id === TAB_ID)).toEqual([
      expect.objectContaining({
        mode: 'chat-visual',
        relativePath: 'Latency by region',
        chatVisual: visual
      })
    ])
    expect(visualTabs(store)).toEqual([
      expect.objectContaining({ entityId: TAB_ID, label: 'Latency by region' })
    ])
  })

  it('closes cleanly and leaves nothing to reopen from a snapshot', () => {
    const store = createEditorTabsStore()
    store.getState().openChatVisualTab('wt-1', visual)

    store.getState().closeFile(TAB_ID)

    expect(store.getState().openFiles).toEqual([])
    expect(visualTabs(store)).toEqual([])
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('is never saved with the session or published to paired clients', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().openChatVisualTab('wt-1', visual)
    const state = store.getState()

    const persisted = buildPersistedUnifiedTabSessionData(state)

    expect(persisted.unifiedTabs?.['wt-1']?.map((tab) => tab.contentType)).toEqual(['editor'])
    expect(persisted.tabGroups?.['wt-1']?.flatMap((group) => group.tabOrder)).toHaveLength(1)
    const visualFile = state.openFiles.find((file) => file.id === TAB_ID)
    expect(visualFile && isMobilePublishableOpenFile(visualFile)).toBe(false)
  })
})
