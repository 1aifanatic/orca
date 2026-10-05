import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { applyPtyBinding } from './pty-binding-session-update'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'

const WORKTREE = 'repo1::/worktree'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}

function session(withLayout: 'none' | 'empty' | 'leaf'): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'tab1',
          worktreeId: WORKTREE,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'pty-1'
        }
      ]
    },
    terminalLayoutsByTabId:
      withLayout === 'none'
        ? {}
        : {
            tab1: {
              root: withLayout === 'leaf' ? { type: 'leaf', leafId: TEST_LEAF_1 } : null,
              activeLeafId: withLayout === 'leaf' ? TEST_LEAF_1 : null,
              expandedLeafId: null,
              ptyIdsByLeafId: withLayout === 'leaf' ? { [TEST_LEAF_1]: 'pty-1' } : {}
            }
          },
    terminalPtyIncarnationsByPaneKey: {},
    terminalSurfaceTombstonesByPaneKey: {
      [`tab1:${TEST_LEAF_2}`]: {
        worktreeId: WORKTREE,
        parentTabId: 'tab1',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-old',
        incarnationId: 'inc-old',
        retiredAt: 1
      }
    },
    terminalTopologyRevisionByRepoId: { repo1: 1 }
  }
}

const bind = (overrides: Partial<PersistPtyBindingArgs>): PersistPtyBindingArgs => ({
  worktreeId: WORKTREE,
  tabId: 'tab1',
  leafId: TEST_LEAF_2,
  ptyId: 'pty-2',
  incarnationId: 'inc-2',
  ...overrides
})

describe('applyPtyBinding is copy-on-write', () => {
  const cases: [string, WorkspaceSessionState, PersistPtyBindingArgs][] = [
    ['mints a tab', session('none'), bind({ tabId: 'tab-new' })],
    ['mints a layout', session('none'), bind({})],
    ['fills an empty root', session('empty'), bind({})],
    ['grafts an unknown leaf', session('leaf'), bind({})],
    ['rebinds a present leaf', session('leaf'), bind({ leafId: TEST_LEAF_1 })],
    ['binds a legacy leaf id', session('leaf'), bind({ leafId: 'pane-1' })],
    [
      'host-admits a new tab',
      session('none'),
      bind({ tabId: 'tab-new', hostAdmittedMembership: true })
    ]
  ]

  it.each(cases)('%s without touching its frozen input', (_name, input, args) => {
    vi.useFakeTimers({ toFake: ['Date'], now: 5 })
    const before = structuredClone(input)
    const paneKey = `${args.tabId}:${args.leafId}`
    const bound = applyPtyBinding(args, deepFreeze(input), WORKTREE, paneKey)
    vi.useRealTimers()
    expect(input).toEqual(before)
    expect(bound).not.toBe(input)
    expect(bound.terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe('inc-2')
    expect(bound.terminalSurfaceTombstonesByPaneKey?.[paneKey]).toBeUndefined()
    expect(bound.defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE]).toBe(true)
  })

  it('grafts the same tree it grafted in place', () => {
    const bound = applyPtyBinding(bind({}), deepFreeze(session('leaf')), WORKTREE, 'k')
    expect(bound.terminalLayoutsByTabId.tab1).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: TEST_LEAF_1 },
        second: { type: 'leaf', leafId: TEST_LEAF_2 }
      },
      activeLeafId: TEST_LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1', [TEST_LEAF_2]: 'pty-2' }
    })
    expect(bound.terminalTopologyRevisionByRepoId).toEqual({ repo1: 2 })
  })
})
