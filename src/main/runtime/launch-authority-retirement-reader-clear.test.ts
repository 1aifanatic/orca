import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusClearIpcPayload } from '../../shared/agent-status-types'
import { AgentHookServer } from '../agent-hooks/server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// A command end (OSC 133;D) in a pane holding launch authority retires that authority. The pane's
// rows go only once the agent's exit is verified, and then every reader hears it in the same step:
// before, the host deleted them on the bare mark and told only `worktree ps` and mobile, so the
// desktop window, dashboard popout, tab-title spinner and stats recorder kept a row the host had
// deleted, and a nested shell's leaked 133;D erased a live agent's row.

const WORKTREE_PATH = '/tmp/worktree-a'
const TEST_WORKTREE_ID = `repo-1::${WORKTREE_PATH}`

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

const servers: AgentHookServer[] = []
const teardowns: (() => void)[] = []

afterEach(() => {
  probe.mockReset()
  for (const teardown of teardowns.splice(0)) {
    teardown()
  }
  for (const server of servers.splice(0)) {
    server.stop()
  }
  vi.restoreAllMocks()
})

type Readers = {
  windowClears: AgentStatusClearIpcPayload[]
  subscriberClears: AgentStatusClearIpcPayload[]
  republishedWorktrees: string[]
}

/** The host wiring `main-process-runtime-service.ts` performs, plus every pane-clear reader. */
async function wireHost(
  foreground: () => Promise<string | null> = async () => 'zsh',
  userDataPath?: string
): Promise<{
  server: AgentHookServer
  runtime: OrcaRuntimeService
  readers: Readers
  spawn: ReturnType<typeof vi.fn>
}> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared fixture store implements only the members these runtime paths read.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getAgentStatusSnapshot: () =>
      server.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      server.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey, options) =>
      server.retirePaneAuthority(paneKey, undefined, options),
    checkHookAgentPresence: (paneKey) => server.checkAgentPresence(paneKey),
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      server.reconcileEndedProcessForPaneKeys(paneKeys)
  })
  server.setPaneLaunchAuthorityReader((paneKey) => runtime.readPaneLaunchAuthority(paneKey))
  const readers: Readers = { windowClears: [], subscriberClears: [], republishedWorktrees: [] }
  server.setPaneStatusClearListener((clear) => readers.windowClears.push(clear))
  teardowns.push(server.subscribePaneStatusClear((clear) => readers.subscriberClears.push(clear)))
  vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree').mockImplementation((worktreeId) => {
    readers.republishedWorktrees.push(worktreeId)
  })
  teardowns.push(installHookStatusSessionTabsRepublish(server, () => runtime))
  const spawn = vi.fn()
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: foreground,
    confirmForegroundProcess: foreground
  })
  return { server, runtime, readers, spawn }
}

async function postClaudeHook(
  server: AgentHookServer,
  pane: { paneKey: string; launchToken?: string },
  payload: Record<string, unknown>
): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: pane.paneKey,
      ...(pane.launchToken ? { launchToken: pane.launchToken } : {}),
      tabId: pane.paneKey.split(':')[0],
      worktreeId: TEST_WORKTREE_ID,
      env: 'production',
      payload
    })
  })
  expect(response.status).toBe(204)
}

async function claudeIsWorking(
  server: AgentHookServer,
  pane: { paneKey: string; launchToken?: string }
): Promise<void> {
  await postClaudeHook(server, pane, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'claude-session',
    prompt: 'review the PR'
  })
  expect(liveRow(server, pane.paneKey)?.state).toBe('working')
}

async function claudeIsWorkingWithProcess(
  server: AgentHookServer,
  pane: { paneKey: string; launchToken?: string }
): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: pane.paneKey,
      ...(pane.launchToken ? { launchToken: pane.launchToken } : {}),
      tabId: pane.paneKey.split(':')[0],
      worktreeId: TEST_WORKTREE_ID,
      env: 'production',
      agentProcess: JSON.stringify({ pid: 4001, platform: process.platform, startTime: 'birth' }),
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session',
        prompt: 'review the PR'
      }
    })
  })
  expect(response.status).toBe(204)
  expect(server.hasVerifiableAgentProcess(pane.paneKey)).toBe(true)
}

function liveRow(server: AgentHookServer, paneKey: string) {
  return server
    .getStatusSnapshotForPane(paneKey)
    .find((row) => row.providerSessionOnly !== true && row.paneKey === paneKey)
}

/** An agent Orca launched into a fresh pane: it holds a launch token and a launch agent. */
async function launchClaudePane(
  host: { runtime: OrcaRuntimeService; spawn: ReturnType<typeof vi.fn> },
  ptyId: string
) {
  const { runtime, spawn } = host
  spawn.mockResolvedValueOnce({ id: ptyId, incarnationId: `${ptyId}-incarnation` })
  await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    command: 'claude',
    launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
    launchAgent: 'claude'
  })
  const env: Record<string, string> = spawn.mock.lastCall?.[0]?.env ?? {}
  expect(env.ORCA_PANE_KEY).toBeTruthy()
  expect(env.ORCA_AGENT_LAUNCH_TOKEN).toBeTruthy()
  return { ptyId, paneKey: env.ORCA_PANE_KEY, launchToken: env.ORCA_AGENT_LAUNCH_TOKEN }
}

