// Waking a slept split after a relaunch reattaches each pane to a process the sleep stopped. The
// host answers absent and the pane spawns fresh, so main's copy must keep the pane and its binding
// until the fresh spawn's bind swaps it: dropping the pane lets that spawn re-mint the tab and
// reorder the split, and a pane shown unbound meanwhile reads as gone to the agent resume.
import { describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from '../../../runtime/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { Store } from '../../../persistence'
import { clearReplacedPaneBinding } from '../../../persistence/loading-store/replaced-pane-binding'
import type { IPtyProvider } from '../../../providers/types'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { spawnForStablePane } from './stable-owner'

const WORKTREE = 'repo-1::/tmp/pane-respawn'
const TAB = 'tab-1'
const SHELL_LEAF = '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const AGENT_LEAF = '2c4d3e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const SHELL_PTY = `${WORKTREE}@@aaaa0001`
const AGENT_PTY = `${WORKTREE}@@aaaa0002`
const SPLIT = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: SHELL_LEAF },
  second: { type: 'leaf', leafId: AGENT_LEAF }
}

function sleptSplit(): { store: Store; read: () => WorkspaceSessionState } {
  let session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE]: [{ id: TAB, worktreeId: WORKTREE, ptyId: SHELL_PTY }] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: SPLIT,
        activeLeafId: AGENT_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SHELL_LEAF]: SHELL_PTY, [AGENT_LEAF]: AGENT_PTY }
      }
    }
  } as unknown as WorkspaceSessionState
  return {
    read: () => session,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the persistence and catalog reads stable-pane adoption and exit bookkeeping use.
    store: withDurableRuntimeStore({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      // The store's host-side binding retirement, applying the change the caller names.
      retirePtyBinding: async (
        ...[binding, , retire = clearReplacedPaneBinding]: Parameters<Store['retirePtyBinding']>
      ) => {
        session = retire(session, { ...binding, parentTabId: binding.tabId })
        return true
      },
      flushOrThrow: () => {},
      getRepos: () => [
        {
          id: 'repo-1',
          path: '/tmp/pane-respawn',
          displayName: 'r',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => {},
      removeWorktreeMeta: () => {},
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => []
    }) as unknown as Store
  }
}

/** The waking window names each pane's slept PTY, as its graph does before the reattach. */
function wakingRuntime(store: Store): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    hasPty: () => null,
    listProcesses: async () => [],
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  runtime.registerPty(SHELL_PTY, WORKTREE, null, { tabId: TAB, leafId: SHELL_LEAF })
  runtime.registerPty(AGENT_PTY, WORKTREE, null, { tabId: TAB, leafId: AGENT_LEAF })
  return runtime
}

async function respawnOverAbsentProcess(
  runtime: OrcaRuntimeService,
  store: Store,
  leafId: string,
  ptyId: string
): Promise<void> {
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(new SessionNotFoundError(ptyId))
    .mockResolvedValueOnce({ id: `${ptyId}-fresh`, isReattach: false })
  const result = await spawnForStablePane({
    runtime,
    store,
    provider: { spawn } as unknown as IPtyProvider,
    spawnOptions: { cols: 80, rows: 24 },
    owner: { tabId: TAB, leafId, ptyId, hasPersistedBinding: true },
    worktreeId: WORKTREE,
    resolveOwner: () => null
  })
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(result.owner).toBeNull()
}

describe('a stable pane respawned over an absent process', () => {
  it('keeps the panes and their bindings, releasing only the row of the gone process', async () => {
    const { store, read } = sleptSplit()
    const before = structuredClone(read())
    const runtime = wakingRuntime(store)

    await respawnOverAbsentProcess(runtime, store, SHELL_LEAF, SHELL_PTY)
    await respawnOverAbsentProcess(runtime, store, AGENT_LEAF, AGENT_PTY)

    expect(read().terminalLayoutsByTabId).toEqual(before.terminalLayoutsByTabId)
    // The row named the shell's gone process; the first pane to bind takes it.
    expect(read().tabsByWorktree[WORKTREE]).toEqual([
      { id: TAB, worktreeId: WORKTREE, ptyId: null }
    ])
  })
})
