// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildOwnedEditorFileId } from '@/store/slices/editor/file-ids/editor-file-ids'
import type { OpenFile } from '@/store/slices/editor'

const editorProps = vi.hoisted(() => {
  const state: { current: Record<string, unknown> | null; files: OpenFile[] } = {
    current: null,
    files: []
  }
  return state
})

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', terminalFontSize: 13, terminalFontFamily: 'monospace' },
      editorFontZoomLevel: 0,
      openFiles: editorProps.files,
      worktreesByRepo: { local: [{ id: 'local-worktree', repoId: 'local', hostId: 'local' }] },
      setPendingEditorReveal: vi.fn(),
      setEditorCursorLine: vi.fn(),
      addDiffComment: vi.fn(),
      deleteDiffComment: vi.fn(),
      updateDiffComment: vi.fn(),
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: vi.fn(),
      worktreeDiffComments: {}
    })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))

import MonacoEditor from './MonacoEditor'

afterEach(() => {
  cleanup()
  editorProps.current = null
  editorProps.files = []
})

describe('MonacoEditor content ownership', () => {
  it('initializes the wrapper without a controlled value updater', () => {
    render(
      <MonacoEditor
        fileId="file"
        filePath="/repo/file.jsonl"
        viewStateKey="pane:file"
        relativePath="file.jsonl"
        content="initial content"
        language="jsonl"
        onContentChange={vi.fn()}
        onSave={vi.fn()}
        readOnly
      />
    )

    expect(editorProps.current?.defaultValue).toBe('initial content')
    expect(editorProps.current).not.toHaveProperty('value')
  })

  it('isolates same-path files on different hosts while sharing split panes', () => {
    const filePath = '/srv/repo/file.ts'
    const ownedId = buildOwnedEditorFileId(filePath, 'ssh-worktree', 'remote-runtime')
    editorProps.files = [
      {
        id: filePath,
        filePath,
        relativePath: 'file.ts',
        worktreeId: 'local-worktree',
        mode: 'edit',
        language: 'typescript',
        isDirty: false
      },
      {
        id: ownedId,
        filePath,
        relativePath: 'file.ts',
        worktreeId: 'ssh-worktree',
        runtimeEnvironmentId: 'remote-runtime',
        mode: 'edit',
        language: 'typescript',
        isDirty: false
      }
    ]
    const props = {
      filePath,
      relativePath: 'file.ts',
      language: 'typescript',
      onContentChange: vi.fn(),
      onSave: vi.fn()
    }
    const local = render(
      <MonacoEditor {...props} fileId={filePath} viewStateKey="local-pane" content="local" />
    )
    const localModel = editorProps.current?.path
    local.unmount()
    const remote = render(
      <MonacoEditor {...props} fileId={ownedId} viewStateKey="remote-pane" content="remote" />
    )
    const remoteModel = editorProps.current?.path
    expect(remoteModel).not.toBe(localModel)
    remote.unmount()
    render(<MonacoEditor {...props} fileId={ownedId} viewStateKey="split-pane" content="remote" />)
    expect(editorProps.current?.path).toBe(remoteModel)
  })
})
