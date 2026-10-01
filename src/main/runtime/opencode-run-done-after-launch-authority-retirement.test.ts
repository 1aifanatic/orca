import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readCommandLineMock } = vi.hoisted(() => ({ readCommandLineMock: vi.fn() }))

vi.mock('./local-pty-foreground-command-line', () => ({
  readLocalPtyForegroundCommandLine: readCommandLineMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { AgentHookServer } from '../agent-hooks/server'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { FOREGROUND_COMMAND_READS } from '../../shared/foreground-command-settle'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-1'
const INCARNATION_ID = 'incarnation-1'

let userDataPath: string
let server: AgentHookServer

function persistedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: INCARNATION_ID }
  }
}

// The real desktop wiring: runtime status and launch-authority retirement both land in the hook server.
function createRuntime(): OrcaRuntimeService {
  const session = persistedSession()
  const store = {
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getSettings: () => ({}),
    getWorkspaceSession: () => session
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refresh reads only the members stubbed above.
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    onTerminalAgentStatus: (event) => server.ingestTerminalStatus(event),
    onTerminalSideEffects: () => {},
    retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey)
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'opencode',
    listProcesses: async () => [
      {
        id: PTY_ID,
        cwd: '/worktree',
        title: 'zsh',
        worktreeId: WORKTREE_ID,
        incarnationId: INCARNATION_ID,
        terminalHandle: 'term_restored'
      }
    ]
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
    ]
  })
  return runtime
}

function paneState(): string {
  return server.getStatusSnapshotForPane(PANE_KEY)[0]?.state ?? 'missing'
}

async function startOpenCodeRun(runtime: OrcaRuntimeService): Promise<void> {
  runtime.onPtyData(PTY_ID, '\x1b]133;C\x07', 100)
  await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
  expect(paneState()).toBe('working')
}

beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-opencode-run-retired-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  readCommandLineMock.mockReset()
  readCommandLineMock.mockResolvedValue('opencode run fix the bug')
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(userDataPath, { recursive: true, force: true })
})

// `orca terminal list` / `worktree ps` / mobile refreshes arm restored launch authority on the pane, so
// the run's 133;D retires it. The run's own Done must still land, as any finished turn does.
describe('OpenCode run Done after its command retires launch authority', () => {
  it('keeps the Done of a visible pane after an inventory refresh', async () => {
    const runtime = createRuntime()
    await runtime.listTerminals()
    await startOpenCodeRun(runtime)

    runtime.onPtyData(PTY_ID, 'done\x1b]133;D;0\x07', 101)

    expect(paneState()).toBe('done')
  })

  it('keeps the Done of a hidden pane whose daemon reported the command end', async () => {
    const runtime = createRuntime()
    await runtime.listTerminals()
    await startOpenCodeRun(runtime)

    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

    expect(paneState()).toBe('done')
  })

  it('keeps the Done when the wall clock steps back during the run', async () => {
    const runtime = createRuntime()
    await runtime.listTerminals()
    await startOpenCodeRun(runtime)

    vi.setSystemTime(Date.now() - 60_000)
    runtime.onPtyData(PTY_ID, 'done\x1b]133;D;0\x07', 101)

    expect(paneState()).toBe('done')
  })
})
