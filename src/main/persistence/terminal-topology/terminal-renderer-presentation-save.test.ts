import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { projectTerminalTopologySlice } from '../../runtime/terminal-topology-projection'
import { mergeRendererPresentationSave } from './terminal-renderer-presentation-save'

const WORKTREE = 'repo::/worktree'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const RUNTIME_HOST = 'runtime:env-1'

function row(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function unified(id: string, contentType: Tab['contentType'] = 'terminal'): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group',
    worktreeId: WORKTREE,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sleeping(paneKey: string, capturedAt: number): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${capturedAt}` },
    prompt: 'finish',
    state: 'waiting',
    capturedAt,
    updatedAt: capturedAt,
    origin: 'worktree-sleep'
  }
}

function splitRoot(ratio: number): TerminalLayoutSnapshot['root'] {
  return {
    type: 'split',
    direction: 'vertical',
    ratio,
    first: { type: 'leaf', leafId: LEFT },
    second: { type: 'leaf', leafId: RIGHT }
  }
}

const splitLayout: TerminalLayoutSnapshot = {
  root: splitRoot(0.3),
  activeLeafId: LEFT,
  expandedLeafId: null,
  ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
}

/** What main holds: one split tab, its sleeping agent, a close record and fences. */
function mainSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE]: [row('tab', { launchAgent: 'codex', ptyId: 'pty-left' })] },
    terminalLayoutsByTabId: { tab: splitLayout },
    unifiedTabs: { [WORKTREE]: [unified('tab')] },
    tabGroups: {
      [WORKTREE]: [{ id: 'group', worktreeId: WORKTREE, activeTabId: 'tab', tabOrder: ['tab'] }]
    },
    activeTabIdByWorktree: { [WORKTREE]: 'tab' },
    sleepingAgentSessionsByPaneKey: { [`tab:${LEFT}`]: sleeping(`tab:${LEFT}`, 1) },
    terminalPtyIncarnationsByPaneKey: { [`tab:${LEFT}`]: 'incarnation-left' },
    closedTerminalTabTombstonesByTabId: {
      closed: { worktreeId: WORKTREE, closedAt: 5 }
    },
    terminalTopologyRevisionByRepoId: { repo: 3 },
    defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE]: true }
  }
}

/** Main's own authority: what the slice publishes plus the records no slice carries. */
function mainAuthority(session: WorkspaceSessionState) {
  return {
    slice: projectTerminalTopologySlice(session, 'local', WORKTREE),
    incarnations: session.terminalPtyIncarnationsByPaneKey,
    closed: session.closedTerminalTabTombstonesByTabId,
    defaults: session.defaultTerminalTabsAppliedByWorktreeId
  }
}

describe('mergeRendererPresentationSave', () => {
  it('a stale or extra tab, layout, binding or sleeping record changes nothing main authors', () => {
    const prior = mainSession()
    const stale: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE]: [
          // The window's ptyId is its live attachment, not main's binding.
          row('tab', { ptyId: 'pty-window', launchAgent: 'codex' }),
          row('extra')
        ]
      },
      terminalLayoutsByTabId: {
        tab: {
          ...splitLayout,
          root: splitRoot(0.9),
          ptyIdsByLeafId: { [LEFT]: 'pty-window' }
        },
        extra: { root: { type: 'leaf', leafId: RIGHT }, activeLeafId: RIGHT, expandedLeafId: null }
      },
      sleepingAgentSessionsByPaneKey: { [`extra:${RIGHT}`]: sleeping(`extra:${RIGHT}`, 2) },
      unifiedTabs: { [WORKTREE]: [unified('tab'), unified('extra')] },
      tabGroups: {
        [WORKTREE]: [
          { id: 'group', worktreeId: WORKTREE, activeTabId: 'extra', tabOrder: ['tab', 'extra'] }
        ]
      },
      activeTabIdByWorktree: { [WORKTREE]: 'extra' }
    }

    const saved = mergeRendererPresentationSave(stale, prior, 'local')

    expect(mainAuthority(saved)).toEqual(mainAuthority(prior))
    expect(saved.sleepingAgentSessionsByPaneKey).toEqual(prior.sleepingAgentSessionsByPaneKey)
    expect(saved.terminalTopologyRevisionByRepoId).toEqual({ repo: 3 })
    expect(saved.unifiedTabs?.[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab'])
    expect(saved.tabGroups?.[WORKTREE]).toEqual([
      { id: 'group', worktreeId: WORKTREE, activeTabId: 'tab', tabOrder: ['tab'] }
    ])
    expect(saved.activeTabIdByWorktree?.[WORKTREE]).toBe('tab')
  })

  it('takes presentation per tab and per leaf, on the panes main holds', () => {
    const prior = mainSession()
    const window: WorkspaceSessionState = {
      ...prior,
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: {
        [WORKTREE]: [
          row('tab', { title: 'npm test', customTitle: 'Tests', color: 'red', sortOrder: 4 })
        ]
      },
      terminalLayoutsByTabId: {
        tab: {
          ...splitLayout,
          activeLeafId: RIGHT,
          expandedLeafId: RIGHT,
          buffersByLeafId: { [RIGHT]: 'scrollback' },
          titlesByLeafId: { [LEFT]: 'Server' }
        }
      }
    }

    const saved = mergeRendererPresentationSave(window, prior, 'local')

    expect(saved.tabsByWorktree[WORKTREE]).toEqual([
      // Row fields are the window's (it clears launchAgent when the launching pane closes).
      row('tab', {
        ptyId: 'pty-left',
        title: 'npm test',
        customTitle: 'Tests',
        color: 'red',
        sortOrder: 4
      })
    ])
    expect(saved.terminalLayoutsByTabId.tab).toEqual({
      ...splitLayout,
      activeLeafId: RIGHT,
      expandedLeafId: RIGHT,
      buffersByLeafId: { [RIGHT]: 'scrollback' },
      titlesByLeafId: { [LEFT]: 'Server' }
    })
    expect(saved.unifiedTabs).toEqual(prior.unifiedTabs)
  })

  it('a layout naming other panes is stale, so main keeps its whole layout', () => {
    const prior = mainSession()
    const saved = mergeRendererPresentationSave(
      {
        ...prior,
        terminalLayoutsByTabId: {
          tab: {
            root: { type: 'leaf', leafId: LEFT },
            activeLeafId: LEFT,
            expandedLeafId: null,
            titlesByLeafId: { [LEFT]: 'Server' }
          }
        }
      },
      prior,
      'local'
    )
    expect(saved.terminalLayoutsByTabId.tab).toBe(prior.terminalLayoutsByTabId.tab)
  })

  it('restores the tab bar entry of a tab the window has not shown yet', () => {
    const prior = mainSession()
    const saved = mergeRendererPresentationSave(
      { ...prior, unifiedTabs: { [WORKTREE]: [unified('editor', 'editor')] } },
      prior,
      'local'
    )
    expect(saved.unifiedTabs?.[WORKTREE]?.map((tab) => tab.id)).toEqual(['editor', 'tab'])
  })

  it('a presentation patch stays one and cannot carry sleeping records', () => {
    const prior = mainSession()
    const patch = mergeRendererPresentationSave(
      {
        activeWorktreeId: WORKTREE,
        sleepingAgentSessionsByPaneKey: {},
        defaultTerminalTabsAppliedByWorktreeId: undefined
      },
      prior,
      'local'
    )
    expect(patch).not.toHaveProperty('tabsByWorktree')
    expect(patch).not.toHaveProperty('terminalLayoutsByTabId')
    expect(patch.sleepingAgentSessionsByPaneKey).toBe(prior.sleepingAgentSessionsByPaneKey)
    expect(patch.defaultTerminalTabsAppliedByWorktreeId).toEqual({ [WORKTREE]: true })
  })

  it("keeps the window's terminal rows and sleeping records for another server's partition", () => {
    const prior = { ...mainSession(), terminalTopologyRevisionByRepoId: { other: 1 } }
    const window: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE]: [row('remote-tab', { ptyId: 'remote:env@@handle' })] },
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [`remote-tab:${LEFT}`]: sleeping(`remote-tab:${LEFT}`, 2) }
    }

    const saved = mergeRendererPresentationSave(window, prior, RUNTIME_HOST)

    expect(saved.tabsByWorktree).toEqual(window.tabsByWorktree)
    expect(saved.sleepingAgentSessionsByPaneKey).toBe(window.sleepingAgentSessionsByPaneKey)
    // Records only main writes survive a save into any partition.
    expect(saved.closedTerminalTabTombstonesByTabId).toBe(prior.closedTerminalTabTombstonesByTabId)
    expect(saved.terminalTopologyRevisionByRepoId).toBe(prior.terminalTopologyRevisionByRepoId)
    // Once main fenced the repo there (a worktree removal), main's rows stand as before.
    const fenced = mergeRendererPresentationSave(window, mainSession(), RUNTIME_HOST)
    expect(fenced.tabsByWorktree).toEqual(mainSession().tabsByWorktree)
  })
})