const RESTORED_TAB = '11111111-1111-4111-8111-111111111111'
const RESTORED_PANE = `${RESTORED_TAB}:22222222-2222-4222-8222-222222222222`

/** A restored daemon pane the user typed `claude` into. It holds no launch token; its only
 *  authority is the receipt a listing's controller-inventory refresh mints for an exactly
 *  restored surface (`rememberRestoredOrchestrationAuthority`). */
function restoredPaneWithListingReceipt(runtime: OrcaRuntimeService, ptyId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these protected members exist on the runtime; the listing path that calls them needs a live controller inventory.
  const internals = runtime as unknown as {
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state: Record<string, unknown>
    ) => unknown
    rememberRestoredOrchestrationAuthority: (
      pty: unknown,
      terminalHandle: string,
      incarnationId: string
    ) => void
  }
  const pty = internals.recordPtyWorktree(ptyId, TEST_WORKTREE_ID, {
    connected: true,
    tabId: RESTORED_TAB,
    paneKey: RESTORED_PANE,
    incarnationId: 'restored-incarnation'
  })
  internals.rememberRestoredOrchestrationAuthority(pty, `term-${ptyId}`, 'restored-incarnation')
  return { ptyId, paneKey: RESTORED_PANE }
}

type CommandEndPath = 'shell bytes' | 'daemon fact'

/** A command end, then the verification it starts. */
async function endCommand(
  runtime: OrcaRuntimeService,
  ptyId: string,
  path: CommandEndPath
): Promise<void> {
  if (path === 'shell bytes') {
    runtime.onPtyData(ptyId, '\x1b]133;D;0\x07', Date.now())
  } else {
    runtime.emitDaemonPtyTransientFact(ptyId, { kind: 'command-finished', exitCode: 0 })
  }
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function expectNoReaderLostTheRow(
  server: AgentHookServer,
  readers: Readers,
  paneKey: string,
  state: string
): void {
  expect(liveRow(server, paneKey)?.state).toBe(state)
  expect(readers.windowClears).toEqual([])
  expect(readers.subscriberClears).toEqual([])
}

function expectEveryReaderSawTheClear(
  server: AgentHookServer,
  readers: Readers,
  paneKey: string
): void {
  expect(liveRow(server, paneKey)).toBeUndefined()
  // Desktop window and dashboard popout share this listener.
  expect(readers.windowClears).toContainEqual({ paneKey })
  // Tab-title spinner and session-stats recorder subscribe here.
  expect(readers.subscriberClears).toContainEqual({ paneKey })
  // Mobile `session.tabs` republish.
  expect(readers.republishedWorktrees).toContain(TEST_WORKTREE_ID)
}

describe('a command end whose agent exit is verified clears the row for every reader', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`Orca-launched Claude pane, no listing (${path})`, async () => {
      const host = await wireHost()
      const { server, runtime, readers } = host
      const pane = await launchClaudePane(host, `pty-launched-${path.replace(' ', '-')}`)
      await claudeIsWorking(server, pane)
      readers.republishedWorktrees.length = 0

      await endCommand(runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(server, readers, pane.paneKey)
      // The shell outlived the command, so the session stays resumable in place.
      const remnant = server.getStatusSnapshotForPane(pane.paneKey)
      expect(remnant).toHaveLength(1)
      expect(remnant[0]?.providerSessionOnly).toBe(true)
      expect(remnant[0]?.launchToken).toBeUndefined()
      // The fence holds: a late event from the exited process cannot repaint the pane.
      await postClaudeHook(server, pane, { hook_event_name: 'Stop', session_id: 'claude-session' })
      expect(liveRow(server, pane.paneKey)).toBeUndefined()
    })

    it(`restored Claude pane whose authority came from a prior listing (${path})`, async () => {
      const { server, runtime, readers } = await wireHost()
      const pane = restoredPaneWithListingReceipt(runtime, `pty-restored-${path.replace(' ', '-')}`)
      await claudeIsWorking(server, pane)
      readers.republishedWorktrees.length = 0

      await endCommand(runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(server, readers, pane.paneKey)
      expect(server.getStatusSnapshotForPane(pane.paneKey)[0]?.providerSessionOnly).toBe(true)
    })
  }

  it('a Done row is cleared too: an exited agent is not waiting for the user', async () => {
    const host = await wireHost()
    const { server, runtime, readers } = host
    const pane = await launchClaudePane(host, 'pty-launched-done')
    await claudeIsWorking(server, pane)
    await postClaudeHook(server, pane, { hook_event_name: 'Stop', session_id: 'claude-session' })
    expect(liveRow(server, pane.paneKey)?.state).toBe('done')

    await endCommand(runtime, pane.ptyId, 'shell bytes')

    expectEveryReaderSawTheClear(server, readers, pane.paneKey)
  })

  it("falls back to the Claude process's own identity when the foreground cannot say", async () => {
    probe.mockResolvedValue('exited')
    const host = await wireHost(async () => 'node')
    const { server, runtime, readers } = host
    const pane = await launchClaudePane(host, 'pty-launched-presence')
    // Presence needs the agent's own process identity on the row.
    await claudeIsWorkingWithProcess(server, pane)
    readers.republishedWorktrees.length = 0

    await endCommand(runtime, pane.ptyId, 'daemon fact')

    expect(probe).toHaveBeenCalled()
    expectEveryReaderSawTheClear(server, readers, pane.paneKey)
  })

  it('a PTY exit clears every reader and keeps no resume identity', async () => {
    const host = await wireHost()
    const { server, runtime, readers } = host
    const pane = await launchClaudePane(host, 'pty-launched-exit')
    await claudeIsWorking(server, pane)
    readers.republishedWorktrees.length = 0

    await runtime.onPtyExit(pane.ptyId, 0, `${pane.ptyId}-incarnation`)

    expectEveryReaderSawTheClear(server, readers, pane.paneKey)
    expect(server.getStatusSnapshotForPane(pane.paneKey)).toEqual([])
  })
})

