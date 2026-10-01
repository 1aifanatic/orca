import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import {
  endCommand,
  expectEveryReaderSawTheClear,
  expectNoReaderLostTheRow,
  launchAgentPane,
  liveRow,
  postHook,
  settle,
  shellPane,
  wireCommandEndHost,
  type CommandEndHost
} from './command-end-host-wiring.test-fixture'

// A command end (OSC 133;D) in a pane whose agent holds a live row asks the execution host whether
// that agent exited, every time, whatever launched it. A verified exit clears the row for every
// reader in one step; anything short of proof keeps it until the next command end asks again.
// A full-screen agent's nested shells leak their own 133;D, so the mark alone proves nothing.

const probe = vi.hoisted(() => vi.fn())
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

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

const hosts: CommandEndHost[] = []

afterEach(() => {
  probe.mockReset()
  for (const host of hosts.splice(0)) {
    host.teardown()
  }
  vi.restoreAllMocks()
})

async function wire(): Promise<CommandEndHost> {
  const host = await wireCommandEndHost()
  hosts.push(host)
  return host
}

const CLAUDE_PROCESS = {
  agentProcess: JSON.stringify({ pid: 4001, platform: process.platform, startTime: 'birth' })
}

async function claudeIsWorking(
  host: CommandEndHost,
  pane: { paneKey: string; launchToken?: string },
  extra: Record<string, unknown> = {}
): Promise<void> {
  await postHook(
    host.server,
    'claude',
    pane,
    { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: 'review the PR' },
    extra
  )
  expect(liveRow(host.server, pane.paneKey)?.state).toBe('working')
}

async function claudeIsDone(host: CommandEndHost, pane: { paneKey: string }): Promise<void> {
  await postHook(host.server, 'claude', pane, {
    hook_event_name: 'Stop',
    session_id: 'claude-session'
  })
  expect(liveRow(host.server, pane.paneKey)?.state).toBe('done')
}

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'

describe('a command end whose agent exit is verified clears the row for every reader', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    const id = path.replace(' ', '-')

    it(`Orca-launched pane (${path})`, async () => {
      const host = await wire()
      const pane = await launchAgentPane(host, `pty-launched-${id}`)
      await claudeIsWorking(host, pane)
      host.readers.republishedWorktrees.length = 0

      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
      // The shell outlived its agent, so the session stays resumable in place.
      const remnant = host.server.getStatusSnapshotForPane(pane.paneKey)
      expect(remnant).toHaveLength(1)
      expect(remnant[0]?.providerSessionOnly).toBe(true)
      expect(remnant[0]?.launchToken).toBeUndefined()
    })

    it(`restored pane whose authority came from a prior listing (${path})`, async () => {
      const host = await wire()
      const pane = shellPane(host.runtime, `pty-restored-${id}`, {
        tabId: TAB,
        leafId: LEAF,
        listingReceipt: true
      })
      await claudeIsWorking(host, pane)
      host.readers.republishedWorktrees.length = 0

      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    })

    it(`a pane the user typed the agent into, with no launch authority (${path})`, async () => {
      const host = await wire()
      const pane = shellPane(host.runtime, `pty-typed-${id}`, { tabId: TAB, leafId: LEAF })
      await claudeIsWorking(host, pane)
      host.readers.republishedWorktrees.length = 0

      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    })
  }

  it('a Done row is cleared too: an exited agent is not waiting for the user', async () => {
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-done')
    await claudeIsWorking(host, pane)
    await claudeIsDone(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it("Claude's own process gone clears the row even when the shell check cannot say", async () => {
    probe.mockResolvedValue('exited')
    const host = await wire()
    host.shellOwnsForeground.mockResolvedValue(false)
    const pane = await launchAgentPane(host, 'pty-launched-presence')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)
    host.readers.republishedWorktrees.length = 0

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')

    expect(probe).toHaveBeenCalled()
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it("Claude's own process gone tells each reader once, without a second shell check", async () => {
    probe.mockResolvedValue('exited')
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-presence-once')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expect(host.readers.windowClears).toEqual([{ paneKey: pane.paneKey }])
    expect(host.readers.subscriberClears).toEqual([{ paneKey: pane.paneKey }])
  })

  it('a PTY exit clears every reader and keeps no resume identity', async () => {
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-exit')
    await claudeIsWorking(host, pane)
    host.readers.republishedWorktrees.length = 0

    await host.runtime.onPtyExit(pane.ptyId, 0, `${pane.ptyId}-incarnation`)

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    expect(host.server.getStatusSnapshotForPane(pane.paneKey)).toEqual([])
  })

  it('fences nothing: the next agent the user starts in that shell shows', async () => {
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-next')
    await claudeIsWorking(host, pane)
    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    expect(liveRow(host.server, pane.paneKey)).toBeUndefined()

    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'PreToolUse',
      session_id: 'next-session',
      tool_name: 'Bash'
    })

    expect(liveRow(host.server, pane.paneKey)?.state).toBe('working')
  })
})

