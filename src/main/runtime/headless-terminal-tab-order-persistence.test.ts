import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import { makeTerminalTab, TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const WT = 'r1::/repo'

function leafLayout(leafId: string, ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

describe('a mobile reorder on a windowless host', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-headless-tab-order-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists the new terminal tab order, so a restart lists the tabs as moved', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WT]: [
          makeTerminalTab({ id: 'tab-a', worktreeId: WT, ptyId: 'pty-a', sortOrder: 0 }),
          makeTerminalTab({ id: 'tab-b', worktreeId: WT, ptyId: 'pty-b', sortOrder: 1 })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-a': leafLayout(TEST_LEAF_1, 'pty-a'),
        'tab-b': leafLayout(TEST_LEAF_2, 'pty-b')
      }
    })
    const runtime = new OrcaRuntimeService(store)
    const listed = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(listed.tabGroups?.[0]?.tabOrder).toEqual(['tab-a', 'tab-b'])

    await runtime.moveMobileSessionTab(`id:${WT}`, {
      kind: 'reorder',
      tabId: 'tab-b',
      targetGroupId: listed.tabGroups![0]!.id,
      tabOrder: ['tab-b', 'tab-a']
    })
    store.flush()

    const sortOrders = (rows = store.getWorkspaceSession().tabsByWorktree[WT] ?? []) =>
      Object.fromEntries(rows.map((tab) => [tab.id, tab.sortOrder]))
    expect(sortOrders()).toEqual({ 'tab-b': 0, 'tab-a': 1 })
    const restarted = new OrcaRuntimeService(createStore())
    const relisted = await restarted.listMobileSessionTabs(`id:${WT}`)
    expect(relisted.tabGroups?.[0]?.tabOrder).toEqual(['tab-b', 'tab-a'])
  })
})
