import '../daemon/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as ProcessTableSnapshotReader from '../../shared/process-table-snapshot-reader'
import type { SubprocessHandle } from '../daemon/session-subprocess-handle'
import { TerminalHost } from '../daemon/terminal-host'
import {
  endCommand,
  expectEveryReaderSawTheClear,
  expectNoReaderLostTheRow,
  launchAgentPane,
  liveRow,
  postHook,
  wireCommandEndHost,
  type CommandEndHost,
  type CommandEndPath
} from './command-end-host-wiring.test-fixture'

// The terminal daemon, Orca's default local backend, answers its shell confirm from its byte
// scanner, which only proves a shell after a full-screen exit. A Codex run in the normal screen
// buffer that quits must still be verified, from the daemon's fenced process evidence.

const processTable = vi.hoisted((): { rows: ProcessTableRow[] } => ({ rows: [] }))
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshotReader>()),
  getStrictProcessTableSnapshotWithAge: async () => ({ rows: processTable.rows, capturedAgeMs: 0 })
}))

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/retirement-clear',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const SHELL_PID = 99_999
const AGENT_PID = 100_100

/** The pane's process table: its zsh alone in front, or a Codex process group in front of it. */
function paneProcesses(front: 'shell' | 'codex'): ProcessTableRow[] {
  const tty = '/dev/pts/7'
  const foregroundPgid = front === 'shell' ? SHELL_PID : AGENT_PID
  const shell = {
    pid: SHELL_PID,
    ppid: 1,
    pgid: SHELL_PID,
    tpgid: foregroundPgid,
    tty,
    startTime: 'shell-birth',
    stat: front === 'shell' ? 'Ss+' : 'Ss',
    command: '/bin/zsh'
  }
  const codex = {
    pid: AGENT_PID,
    ppid: SHELL_PID,
    pgid: AGENT_PID,
    tpgid: foregroundPgid,
    tty,
    startTime: 'codex-birth',
    stat: 'S+',
    command: 'node /opt/homebrew/bin/codex'
  }
  return front === 'shell' ? [shell] : [shell, codex]
}

function createSubprocess(): { handle: SubprocessHandle; emit: (data: string) => void } {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  const handle: SubprocessHandle = {
    pid: SHELL_PID,
    getForegroundProcess: vi.fn(() => 'zsh'),
    // The fresh process read exists, but the daemon only asks it after a full-screen exit.
    confirmShellForeground: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn()
  }
  return { handle, emit: (data) => onData?.(data) }
}

type DaemonPane = {
  host: CommandEndHost
  pane: { ptyId: string; paneKey: string; launchToken: string }
  emit: (data: string) => void
}

const teardowns: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) {
    await teardown()
  }
  processTable.rows = []
  vi.restoreAllMocks()
})

/** An Orca-launched Codex pane whose PTY is a real daemon session. */
async function launchDaemonCodexPane(ptyId: string): Promise<DaemonPane> {
  const subprocess = createSubprocess()
  const terminalHost = new TerminalHost({ spawnSubprocess: () => subprocess.handle })
  teardowns.push(() => terminalHost.dispose())
  const session = await terminalHost.createOrAttach({
    sessionId: ptyId,
    cols: 80,
    rows: 24,
    streamClient: { onData: vi.fn(), onExit: vi.fn() }
  })
  const host = await wireCommandEndHost({
    controller: {
      confirmShellForeground: (id) => terminalHost.confirmShellForeground(id),
      inspectProcess: (id, options) => terminalHost.inspectProcess(id, options)
    }
  })
  teardowns.push(host.teardown)
  const pane = await launchAgentPane(host, ptyId, 'codex', session.incarnationId)
  await postHook(host.server, 'codex', pane, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'codex-session',
    prompt: 'review the PR'
  })
  await postHook(host.server, 'codex', pane, {
    hook_event_name: 'Stop',
    session_id: 'codex-session'
  })
  expect(liveRow(host.server, pane.paneKey)?.state).toBe('done')
  host.readers.republishedWorktrees.length = 0
  return { host, pane, emit: subprocess.emit }
}

/** The same bytes reach the daemon's scanner and main's command-end path. */
async function runCommandToItsEnd(daemonPane: DaemonPane, path: CommandEndPath): Promise<void> {
  // Codex renders inline in the normal screen buffer: no alternate-screen episode.
  daemonPane.emit('\x1b]133;C\x07codex output\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ')
  await endCommand(daemonPane.host.runtime, daemonPane.pane.ptyId, path)
}

describe('a normal-buffer agent on a terminal-daemon pane', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`quits to the shell: the row clears for every reader (${path})`, async () => {
      const daemonPane = await launchDaemonCodexPane(`pty-daemon-exit-${path.replace(' ', '-')}`)
      processTable.rows = paneProcesses('shell')

      await runCommandToItsEnd(daemonPane, path)

      expectEveryReaderSawTheClear(
        daemonPane.host.server,
        daemonPane.host.readers,
        daemonPane.pane.paneKey
      )
    })

    it(`still in front after a nested shell's marker: the row stays (${path})`, async () => {
      const daemonPane = await launchDaemonCodexPane(`pty-daemon-live-${path.replace(' ', '-')}`)
      processTable.rows = paneProcesses('codex')

      await runCommandToItsEnd(daemonPane, path)

      expectNoReaderLostTheRow(
        daemonPane.host.server,
        daemonPane.host.readers,
        daemonPane.pane.paneKey,
        'done'
      )
    })
  }
})
