import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTopologySlice } from '../../shared/terminal-topology-slice'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeNotifier } from './runtime-notifier-contract'

const WT = 'repo1::/tmp/wt'
const TAB = 'tab-1'
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function sessionWithPty(ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: [
        {
          id: TAB,
          worktreeId: WT,
          ptyId,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: ptyId }
      }
    }
  }
}

function notifierWith(
  terminalTopologyChanged?: RuntimeNotifier['terminalTopologyChanged']
): RuntimeNotifier {
  const ignore = (): void => {}
  return {
    worktreesChanged: ignore,
    reposChanged: ignore,
    activateWorktree: ignore,
    createTerminal: ignore,
    splitTerminal: ignore,
    renameTerminal: ignore,
    focusTerminal: ignore,
    closeTerminal: ignore,
    sleepWorktree: ignore,
    terminalFitOverrideChanged: ignore,
    terminalDriverChanged: ignore,
    ...(terminalTopologyChanged ? { terminalTopologyChanged } : {})
  }
}

/** Store writes reach the runtime only through `onWorkspaceSessionWritten`, as with the real Store. */
function setup() {
  const listeners = new Set<() => void>()
  let session = sessionWithPty('pty-1')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishing reads only repos, folder workspaces and workspace sessions.
  const store = {
    getRepos: () => [{ id: 'repo1' }],
    getRepo: () => ({ id: 'repo1' }),
    getFolderWorkspaces: () => [],
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => session,
    onWorkspaceSessionWritten: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as never
  const runtime = new OrcaRuntimeService(store)
  const pushes: TerminalTopologySlice[] = []
  runtime.setNotifier(notifierWith((slice) => pushes.push(slice)))
  cleanups.push(() => runtime.setNotifier(null))
  // The first pull publishes the starting topology; tests observe what follows.
  const initial = runtime.getTerminalTopologySlices()
  pushes.length = 0
  const write = (next: WorkspaceSessionState): void => {
    session = next
    for (const listener of listeners) {
      listener()
    }
  }
  return { write, runtime, pushes, initial }
}

describe('main publishes terminal topology to the window', () => {
  it('pushes a committed change, and the pull and the reply name the same slice', async () => {
    const { write, runtime, pushes, initial } = setup()
    expect(initial).toEqual([expect.objectContaining({ hostId: 'local', worktreeId: WT })])

    write(sessionWithPty('pty-2'))
    await Promise.resolve()

    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.publishSeq).toBeGreaterThan(initial[0]!.publishSeq)
    expect(pushes[0]!.layouts[TAB]!.ptyIdsByLeafId).toEqual({ [TEST_LEAF_1]: 'pty-2' })
    expect(runtime.getTerminalTopologySlices()).toEqual(pushes)
    expect(runtime.settleTerminalTopology(WT)).toBe(pushes[0]!.publishSeq)
  })

  it('pushes nothing for an identical or presentation-only write', async () => {
    const { write, pushes } = setup()

    write(sessionWithPty('pty-1'))
    const renamed = sessionWithPty('pty-1')
    renamed.tabsByWorktree[WT]![0]!.customTitle = 'renamed'
    write(renamed)
    await Promise.resolve()

    expect(pushes).toEqual([])
  })

  it('a reply settles a write made in the same task before its push goes out', () => {
    const { write, runtime, pushes } = setup()

    write(sessionWithPty('pty-2'))
    const seq = runtime.settleTerminalTopology(WT)

    expect(pushes.map((slice) => slice.publishSeq)).toEqual([seq])
  })

  it('covers a push the window missed while reloading with the pull', async () => {
    const { write, runtime, pushes } = setup()
    runtime.setNotifier(notifierWith())

    const split = sessionWithPty('pty-1')
    split.terminalLayoutsByTabId[TAB] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: TEST_LEAF_1 },
        second: { type: 'leaf', leafId: TEST_LEAF_2 }
      },
      activeLeafId: TEST_LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1', [TEST_LEAF_2]: 'pty-split' }
    }
    write(split)
    await Promise.resolve()
    runtime.setNotifier(notifierWith((slice) => pushes.push(slice)))

    expect(pushes).toEqual([])
    const [pulled] = runtime.getTerminalTopologySlices()
    expect(pulled!.layouts[TAB]!.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'pty-1',
      [TEST_LEAF_2]: 'pty-split'
    })
  })
})
