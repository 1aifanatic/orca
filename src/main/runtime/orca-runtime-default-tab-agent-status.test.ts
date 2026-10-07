// A host-side create dresses its agent's tab as the first orca.yaml default tab. That title
// belongs to the tab, as the window's setTabCustomTitle makes it: on a headless host the
// phone must still read the agent's own titles for its status.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createMinimalPersistedTerminalTab } from '../persistence/restoring-sessions/session-owner-fields'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import {
  provisionWorktreeTerminals,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'wt-1'
const AGENT_TAB_ID = 'agent-tab'
const AGENT_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_PTY_ID = 'pty-agent'

async function createHeadlessRuntimeWithAgent(
  connectionId: string | null = null,
  store: unknown = null
): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId,
    repo: null,
    folderWorkspace: null
  })
  let spawned = 0
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: spawned++ === 0 ? AGENT_PTY_ID : `pty-${spawned}` })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const agent = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: AGENT_TAB_ID,
    leafId: AGENT_LEAF_ID,
    launchAgent: 'claude'
  })
  return { runtime, handle: agent.handle }
}

function provisioningHost(runtime: OrcaRuntimeService): WorktreeTerminalProvisioningHost {
  return (
    runtime as unknown as {
      getWorktreeTerminalProvisioningHost: () => WorktreeTerminalProvisioningHost
    }
  ).getWorktreeTerminalProvisioningHost()
}

async function dressAgentTab(runtime: OrcaRuntimeService, handle: string): Promise<void> {
  // Only the handle crosses: the host finds the tab, as it must for a create over SSH too.
  await provisionWorktreeTerminals(provisioningHost(runtime), {
    worktreeSelector: `id:${WORKTREE_ID}`,
    worktreeId: WORKTREE_ID,
    worktreePath: '/repo/app',
    defaultTabs: {
      runCommands: true,
      tabs: [{ title: 'Dev', command: 'pnpm dev', color: '#ff0000' }]
    },
    primaryTerminalHandle: handle,
    hasStartupTerminal: true,
    setupCommandPlatform: 'posix'
  })
}

async function agentTab(runtime: OrcaRuntimeService) {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.parentTabId === AGENT_TAB_ID
  )
  if (tab?.type !== 'terminal') {
    throw new Error('expected the agent terminal tab')
  }
  return tab
}

describe('the agent tab a host-side create dresses as the first default tab', () => {
  it.each([
    ['a local', null],
    ['an SSH', 'ssh-1']
  ])(
    'gives %s agent tab the template title and color before the agent titles itself',
    async (_, connectionId) => {
      const { runtime, handle } = await createHeadlessRuntimeWithAgent(connectionId)
      await dressAgentTab(runtime, handle)

      expect(await agentTab(runtime)).toEqual(
        expect.objectContaining({ title: 'Dev', color: '#ff0000' })
      )
    }
  )

  it("keeps the phone's status on the agent's own titles", async () => {
    const { runtime, handle } = await createHeadlessRuntimeWithAgent()
    await dressAgentTab(runtime, handle)

    runtime.onPtyData(AGENT_PTY_ID, '\x1b]0;⠋ Claude\x07', Date.now())

    expect((await agentTab(runtime)).agentStatus).toEqual(
      expect.objectContaining({ state: 'working' })
    )
  })

  it('titles the tab, never the pane, and keeps the title across a restart', async () => {
    // The spawn's pty binding has already saved the agent's tab when provisioning runs.
    let session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          createMinimalPersistedTerminalTab({
            worktreeId: WORKTREE_ID,
            tabId: AGENT_TAB_ID,
            ptyId: AGENT_PTY_ID,
            existingTabCount: 0
          })
        ]
      }
    }
    const store = {
      getSettings: () => ({}),
      getRepos: () => [],
      getRepo: () => undefined,
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      }
    }
    const { runtime, handle } = await createHeadlessRuntimeWithAgent(null, store)
    const renameTerminal = vi.fn()
    runtime.setNotifier({ renameTerminal } as never)

    await dressAgentTab(runtime, handle)

    expect(renameTerminal).toHaveBeenCalledWith(AGENT_TAB_ID, 'Dev', { recordInteraction: false })
    const ptys = (runtime as unknown as { ptysById: Map<string, { title: string | null }> })
      .ptysById
    expect(ptys.get(AGENT_PTY_ID)?.title).toBeNull()
    // A restarted headless host rebuilds the phone's tabs from the saved session.
    const restored = buildHeadlessMobileSessionTerminalTabs(
      WORKTREE_ID,
      session.tabsByWorktree[WORKTREE_ID]!,
      session
    )
    expect(restored).toEqual([
      expect.objectContaining({ parentTabId: AGENT_TAB_ID, title: 'Dev', color: '#ff0000' })
    ])
  })

  it("still titles the tab once the window's graph has taken over the handle", async () => {
    const { runtime, handle } = await createHeadlessRuntimeWithAgent()
    const renameTerminal = vi.fn()
    runtime.setNotifier({ renameTerminal } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: AGENT_TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: AGENT_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: AGENT_TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: AGENT_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: AGENT_PTY_ID
        }
      ]
    })

    await provisioningHost(runtime).setTabTitle(handle, 'Dev')

    expect(renameTerminal).toHaveBeenCalledWith(AGENT_TAB_ID, 'Dev', { recordInteraction: false })
  })
})
