// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  findWorkspaceFileRoute: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(
    (
      settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined,
      connectionId?: string
    ) => connectionId ?? settings?.activeRuntimeEnvironmentId ?? null
  ),
  readRuntimeFileContent: mocks.readRuntimeFileContent,
  subscribeRuntimeFileChanges: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null),
  getConnectionIdForFile: vi.fn(() => null),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))

vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: mocks.findWorkspaceFileRoute
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

vi.mock('./useEditorPanelExternalContentEvents', () => ({
  useEditorPanelExternalContentEvents: vi.fn(),
  usePruneClosedEditorContent: vi.fn()
}))

vi.mock('./useEditorPanelFileLoadRetry', () => ({ useEditorPanelFileLoadRetry: vi.fn() }))
vi.mock('./useLocalLogTail', () => ({ useLocalLogTail: vi.fn() }))

import { useEditorPanelContentState } from './useEditorPanelContentState'

const authorizeExternalPath = vi.fn()
let latestFileContents: Record<string, FileContent> = {}

function createFloatingFile(filePath: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    filePath,
    // Why: floating tabs store a path relative to the floating root (~ by default).
    relativePath: filePath.slice('/Users/me/'.length),
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function HookProbe({ activeFile }: { activeFile: OpenFile }): null {
  latestFileContents = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles: [activeFile],
    gitStatusEntries: undefined,
    editorViewMode: {}
  }).fileContents
  return null
}

describe('restored client-local editor tabs', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
    authorizeExternalPath.mockReset()
    authorizeExternalPath.mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { fs: { authorizeExternalPath } }
    mocks.readRuntimeFileContent.mockReset()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# local', isBinary: false })
    mocks.findWorkspaceFileRoute.mockReset()
    mocks.findWorkspaceFileRoute.mockReturnValue(null)
    mocks.getState.mockReset()
    mocks.getState.mockReturnValue({
      settings: null,
      openFiles: [],
      setLastKnownDiskSignature: vi.fn()
    })
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  // The notebook kernel and environment handlers authorize the same filePath.
  it.each(['/Users/me/notes.txt', '/Users/me/analysis.ipynb'])(
    're-grants %s and waits for the grant before reading it after a restart',
    async (filePath) => {
      let finishGrant: () => void = () => {}
      authorizeExternalPath.mockImplementation(
        () => new Promise<void>((resolve) => (finishGrant = resolve))
      )
      const activeFile = createFloatingFile(filePath)

      await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

      await vi.waitFor(() =>
        expect(authorizeExternalPath).toHaveBeenCalledWith({
          targetPath: filePath,
          skipIfInsideAllowedRoots: true
        })
      )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()

      await act(async () => finishGrant())

      await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('# local'))
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
        expect.objectContaining({ filePath, connectionId: undefined })
      )
    }
  )

  it('re-authorizes a client-local tab stored outside its own project', async () => {
    const filePath = '/Users/me/notes/audit.md'
    const activeFile = createFloatingFile(filePath, {
      relativePath: filePath,
      worktreeId: 'repo-local::/Users/me/project'
    })

    await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('# local'))
    expect(authorizeExternalPath).toHaveBeenCalledWith({
      targetPath: filePath,
      skipIfInsideAllowedRoots: true
    })
  })

  it('does not grant a project tab that its authorized root already covers', async () => {
    const activeFile = createFloatingFile('/Users/me/project/README.md', {
      relativePath: 'README.md',
      worktreeId: 'repo::/Users/me/project'
    })

    await act(async () => root?.render(<HookProbe activeFile={activeFile} />))

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('# local'))
    expect(authorizeExternalPath).not.toHaveBeenCalled()
  })
})
