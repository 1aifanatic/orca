// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeOpenFile, makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { useFloatingTerminalCloseActions } from './use-floating-terminal-close-actions'

const requestEditorFileClose = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/editor-autosave', () => ({ requestEditorFileClose }))

const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
const groupId = 'floating-group'
const sharedFileId = 'shared-file'
const editor = makeUnifiedTab({
  id: 'editor-one',
  worktreeId,
  groupId,
  contentType: 'editor',
  entityId: sharedFileId
})
const secondReference = makeUnifiedTab({
  id: 'editor-two',
  worktreeId,
  groupId: 'other-group',
  contentType: 'editor',
  entityId: sharedFileId
})
const chat = makeUnifiedTab({
  id: 'chat-one',
  worktreeId,
  groupId,
  contentType: 'agent-session',
  entityId: 'chat-session'
})
const group = makeTabGroup({
  id: groupId,
  worktreeId,
  activeTabId: editor.id,
  tabOrder: [editor.id, chat.id]
})

const closeFile = vi.fn<ReturnType<typeof useAppStore.getState>['closeFile']>()
const closeUnifiedTab = vi.fn<ReturnType<typeof useAppStore.getState>['closeUnifiedTab']>(
  () => null
)

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    closeFile,
    closeUnifiedTab,
    unifiedTabsByWorktree: { [worktreeId]: [editor, chat, secondReference] },
    groupsByWorktree: { [worktreeId]: [group] },
    activeGroupIdByWorktree: { [worktreeId]: groupId },
    openFiles: [makeOpenFile({ id: sharedFileId, worktreeId })]
  })
})

function actions() {
  return renderHook(() =>
    useFloatingTerminalCloseActions({ activeGroup: group, groupTabs: [editor, chat] })
  ).result.current
}

describe('floating titlebar close actions', () => {
  it('closes one editor reference while keeping its shared open file', () => {
    actions().closeFloatingItemConfirmed(editor.id)

    expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
    expect(closeFile).not.toHaveBeenCalled()
  })

  it('closes editor tabs without closing structured chats from Close All Editor Tabs', () => {
    actions().closeAllFiles()

    expect(closeUnifiedTab).toHaveBeenCalledWith(editor.id)
    expect(closeUnifiedTab).not.toHaveBeenCalledWith(chat.id)
    expect(closeFile).not.toHaveBeenCalled()
  })

  it('routes a dirty last reference through the shared save confirmation', () => {
    useAppStore.setState({
      unifiedTabsByWorktree: { [worktreeId]: [editor] },
      openFiles: [makeOpenFile({ id: sharedFileId, worktreeId, isDirty: true })]
    })

    actions().closeFloatingItemConfirmed(editor.id)

    expect(requestEditorFileClose).toHaveBeenCalledWith(sharedFileId, {
      onClosed: expect.any(Function)
    })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })
})
