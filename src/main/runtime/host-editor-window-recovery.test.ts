/**
 * A failed or timed-out desktop promotion hands editor authority back to the host while the
 * window's document may still be alive. If the host then changes editor tabs, that document's
 * late graph must not re-attach (it would erase or resurrect the host's change); it gets one
 * reload and reads the session fresh. With no host change in between, recovery attaches as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  obsoleteWindowDocuments,
  OBSOLETE_WINDOW_GRAPH_ERROR,
  refuseObsoleteWindowGraph
} from '../window/obsolete-window-documents'
import { EDITOR_AUTHORITY_CHANGED_ERROR } from './editor-authority'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const {
  HEADLESS_RUNTIME_WINDOW_ID,
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  electronMocks,
  getDefaultWorkspaceSession
} = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WINDOW_ID } = await import('./orca-runtime-test-fixtures.spec')
const {
  attachEditorWindow,
  createHeadlessEditorHarness,
  mockLiveEditorWindow,
  runtimeFileCommands
} = await import('./host-editor-tabs-test-harness.spec')

const WEB_CONTENTS_ID = 41

/** The IPC graph handler's order: the obsolete-document refusal runs before syncWindowGraph. */
function lateWindowGraph(runtime: { syncWindowGraph: (id: number, graph: never) => unknown }) {
  refuseObsoleteWindowGraph(WEB_CONTENTS_ID)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a renderer graph is the synced shape plus its generation, which syncWindowGraph accepts.
  return runtime.syncWindowGraph(TEST_WINDOW_ID, {
    tabs: [],
    leaves: [],
    rendererGeneration: 'gen-late'
  } as never)
}

async function recoveredPromotion(
  recovery: 'failed' | 'timeout',
  initialSession?: Parameters<typeof createHeadlessEditorHarness>[0]
) {
  const harness = await createHeadlessEditorHarness(initialSession)
  const { runtime } = harness
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const reload = vi.fn()
  obsoleteWindowDocuments.registerWindow(WEB_CONTENTS_ID, reload)
  obsoleteWindowDocuments.onDocumentCommitted(WEB_CONTENTS_ID)
  attachEditorWindow(runtime)
  if (recovery === 'failed') {
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')
  } else {
    await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)
  }
  // The window document is still alive, but authority is back on the host.
  mockLiveEditorWindow()
  expect(runtime.getStatus().authoritativeWindowId).toBe(HEADLESS_RUNTIME_WINDOW_ID)
  return { ...harness, reload }
}

describe.each(['failed', 'timeout'] as const)(
  'host editor changes after a %s promotion',
  (recovery) => {
    afterEach(() => {
      obsoleteWindowDocuments.resetForTests()
      electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
      vi.useRealTimers()
    })

    it('opens on the host, refuses the stale document graph and reloads it once', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { runtime, worktreeId, writeWorktreeFile, getSession, reload } =
        await recoveredPromotion(recovery)
      await writeWorktreeFile('notes.md', 'a')

      await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')

      expect(() => lateWindowGraph(runtime)).toThrow(OBSOLETE_WINDOW_GRAPH_ERROR)
      expect(() => lateWindowGraph(runtime)).toThrow(OBSOLETE_WINDOW_GRAPH_ERROR)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(runtime.getStatus().authoritativeWindowId).toBe(HEADLESS_RUNTIME_WINDOW_ID)
      expect(getSession().openFilesByWorktree?.[worktreeId]).toHaveLength(1)
      expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([
        expect.objectContaining({ type: 'markdown', relativePath: 'notes.md' })
      ])
    })

    it('a host close is not undone by the stale document', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { runtime, worktreeId, getSession } = await recoveredPromotion(
        recovery,
        (worktreeId, worktreePath) => ({
          ...getDefaultWorkspaceSession(),
          openFilesByWorktree: {
            [worktreeId]: [
              {
                filePath: `${worktreePath}/notes.md`,
                relativePath: 'notes.md',
                worktreeId,
                language: 'markdown'
              }
            ]
          }
        })
      )
      const [tab] = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs

      await runtime.closeMobileSessionTab(`id:${worktreeId}`, tab!.id)

      expect(() => lateWindowGraph(runtime)).toThrow(OBSOLETE_WINDOW_GRAPH_ERROR)
      expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([])
      expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])
    })

    it('attaches the late graph as before when the host changed nothing', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { runtime, reload } = await recoveredPromotion(recovery)

      lateWindowGraph(runtime)

      expect(reload).not.toHaveBeenCalled()
      expect(runtime.getStatus()).toMatchObject({ authoritativeWindowId: TEST_WINDOW_ID })
    })

    it('a reloaded document is assigned before it reads, and its first graph attaches', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { runtime, worktreeId, writeWorktreeFile } = await recoveredPromotion(recovery)
      await writeWorktreeFile('notes.md', 'a')
      await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
      expect(() => lateWindowGraph(runtime)).toThrow(OBSOLETE_WINDOW_GRAPH_ERROR)

      // The forced reload: navigation start assigns the window, then the new document commits.
      runtime.markRendererReloading(TEST_WINDOW_ID)
      obsoleteWindowDocuments.onDocumentCommitted(WEB_CONTENTS_ID)

      expect(() => lateWindowGraph(runtime)).not.toThrow()
      expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
    })
  }
)

describe('an open that crosses a window attach', () => {
  afterEach(() => {
    electronMocks.BrowserWindow.fromId.mockImplementation(() => null)
  })

  it('refuses with a retryable error, writes no row, and the next tap takes the window route', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    const commands = runtimeFileCommands(runtime)
    const original = commands.assertOpenTargetIsFile.bind(commands)
    let editor: Record<string, ReturnType<typeof vi.fn>> = {}
    vi.spyOn(commands, 'assertOpenTargetIsFile').mockImplementationOnce(
      async (...args: unknown[]) => {
        await original(...args)
        editor = attachEditorWindow(runtime)
      }
    )

    await expect(runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')).rejects.toThrow(
      EDITOR_AUTHORITY_CHANGED_ERROR
    )
    expect(getSession().openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])

    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    expect(editor.openFile).toHaveBeenCalledTimes(1)
  })

  it('refuses a diff open that crosses an attach the same way', async () => {
    const { runtime, worktreeId } = await createHeadlessEditorHarness()
    const commands = runtimeFileCommands(runtime)
    const original = commands.assertHostDiffGitTarget.bind(commands)
    vi.spyOn(commands, 'assertHostDiffGitTarget').mockImplementationOnce(
      async (...args: unknown[]) => {
        await original(...args)
        attachEditorWindow(runtime)
      }
    )

    await expect(runtime.openMobileDiff(`id:${worktreeId}`, 'a.ts', false)).rejects.toThrow(
      EDITOR_AUTHORITY_CHANGED_ERROR
    )
  })

  it('opens on the host again once a failed attach hands authority back', async () => {
    const { runtime, worktreeId, writeWorktreeFile } = await createHeadlessEditorHarness()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await writeWorktreeFile('notes.md', 'a')
    attachEditorWindow(runtime)
    runtime.markGraphReloadFailed(TEST_WINDOW_ID, 'renderer-process-gone')

    await expect(runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')).resolves.toMatchObject({
      opened: true
    })
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toHaveLength(1)
  })
})
