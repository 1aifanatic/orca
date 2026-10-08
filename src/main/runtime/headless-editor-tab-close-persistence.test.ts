import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { Tab } from '../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'
import { HEADLESS_EDITOR_UNSAVED_DRAFT_ERROR } from './mobile-session-editor-projection'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const WT = 'r1::/repo'
const README = '/repo/README.md'
const MAIN = '/repo/main.ts'

function openFile(filePath: string, overrides: Partial<PersistedOpenFile> = {}): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/repo/'.length),
    worktreeId: WT,
    language: filePath.endsWith('.md') ? 'markdown' : 'typescript',
    ...overrides
  }
}

function editorTab(id: string, filePath: string): Tab {
  return {
    id,
    entityId: filePath,
    groupId: 'group',
    worktreeId: WT,
    contentType: 'editor',
    label: filePath,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** Two persisted editors, the README active and focused, as a migrated SSH host carries them. */
function editorSession(readme: PersistedOpenFile = openFile(README)): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: { [WT]: [readme, openFile(MAIN)] },
    unifiedTabs: { [WT]: [editorTab('editor-readme', README), editorTab('editor-main', MAIN)] },
    tabGroups: {
      [WT]: [
        {
          id: 'group',
          worktreeId: WT,
          activeTabId: 'editor-readme',
          tabOrder: ['editor-readme', 'editor-main'],
          recentTabIds: ['editor-main', 'editor-readme']
        }
      ]
    },
    activeTabTypeByWorktree: { [WT]: 'editor' },
    activeFileIdByWorktree: { [WT]: README },
    activeTabIdByWorktree: { [WT]: 'editor-readme' }
  }
}

async function headlessHost(session: WorkspaceSessionState) {
  const store = createStore()
  store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))
  store.setWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(store)
  const listed = await runtime.listMobileSessionTabs(`id:${WT}`)
  expect(listed.tabs.map((tab) => tab.id)).toEqual(['editor-readme', 'editor-main'])
  return { store, runtime }
}

describe('closing a persisted editor tab on a windowless host', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-headless-editor-close-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('removes the file, its tab bar entry and every pointer to it from the saved session', async () => {
    const { store, runtime } = await headlessHost(editorSession())

    await runtime.closeMobileSessionTab(`id:${WT}`, 'editor-readme')

    const saved = store.getWorkspaceSession()
    expect(saved.openFilesByWorktree?.[WT]?.map((file) => file.filePath)).toEqual([MAIN])
    expect(saved.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['editor-main'])
    expect(saved.tabGroups?.[WT]).toEqual([
      {
        id: 'group',
        worktreeId: WT,
        activeTabId: null,
        tabOrder: ['editor-main'],
        recentTabIds: ['editor-main']
      }
    ])
    expect(saved.activeFileIdByWorktree?.[WT]).toBeNull()
    expect(saved.activeTabIdByWorktree?.[WT]).toBeNull()
    const relisted = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(relisted.tabs.map((tab) => tab.id)).toEqual(['editor-main'])
  })

  it('refuses to drop an unsaved draft unless the close is forced', async () => {
    const dirty = openFile(README, { dirtyDraftContent: '# draft' })
    const { store, runtime } = await headlessHost(editorSession(dirty))

    await expect(runtime.closeMobileSessionTab(`id:${WT}`, 'editor-readme')).rejects.toThrow(
      HEADLESS_EDITOR_UNSAVED_DRAFT_ERROR
    )
    expect(store.getWorkspaceSession().openFilesByWorktree?.[WT]).toHaveLength(2)

    await runtime.closeMobileSessionTab(`id:${WT}`, 'editor-readme', { force: true })
    expect(store.getWorkspaceSession().openFilesByWorktree?.[WT]).toHaveLength(1)
  })
})
