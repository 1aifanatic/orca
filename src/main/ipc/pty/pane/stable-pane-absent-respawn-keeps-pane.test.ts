// Waking a slept split after a relaunch reattaches each pane to a process the sleep stopped. The
// host answers absent and the pane spawns fresh, so main's copy must keep the pane, its binding and
// the tab row until the fresh spawn's bind swaps them: dropping the pane lets that spawn re-mint
// the tab and reorder the split, a pane shown unbound meanwhile reads as gone to the agent resume,
// and a released row goes to whichever pane binds first.
import { describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from '../../../runtime/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { Store } from '../../../persistence'
import { clearReplacedPaneBinding } from '../../../persistence/loading-store/replaced-pane-binding'
import { applyPtyBinding } from '../../../persistence/loading-store/pty-binding-session-update'
import type { IPtyProvider } from '../../../providers/types'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { spawnForStablePane } from './stable-owner'

const WORKTREE = 'repo-1::/tmp/pane-respawn'
const TAB = 'tab-1'
const SHELL_LEAF = '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const AGENT_LEAF = '2c4d3e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const SHELL_PTY = `${WORKTREE}@@aaaa0001`
const AGENT_PTY = `${WORKTREE}@@aaaa0002`
const SPLIT: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: SHELL_LEAF },
  second: { type: 'leaf', leafId: AGENT_LEAF }
}

const ROW: TerminalTab = {
  id: TAB,
  worktreeId: WORKTREE,
  ptyId: SHELL_PTY,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function sleptSplit(): { store: Store; read: () => WorkspaceSessionState } {
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE]: [ROW] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: SPLIT,
        activeLeafId: AGENT_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SHELL_LEAF]: SHELL_PTY, [AGENT_LEAF]: AGENT_PTY }
      }
    }
  }
  return {
    read: () => session,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the persistence and catalog reads stable-pane adoption and exit bookkeeping use.
    store: withDurableRuntimeStore({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      retirePtyBinding: async (...[binding]: Parameters<Store['retirePtyBinding']>) => {
        session = clearReplacedPaneBinding(session, { ...binding, parentTabId: binding.tabId })
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
  it('keeps the panes, their bindings and the row for the fresh binds to swap', async () => {
    const { store, read } = sleptSplit()
    const before = structuredClone(read())
    const runtime = wakingRuntime(store)

    await respawnOverAbsentProcess(runtime, store, SHELL_LEAF, SHELL_PTY)
    await respawnOverAbsentProcess(runtime, store, AGENT_LEAF, AGENT_PTY)

    expect(read().terminalLayoutsByTabId).toEqual(before.terminalLayoutsByTabId)
    expect(read().tabsByWorktree[WORKTREE]).toEqual([ROW])
  })

  it.each([
    ['shell', SHELL_LEAF, AGENT_LEAF],
    ['agent', AGENT_LEAF, SHELL_LEAF]
  ])(
    'moves the row to the fresh PTY of the pane it named, binding the %s first',
    async (_, ...order) => {
      const { store, read } = sleptSplit()
      const runtime = wakingRuntime(store)
      await respawnOverAbsentProcess(runtime, store, SHELL_LEAF, SHELL_PTY)
      await respawnOverAbsentProcess(runtime, store, AGENT_LEAF, AGENT_PTY)
      const session = structuredClone(read())
      const fresh = { [SHELL_LEAF]: `${SHELL_PTY}-fresh`, [AGENT_LEAF]: `${AGENT_PTY}-fresh` }
      for (const leafId of order) {
        const binding = { worktreeId: WORKTREE, tabId: TAB, leafId, ptyId: fresh[leafId] }
        applyPtyBinding(binding, session, WORKTREE, makePaneKey(TAB, leafId))
      }

      expect(session.tabsByWorktree[WORKTREE]).toEqual([{ ...ROW, ptyId: fresh[SHELL_LEAF] }])
    }
  )
})
