import { execFileSync } from 'node:child_process'
import * as pty from 'node-pty'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { WRITE_ACCEPTED, writeRefused } from '../../shared/pty-write-settlement'

const itOnPosix = process.platform === 'win32' ? it.skip : it
const PTY_ID = 'real-pty'
const spawned: pty.IPty[] = []

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try {
      proc.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
})

/** The host's real process table: which pids have `pid` as parent. */
function childPids(pid: number): number[] {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    return match && Number(match[2]) === pid ? [Number(match[1])] : []
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for PTY process state')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

itOnPosix(
  'a stand-in agent exiting to its shell flips a headless chat tab and refuses a later composer send',
  async () => {
    const shell = pty.spawn('/bin/sh', [], { name: 'xterm-256color', cols: 80, rows: 24 })
    spawned.push(shell)
    const written: string[] = []
    const base = makeWorkspaceSessionWithHeadlessTerminal()
    const session = {
      ...base,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [{ ...base.tabsByWorktree[TEST_WORKTREE_ID]![0]!, ptyId: PTY_ID }]
      },
      unifiedTabs: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            entityId: 'host-tab',
            groupId: 'group-1',
            worktreeId: TEST_WORKTREE_ID,
            contentType: 'terminal' as const,
            label: 'Agent',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            viewMode: 'chat' as const
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: PTY_ID })
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
    const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
    runtime.setPtyController({
      write: (_ptyId, data) => {
        shell.write(data)
        written.push(data)
        return true
      },
      writeWithSettlement: (_ptyId, data) => {
        try {
          shell.write(data)
          written.push(data)
          return WRITE_ACCEPTED
        } catch {
          return writeRefused('provider_refused_write')
        }
      },
      kill: vi.fn(),
      getForegroundProcess: async () => null,
      // Why this shape: the same answer the SSH relay and the daemon derive from their table.
      inspectProcess: async (): Promise<TerminalProcessInspection> => {
        const children = childPids(shell.pid)
        return {
          foregroundProcess: null,
          hasChildProcesses: children.length > 0,
          childProcessEvidence: children.length > 0 ? 'children' : 'no-children'
        }
      }
    })
    runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'inc-real',
      agentLaunchAuthority: { launchToken: 'token-real', launchAgent: 'claude' }
    })
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    // The stand-in agent runs in the foreground of the real shell.
    shell.write('sleep 60\r')
    await waitFor(() => childPids(shell.pid).length > 0)
    runtime['runAgentExitReconcilePass']()
    await waitFor(() => runtime['agentSightedIncarnationByPtyId'].get(PTY_ID) === 'inc-real')
    expect(getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.viewMode).toBe('chat')

    // It exits; the shell lives on.
    for (const pid of childPids(shell.pid)) {
      process.kill(pid, 'SIGKILL')
    }
    await waitFor(() => childPids(shell.pid).length === 0)
    runtime['runAgentExitReconcilePass']()
    await waitFor(() => getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.viewMode === 'terminal')

    const handle = runtime['handleByPtyId'].get(PTY_ID)!
    const before = written.length
    await expect(
      runtime.sendTerminal(
        handle,
        { text: 'echo shell-canary', enter: true },
        { inputKind: 'driving', chatInput: { actionId: 'stale-composer' } }
      )
    ).resolves.toMatchObject({ accepted: false, bytesWritten: 0, refusedReason: 'agent-exited' })
    expect(written.length).toBe(before)
    runtime['stopAgentExitReconcile']()
  },
  20_000
)