describe('a command end that does not prove the agent exited keeps its row everywhere', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`a nested shell's leaked 133;D under a live TUI, then its real exit (${path})`, async () => {
      const host = await wire()
      const pane = await launchAgentPane(host, `pty-nested-${path.replace(' ', '-')}`)
      await claudeIsWorking(host, pane)
      await claudeIsDone(host, pane)
      // The full-screen agent still owns the foreground.
      host.shellOwnsForeground.mockResolvedValue(false)

      await endCommand(host.runtime, pane.ptyId, path)

      expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'done')

      // The agent quits; its shell's prompt returns.
      host.shellOwnsForeground.mockResolvedValue(true)
      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    })
  }

  it('a live agent pid outranks a shell in the foreground (a suspended or nested agent)', async () => {
    probe.mockResolvedValue('live')
    const host = await wire()
    host.shellOwnsForeground.mockResolvedValue(true)
    const pane = await launchAgentPane(host, 'pty-live-pid')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')
  })

  it('an unanswered check keeps the row and is asked again at the next command end', async () => {
    const host = await wire()
    host.shellOwnsForeground.mockRejectedValueOnce(new Error('host unreachable'))
    const pane = await launchAgentPane(host, 'pty-unanswered')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it('a session that starts while the check is read keeps its row', async () => {
    const host = await wire()
    let answer: (shellOwnsForeground: boolean) => void = () => {}
    host.shellOwnsForeground.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve))
    )
    const pane = await launchAgentPane(host, 'pty-next-session')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    // The first agent exited; the user starts another before the slow read lands.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'second-session',
      prompt: 'a different task'
    })
    answer(true)
    await settle()

    expect(liveRow(host.server, pane.paneKey)?.prompt).toBe('a different task')
    expect(host.readers.windowClears).toEqual([])
  })

  it('a command end that lands while a check is in flight is checked too', async () => {
    const host = await wire()
    let answer: (shellOwnsForeground: boolean) => void = () => {}
    host.shellOwnsForeground.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve))
    )
    const pane = await launchAgentPane(host, 'pty-in-flight')
    await claudeIsWorking(host, pane)

    // A leaked 133;D starts a check that sees the agent; the real exit lands before it answers.
    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    answer(false)
    await settle()

    expect(host.shellOwnsForeground).toHaveBeenCalledTimes(2)
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it('asks nothing for a shell whose panes hold no live row', async () => {
    const host = await wire()
    const pane = shellPane(host.runtime, 'pty-plain-shell', { tabId: TAB, leafId: LEAF })

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    await endCommand(host.runtime, pane.ptyId, 'daemon fact')

    expect(host.shellOwnsForeground).not.toHaveBeenCalled()
  })

  it('still drops launch authority at once: the token lives on in the shell', async () => {
    const host = await wire()
    host.shellOwnsForeground.mockResolvedValue(false)
    const pane = await launchAgentPane(host, 'pty-authority')
    expect(host.runtime.readPaneLaunchAuthority(pane.paneKey)?.launchTokenHash).toBe(
      createHash('sha256').update(pane.launchToken).digest('hex')
    )

    host.runtime.emitDaemonPtyTransientFact(pane.ptyId, {
      kind: 'command-finished',
      exitCode: 0
    })

    expect(host.runtime.readPaneLaunchAuthority(pane.paneKey)).toEqual({ launchTokenHash: null })
  })
})