describe('a command end that does not prove the agent exited keeps its row everywhere', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`a nested shell's leaked 133;D under a live agent (${path})`, async () => {
      const host = await wireHost(async () => 'claude')
      const { server, runtime, readers } = host
      const pane = await launchClaudePane(host, `pty-nested-${path.replace(' ', '-')}`)
      await claudeIsWorking(server, pane)

      await endCommand(runtime, pane.ptyId, path)

      expectNoReaderLostTheRow(server, readers, pane.paneKey, 'working')
      // No fence either: the live agent's next event still lands.
      await postClaudeHook(server, pane, { hook_event_name: 'Stop', session_id: 'claude-session' })
      expect(liveRow(server, pane.paneKey)?.state).toBe('done')
    })
  }

  it('an execution host that cannot answer is not evidence of exit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await wireHost(async () => {
      throw new Error('relay unreachable')
    })
    const { server, runtime, readers } = host
    const pane = await launchClaudePane(host, 'pty-unverifiable')
    await claudeIsWorking(server, pane)

    await endCommand(runtime, pane.ptyId, 'daemon fact')

    expectNoReaderLostTheRow(server, readers, pane.paneKey, 'working')
    expect(warn).toHaveBeenCalledWith(
      '[agent-status] command end: agent exit unverifiable; pane rows kept',
      { ptyId: pane.ptyId }
    )
  })

  it('still drops launch authority at once: the token lives on in the shell', async () => {
    const host = await wireHost(async () => 'claude')
    const { runtime } = host
    const pane = await launchClaudePane(host, 'pty-authority')
    expect(runtime.readPaneLaunchAuthority(pane.paneKey)?.launchTokenHash).toBe(
      createHash('sha256').update(pane.launchToken).digest('hex')
    )

    runtime.emitDaemonPtyTransientFact(pane.ptyId, { kind: 'command-finished', exitCode: 0 })

    expect(runtime.readPaneLaunchAuthority(pane.paneKey)).toEqual({ launchTokenHash: null })
  })
})

describe('the launch token a shell keeps after its command ends', () => {
  it('never vouches for a later process that inherits it, before or after a restart', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-inherited-token-'))
    teardowns.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    // The foreground shows an agent again: a new `claude` the user typed in the same shell.
    const host = await wireHost(async () => 'claude', userDataPath)
    const { server, runtime } = host
    const pane = await launchClaudePane(host, 'pty-inherited-token')
    const attest = (target: AgentHookServer, terminalProvenance: 'current_runtime' | 'restored') =>
      target.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance
      })
    await claudeIsWorking(server, pane)
    expect(attest(server, 'current_runtime')).not.toBeNull()

    await endCommand(runtime, pane.ptyId, 'daemon fact')
    // The new process posts with the token it inherited from the shell's environment.
    await postClaudeHook(server, pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'second-session',
      prompt: 'a different task'
    })

    expect(liveRow(server, pane.paneKey)?.prompt).toBe('a different task')
    expect(liveRow(server, pane.paneKey)?.launchToken).toBeUndefined()
    expect(attest(server, 'current_runtime')).toBeNull()

    server.flushStatusPersistSync()
    server.stop()
    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })
    expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
    expect(attest(restarted, 'restored')).toBeNull()
  })

  it('still vouches for the agent it was minted for while that agent runs', async () => {
    const host = await wireHost(async () => 'claude')
    const { server } = host
    const pane = await launchClaudePane(host, 'pty-live-token')
    await claudeIsWorking(server, pane)
    await postClaudeHook(server, pane, {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-session',
      tool_name: 'Bash'
    })

    expect(liveRow(server, pane.paneKey)?.launchToken).toBe(pane.launchToken)
    expect(
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).not.toBeNull()
  })
})
