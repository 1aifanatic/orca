import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../../shared/editor-file-identity'
import { closeHostEditFile, persistHostTabGroupLayout } from './host-editor-session-layout'
import { listHostEditTabs, openHostEditTab } from './host-editor-session-model'

const WT = 'repo1::/path/wt1'
const OTHER_WT = 'repo2::/path/wt2'
const NOTE = '/path/wt1/notes.md'

function base(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function ids(): () => string {
  let next = 0
  return () => `uuid-${++next}`
}

const openArgs = {
  worktreeId: WT,
  filePath: NOTE,
  relativePath: 'notes.md',
  language: 'markdown',
  executionHostId: 'local' as const,
  activate: true,
  now: 5
}

describe('host editor session model', () => {
  it('writes the wrapper a window writes, in the active group, in a unified session', () => {
    const session = base({
      unifiedTabs: { [WT]: [] },
      tabGroups: { [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: null, tabOrder: ['term-1'] }] },
      activeGroupIdByWorktree: { [WT]: 'g-1' }
    })

    const { session: next, record } = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(next.unifiedTabs?.[WT]).toEqual([
      {
        id: 'uuid-1',
        entityId: NOTE,
        groupId: 'g-1',
        worktreeId: WT,
        executionHostId: 'local',
        contentType: 'editor',
        label: 'notes.md',
        customLabel: null,
        color: null,
        sortOrder: 1,
        createdAt: 5
      }
    ])
    expect(next.tabGroups?.[WT]?.[0]).toMatchObject({
      tabOrder: ['term-1', 'uuid-1'],
      activeTabId: 'uuid-1',
      recentTabIds: ['uuid-1']
    })
    expect(next.openFilesByWorktree?.[WT]).toEqual([
      { filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }
    ])
    expect(next.activeFileIdByWorktree?.[WT]).toBe(NOTE)
    expect(next.activeTabTypeByWorktree?.[WT]).toBe('editor')
    expect(record).toMatchObject({ tabId: 'uuid-1', fileId: NOTE, groupId: 'g-1' })
  })

  it('uses the owned file id when another workspace already holds the same path', () => {
    const session = base({
      openFilesByWorktree: {
        [OTHER_WT]: [
          { filePath: NOTE, relativePath: 'notes.md', worktreeId: OTHER_WT, language: 'markdown' }
        ]
      }
    })

    const { record } = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(record.fileId).toBe(buildOwnedEditorFileId(NOTE, WT, undefined))
    expect(record.tabId).toBe(NOTE)
  })

  it('dedupes by owner and path, preferring the active group wrapper', () => {
    const session = base({
      openFilesByWorktree: {
        [WT]: [{ filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }]
      },
      unifiedTabs: {
        [WT]: [
          {
            id: 'a',
            entityId: NOTE,
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'b',
            entityId: NOTE,
            groupId: 'g-2',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [
          { id: 'g-1', worktreeId: WT, activeTabId: 'a', tabOrder: ['a'] },
          { id: 'g-2', worktreeId: WT, activeTabId: 'b', tabOrder: ['b'] }
        ]
      },
      activeGroupIdByWorktree: { [WT]: 'g-2' }
    })

    const result = openHostEditTab(session, { ...openArgs, newId: ids() })

    expect(result.created).toBe(false)
    expect(result.record.tabId).toBe('b')
    expect(result.session.openFilesByWorktree?.[WT]).toHaveLength(1)
  })

  it('closes the file entity, removing every split wrapper and collapsing an emptied group', () => {
    const session = base({
      openFilesByWorktree: {
        [WT]: [{ filePath: NOTE, relativePath: 'notes.md', worktreeId: WT, language: 'markdown' }]
      },
      unifiedTabs: {
        [WT]: [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'a',
            entityId: NOTE,
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          },
          {
            id: 'b',
            entityId: NOTE,
            groupId: 'g-2',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [
          {
            id: 'g-1',
            worktreeId: WT,
            activeTabId: 'a',
            tabOrder: ['term-1', 'a'],
            recentTabIds: ['term-1', 'a']
          },
          { id: 'g-2', worktreeId: WT, activeTabId: 'b', tabOrder: ['b'] }
        ]
      },
      tabGroupLayouts: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g-1' },
          second: { type: 'leaf', groupId: 'g-2' }
        }
      },
      activeGroupIdByWorktree: { [WT]: 'g-2' },
      activeFileIdByWorktree: { [WT]: NOTE },
      activeTabTypeByWorktree: { [WT]: 'editor' }
    })
    const [record] = listHostEditTabs(session, WT)

    const next = closeHostEditFile(session, WT, record!)

    expect(next.openFilesByWorktree?.[WT]).toEqual([])
    expect(next.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['term-1'])
    expect(next.tabGroups?.[WT]).toEqual([
      expect.objectContaining({ id: 'g-1', tabOrder: ['term-1'], activeTabId: 'term-1' })
    ])
    expect(next.tabGroupLayouts?.[WT]).toEqual({ type: 'leaf', groupId: 'g-1' })
    expect(next.activeGroupIdByWorktree?.[WT]).toBe('g-1')
    expect(next.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('persists a move as group order plus each wrapper group and order', () => {
    const session = base({
      unifiedTabs: {
        [WT]: [
          {
            id: 'term-1',
            entityId: 'term-1',
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'terminal',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'a',
            entityId: NOTE,
            groupId: 'g-1',
            worktreeId: WT,
            contentType: 'editor',
            label: '',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: 'a', tabOrder: ['term-1', 'a'] }]
      }
    })

    const next = persistHostTabGroupLayout(session, WT, {
      groups: [
        { id: 'g-1', activeTabId: 'term-1', tabOrder: ['term-1'] },
        { id: 'g-2', activeTabId: 'a', tabOrder: ['a'] }
      ],
      groupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g-1' },
        second: { type: 'leaf', groupId: 'g-2' }
      },
      activeGroupId: 'g-2'
    })

    expect(next.unifiedTabs?.[WT]?.find((tab) => tab.id === 'a')).toMatchObject({
      groupId: 'g-2',
      sortOrder: 0
    })
    expect(next.tabGroups?.[WT]?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g-1', ['term-1']],
      ['g-2', ['a']]
    ])
    expect(next.activeGroupIdByWorktree?.[WT]).toBe('g-2')
  })
})