/** What an SSH relay reports for a PTY: the shell's group in front unless another group is. */
function relayEvidence(
  ptyId: string,
  front: { processName: string | null; foregroundPgid: number } | 'unverifiable'
): { foregroundProcessEvidence: RemoteForegroundEvidence } {
  const observation = {
    authorityGeneration: 'relay-generation',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId,
    ptyIncarnationId: `${ptyId}-incarnation`
  }
  return {
    foregroundProcessEvidence:
      front === 'unverifiable'
        ? { ...observation, verdict: 'unverifiable', reason: 'process_table_unreadable' }
        : {
            ...observation,
            verdict: 'live',
            processName: front.processName,
            fence: {
              platform: 'posix',
              shellPid: 100,
              shellStartTime: 'shell-birth',
              tty: '/dev/pts/3',
              foregroundPgid: front.foregroundPgid
            }
          }
  }
}

describe("an SSH pane answers from its relay's foreground evidence", () => {
  async function sshAgentPane(host: CommandEndHost, ptyId: string) {
    // The SSH provider has no shell confirm, so the runtime controller answers false.
    host.shellOwnsForeground.mockResolvedValue(false)
    const pane = shellPane(host.runtime, ptyId, {
      tabId: TAB,
      leafId: LEAF,
      connectionId: 'conn-1'
    })
    await claudeIsWorking(host, pane)
    host.readers.republishedWorktrees.length = 0
    return pane
  }

  it("a reconnecting relay's replay does not bring the exited agent back", async () => {
    const host = await wire()
    host.inspectProcess.mockImplementation(async (ptyId) =>
      relayEvidence(ptyId, { processName: null, foregroundPgid: 100 })
    )
    const pane = await sshAgentPane(host, 'pty-ssh-replay')
    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    expect(liveRow(host.server, pane.paneKey)).toBeUndefined()

    host.server.ingestRemote(
      {
        paneKey: pane.paneKey,
        tabId: TAB,
        worktreeId: 'wt-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        isReplay: true,
        providerSession: { key: 'session_id', id: 'claude-session' },
        payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(liveRow(host.server, pane.paneKey)).toBeUndefined()
  })

  it('the shell back in front with no agent named clears the row everywhere', async () => {
    const host = await wire()
    host.inspectProcess.mockImplementation(async (ptyId) =>
      relayEvidence(ptyId, { processName: null, foregroundPgid: 100 })
    )
    const pane = await sshAgentPane(host, 'pty-ssh-exit')

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  for (const [name, front] of [
    ['the agent still in front', { processName: 'claude', foregroundPgid: 200 }],
    // Job control off (`set +m`): the agent runs in the shell's own group.
    ['an agent in the shell group', { processName: 'claude', foregroundPgid: 100 }],
    ['another command in front', { processName: null, foregroundPgid: 200 }],
    ['a relay that cannot read its process table', 'unverifiable']
  ] as const) {
    it(`${name} keeps the row`, async () => {
      const host = await wire()
      host.inspectProcess.mockImplementation(async (ptyId) => relayEvidence(ptyId, front))
      const pane = await sshAgentPane(host, `pty-ssh-${name.replace(/\W+/g, '-')}`)

      await endCommand(host.runtime, pane.ptyId, 'shell bytes')

      expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')
    })
  }
})

describe('a WSL pane, whose guest the host cannot inspect', () => {
  it('takes the command end as the exit, as the desktop pane does', async () => {
    const host = await wire()
    host.shellOwnsForeground.mockResolvedValue(false)
    const pane = shellPane(host.runtime, 'pty-wsl-exit', {
      tabId: TAB,
      leafId: LEAF,
      wslDistro: 'Ubuntu'
    })
    await claudeIsWorking(host, pane)
    host.readers.republishedWorktrees.length = 0

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it('still keeps an agent whose own process the host proves alive', async () => {
    probe.mockResolvedValue('live')
    const host = await wire()
    const pane = shellPane(host.runtime, 'pty-wsl-live-pid', {
      tabId: TAB,
      leafId: LEAF,
      wslDistro: 'Ubuntu'
    })
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')
  })
})
