import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import { launchedTerminal } from './rpc/methods/agent-launch-owed-prompt-host'

// What an owed prompt records as its agent's PTY, read from a terminal the runtime really made: a
// null here would leave every owed prompt unresumable after a restart, with every mocked test green.
describe('the PTY a launched terminal records for its owed prompt', () => {
  it('is the spawned PTY and its incarnation', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'bg-pty', incarnationId: 'inc-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'bg-tab',
      leafId: HEADLESS_LEAF_ID
    })

    expect(
      launchedTerminal(runtime, {
        outcome: { kind: 'terminal', handle: terminal.handle, paneKey: 'bg-tab:leaf' },
        worktreeId: TEST_WORKTREE_ID,
        receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' }
      })
    ).toEqual({ ptyId: 'bg-pty', incarnationId: 'inc-1' })
  })
})
