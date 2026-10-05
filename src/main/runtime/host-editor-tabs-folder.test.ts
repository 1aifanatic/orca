/**
 * Folder workspaces need no Git for files, Markdown documents or notes on a host with no window;
 * diffs still need Git and refuse plainly instead of opening an empty tab.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, getDefaultWorkspaceSession } =
  await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRuntimeStoreWithWorkspaceSession
} = await import('./orca-runtime-test-fixtures.spec')

async function folderRuntime(initial: WorkspaceSessionState = getDefaultWorkspaceSession()) {
  const folderPath = await mkdtemp(join(tmpdir(), 'orca-host-editor-folder-'))
  const folderStore = createFolderWorkspaceRuntimeStore(
    makeFolderWorkspace({ folderPath }),
    makeFolderProjectGroup({ parentPath: folderPath })
  )
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(initial)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merged fixture implements every store method these folder paths call.
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    ...folderStore,
    getWorkspaceSession: runtimeStore.getWorkspaceSession,
    setWorkspaceSession: runtimeStore.setWorkspaceSession
  } as never)
  return { runtime, folderPath, getSession, selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
}

describe('host-owned editor tabs in a folder workspace', () => {
  it('opens, reads and saves a Markdown file with no Git', async () => {
    const { runtime, folderPath, selector, getSession } = await folderRuntime()
    await writeFile(join(folderPath, 'plan.md'), 'draft one')

    await runtime.openMobileFile(selector, 'plan.md')
    const [tab] = (await runtime.listMobileSessionTabs(selector)).tabs
    const read = await runtime.readMobileMarkdownTab(selector, tab!.id)
    await runtime.saveMobileMarkdownTab(selector, tab!.id, read.version, 'draft two')

    expect(tab).toMatchObject({ type: 'markdown', relativePath: 'plan.md' })
    expect(read).toMatchObject({ content: 'draft one', editable: true })
    expect(await readFile(join(folderPath, 'plan.md'), 'utf8')).toBe('draft two')
    expect(getSession().openFilesByWorktree?.[TEST_FOLDER_WORKSPACE_KEY]).toHaveLength(1)
    expect(hashMarkdownContent('draft two')).toBe(
      (await runtime.readMobileMarkdownTab(selector, tab!.id)).version
    )
  })

  it("refuses a diff in a folder that isn't a Git repository, opening no tab", async () => {
    const { runtime, selector } = await folderRuntime()

    await expect(runtime.openMobileDiff(selector, 'plan.md', false)).rejects.toThrow(
      "This folder isn't a Git repository."
    )
    expect((await runtime.listMobileSessionTabs(selector)).tabs).toEqual([])
  })

  it('finds an editor-only folder workspace in the unscoped inventory', async () => {
    const { runtime, folderPath, selector, getSession } = await folderRuntime()
    await writeFile(join(folderPath, 'plan.md'), 'x')
    await runtime.openMobileFile(selector, 'plan.md')

    const restarted = await folderRuntime(getSession())
    const all = await restarted.runtime.listAllMobileSessionTabs()

    expect(all.find((snapshot) => snapshot.worktree === TEST_FOLDER_WORKSPACE_KEY)?.tabs).toEqual([
      expect.objectContaining({ type: 'markdown', relativePath: 'plan.md' })
    ])
  })

  it('finds an editor-only workspace stored in an SSH folder partition', async () => {
    const folderStore = createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath: '/srv/notes', executionHostId: 'ssh:target-1' }),
      makeFolderProjectGroup({ parentPath: '/srv' })
    )
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        openFilesByWorktree: {
          [TEST_FOLDER_WORKSPACE_KEY]: [
            {
              filePath: '/srv/notes/plan.md',
              relativePath: 'plan.md',
              worktreeId: TEST_FOLDER_WORKSPACE_KEY,
              language: 'markdown'
            }
          ]
        }
      },
      'ssh:target-1'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merged fixture implements every store method these folder paths call.
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      ...folderStore,
      getWorkspaceSession: runtimeStore.getWorkspaceSession,
      setWorkspaceSession: runtimeStore.setWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local', 'ssh:target-1']
    } as never)

    const all = await runtime.listAllMobileSessionTabs()

    expect(all.find((snapshot) => snapshot.worktree === TEST_FOLDER_WORKSPACE_KEY)?.tabs).toEqual([
      expect.objectContaining({ type: 'markdown', relativePath: 'plan.md' })
    ])
  })
})
