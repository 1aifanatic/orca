import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '@/store/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import {
  resolveNativeChatFileLink,
  resolveNativeChatFileLinkContext,
  type NativeChatFileLinkContext,
  type NativeChatFileLinkState
} from './native-chat-file-link'
import { detectedListingFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'
import type { NativeChatTabScope } from './native-chat-tab-scope'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function state(overrides: Partial<NativeChatFileLinkState> = {}): NativeChatFileLinkState {
  return {
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null,
    projectGroups: [],
    repos: [],
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null },
    tabsByWorktree: {
      'wt-1': [terminalTab()]
    },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {
      repo: [worktreeFixture('wt-1', '/repo/worktree')]
    },
    ...overrides
  }
}

const bridge = (tabId = 'tab-1', worktreeId = 'wt-1'): NativeChatTabScope => ({
  kind: 'bridge',
  worktreeId,
  tabId
})
const structured = (tabId: string, worktreeId = 'wt-1'): NativeChatTabScope => ({
  kind: 'structured',
  worktreeId,
  tabId
})

const context: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo/worktree',
  runtimeEnvironmentId: null
}

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

describe('resolveNativeChatFileLinkContext', () => {
  it('returns the owner worktree path and runtime for a native chat terminal tab', () => {
    expect(
      resolveNativeChatFileLinkContext(
        state({
          settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
        }),
        bridge()
      )
    ).toEqual({
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('returns null when the terminal tab is missing from its supplied workspace', () => {
    expect(resolveNativeChatFileLinkContext(state({ tabsByWorktree: {} }), bridge())).toBeNull()
  })

  it('never follows a tab that moved to another workspace', () => {
    expect(
      resolveNativeChatFileLinkContext(
        state({ tabsByWorktree: { 'wt-1': [], 'wt-2': [terminalTab({ worktreeId: 'wt-2' })] } }),
        bridge()
      )
    ).toBeNull()
  })

  it('resolves the worktree context for a structured session tab from its unified bucket only', () => {
    const withStructured = state({
      tabsByWorktree: {},
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
    expect(resolveNativeChatFileLinkContext(withStructured, structured(structuredTab.id))).toEqual(
      context
    )
    // A structured chat is not a terminal tab, even when a terminal row shares its id.
    expect(
      resolveNativeChatFileLinkContext(
        state({ tabsByWorktree: { 'wt-1': [terminalTab({ id: structuredTab.id })] } }),
        structured(structuredTab.id)
      )
    ).toBeNull()
  })

  it('rejects a same-id unified row of another content type', () => {
    expect(
      resolveNativeChatFileLinkContext(
        state({
          unifiedTabsByWorktree: { 'wt-1': [{ ...structuredTab, contentType: 'terminal' }] }
        }),
        structured(structuredTab.id)
      )
    ).toBeNull()
  })

  it('builds the whole result from the supplied snapshot, never a live catalog getter', () => {
    // A store getter closes over a newer snapshot; the resolver must not consult it.
    const snapshotA = Object.assign(state(), {
      getKnownWorktreeById: () => worktreeFixture('wt-1', '/snapshot-b')
    })
    expect(resolveNativeChatFileLinkContext(snapshotA, bridge())?.worktreePath).toBe(
      '/repo/worktree'
    )
  })

  it('resolves a detected-only workspace from the supplied snapshot catalog', () => {
    expect(
      resolveNativeChatFileLinkContext(
        state({
          worktreesByRepo: {},
          detectedWorktreesByRepo: {
            repo: detectedListingFixture([worktreeFixture('wt-1', '/repo/detected')])
          }
        }),
        bridge()
      )
    ).toEqual({ worktreeId: 'wt-1', worktreePath: '/repo/detected', runtimeEnvironmentId: null })
  })

  it('resolves a folder workspace tab from its folder path when no projected worktree path exists', () => {
    const folderId = 'folder-1'
    const folderKey = folderWorkspaceKey(folderId)
    const folderTab = terminalTab({ worktreeId: folderKey })
    expect(
      resolveNativeChatFileLinkContext(
        state({
          tabsByWorktree: { [folderKey]: [folderTab] },
          folderWorkspaces: [{ id: folderId, folderPath: '/workspace/platform' } as never],
          worktreesByRepo: {}
        }),
        bridge(folderTab.id, folderKey)
      )
    ).toEqual({
      worktreeId: folderKey,
      worktreePath: '/workspace/platform',
      runtimeEnvironmentId: null
    })
  })
})

describe('floating workspace native chat', () => {
  const floatingTab = {
    ...structuredTab,
    id: 'floating-chat-1',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    groupId: 'floating-group'
  } satisfies Tab
  const floatingScope = structured(floatingTab.id, FLOATING_TERMINAL_WORKTREE_ID)

  function floatingState(floatingWorkspacePath: string | null): NativeChatFileLinkState {
    return state({
      tabsByWorktree: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      worktreesByRepo: {},
      // Why a focused runtime: floating must stay local even when one is selected.
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' },
      floatingWorkspacePath
    })
  }

  it('waits for the floating directory without any path context', () => {
    expect(resolveNativeChatFileLinkContext(floatingState(null), floatingScope)).toBeNull()
  })

  it('resolves file links against the pinned folder after the floating setting moved', () => {
    const pinned = {
      ...floatingState('/home/me/changed-setting'),
      structuredSessionLaunchDirectoryByTabId: {
        [floatingTab.id]: { sessionId: floatingTab.entityId, launchDirectory: '/home/me/pinned' }
      }
    }
    expect(resolveNativeChatFileLinkContext(pinned, floatingScope)).toEqual({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreePath: '/home/me/pinned',
      runtimeEnvironmentId: null
    })
  })

  it('resolves no file links until the pin arrives, instead of trusting the current setting', () => {
    expect(
      resolveNativeChatFileLinkContext(floatingState('/home/me/changed-setting'), floatingScope)
    ).toBeNull()
  })
})

describe('resolveNativeChatFileLink', () => {
  it('resolves repo-relative file links against the chat worktree', () => {
    expect(resolveNativeChatFileLink('docs/guide.md', context)).toEqual({
      absolutePath: '/repo/worktree/docs/guide.md',
      line: null,
      column: null
    })
  })

  it('resolves explicit hrefs for non-markdown file types', () => {
    expect(resolveNativeChatFileLink('src/App.tsx#L42', context)).toEqual({
      absolutePath: '/repo/worktree/src/App.tsx',
      line: 42,
      column: null
    })
    expect(resolveNativeChatFileLink('package.json', context)).toEqual({
      absolutePath: '/repo/worktree/package.json',
      line: null,
      column: null
    })
    expect(resolveNativeChatFileLink('assets/logo.png?raw=true', context)).toEqual({
      absolutePath: '/repo/worktree/assets/logo.png',
      line: null,
      column: null
    })
    expect(resolveNativeChatFileLink('CODEOWNERS', context)).toEqual({
      absolutePath: '/repo/worktree/CODEOWNERS',
      line: null,
      column: null
    })
  })

  it('preserves terminal-style line and column suffixes', () => {
    expect(resolveNativeChatFileLink('/repo/worktree/src/main.ts:12:4', context)).toEqual({
      absolutePath: '/repo/worktree/src/main.ts',
      line: 12,
      column: 4
    })
  })

  it('resolves encoded file URIs', () => {
    expect(resolveNativeChatFileLink('file:///repo/worktree/My%20File.md#L7', context)).toEqual({
      absolutePath: '/repo/worktree/My File.md',
      line: 7,
      column: null
    })
  })

  it('decodes escaped reserved characters in repo-relative hrefs', () => {
    expect(resolveNativeChatFileLink('docs/Setup%20%231.md#L3', context)).toEqual({
      absolutePath: '/repo/worktree/docs/Setup #1.md',
      line: 3,
      column: null
    })
  })

  it('ignores http links so normal markdown navigation can handle them', () => {
    expect(resolveNativeChatFileLink('https://example.com/docs/guide.md', context)).toBeNull()
  })
})
