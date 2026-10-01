import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

// Synthetic titles: display surfaces must show what the tab shows once the stale-working timer
// clears a title, although the runtime keeps the agent's own title as evidence.
describe('display surfaces after the stale-working title clear', () => {
  it('worktree ps and the phone show the cleared status for a terminal with no renderer pane', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'bg-pty' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-empty',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'codex',
        tabId: 'bg-tab',
        leafId: HEADLESS_LEAF_ID
      })
      const psStatus = async () =>
        (await runtime.getWorktreePs()).worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
          ?.status
      const phoneTabs = async () =>
        (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.map((tab) => ({
          title: 'title' in tab ? tab.title : undefined,
          state: 'agentStatus' in tab ? tab.agentStatus?.state : undefined
        }))
      runtime.onPtyData('bg-pty', '\x1b]0;Codex working\x07', Date.now())
      runtime.onPtyData('bg-pty', 'output without a title\r\n', Date.now())
      expect(await psStatus()).toBe('working')
      expect(await phoneTabs()).toEqual([{ title: 'Codex working', state: 'working' }])

      await vi.advanceTimersByTimeAsync(3_000)

      expect(await psStatus()).toBe('active')
      expect(await phoneTabs()).toEqual([{ title: 'Codex', state: 'done' }])
      const listed = (await runtime.listTerminals()).terminals.find(
        (candidate) => candidate.handle === terminal.handle
      )
      expect(listed?.title).toBe('Codex')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a reattach restore seed does not bring the cleared working status back', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'Codex working' })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', Date.now())
      runtime.onPtyData('pty-1', 'output without a title\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      // The renderer applies the cleared fact and republishes its pane title.
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'Codex' })
      const psStatus = async () =>
        (await runtime.getWorktreePs()).worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
          ?.status
      expect(await psStatus()).toBe('active')
      // A renderer reload reattaches with the daemon's last title, as the spawn RPC path does.
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex working' })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'Codex' })
      expect(await psStatus()).toBe('active')
    } finally {
      vi.useRealTimers()
    }
  })
})
