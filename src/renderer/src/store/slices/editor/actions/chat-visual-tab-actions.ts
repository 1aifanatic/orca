import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { buildChatVisualTabId } from '@/components/native-chat/native-chat-visual-tab'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

export function createChatVisualTabActions(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'openChatVisualTab'> {
  return {
    openChatVisualTab: (worktreeId, visual) => {
      const id = buildChatVisualTabId(worktreeId, visual)
      const label = visual.title ?? visual.file
      set((s) => {
        const activation = {
          activeFileId: id,
          activeTabType: 'editor' as const,
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' as const }
        }
        if (s.openFiles.some((f) => f.id === id)) {
          return activation
        }
        const file: OpenFile = {
          id,
          filePath: id,
          relativePath: label,
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'chat-visual',
          chatVisual: visual
        }
        return { openFiles: [...s.openFiles, file], ...activation }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, label, 'chat-visual')
    }
  }
}
