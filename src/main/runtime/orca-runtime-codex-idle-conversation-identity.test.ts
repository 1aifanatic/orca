// STA-7370: on a headless host a Codex pane that finished its turn and sits idle under its
// neutral `<thread> | <project>` title must still give a cold phone the pane's conversation,
// driven here through real hook HTTP posts, real OSC titles and the real completed-hook recovery.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBody, postHookEvent } from '../agent-hooks/server.test-fixtures'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-tail-reader'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import type { RpcRequest, RpcResponse } from './rpc/core'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-codex'
const SESSION_ID = 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31'
const NEUTRAL_TITLE = 'Say hi | my-repo'

let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup()
  }
  cleanups = []
})

async function writeCodexRollout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-idle-identity-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, 'rollout.jsonl')
  const records = [
    {
      timestamp: '2026-10-04T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: SESSION_ID }
    },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Say hi' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Hi there' } }
  ]
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
  return filePath
}

type Presence = 'unverifiable' | null

class InspectableRuntime extends OrcaRuntimeService {
  ptyRecord(ptyId: string): RuntimePtyWorktreeRecord | undefined {
    return this.ptysById.get(ptyId)
  }

  protected override async resolveTerminalWorkspaceLaunchScope(): Promise<TerminalWorkspaceLaunchScope> {
    return {
      id: WORKTREE_ID,
      path: '/repo/app',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }
  }
}

async function createIdleCodexPane(args: {
  presence: Presence
  title: string
  launchAgent?: 'codex' | 'claude'
}): Promise<{
  runtime: InspectableRuntime
  wiring: ReturnType<typeof makeAgentStatusStoreWiring>
  transcriptPath: string
}> {
  const wiring = makeAgentStatusStoreWiring()
  await wiring.statusStore.start({ env: 'production' })
  cleanups.push(() => wiring.statusStore.stop())
  const runtime = new InspectableRuntime(null, undefined, {
    ...wiring.deps,
    // Why: real hosts with no live-process verdict take the legacy completed-hook recovery.
    ...(args.presence ? { checkHookAgentPresence: async () => args.presence } : {})
  })
  cleanups.push(wiring.attach(runtime))
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'codex'
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: args.launchAgent ?? 'codex',
    title: 'Terminal'
  })
  const transcriptPath = await writeCodexRollout()
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const response = await postHookEvent(
      wiring.statusStore,
      buildBody({
        hook_event_name: event,
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        ...(event === 'UserPromptSubmit' ? { prompt: 'Say hi' } : {})
      }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
  }
  runtime.onPtyData(PTY_ID, `\x1b]0;⠋ ${args.title}\x07`, 1)
  runtime.onPtyData(PTY_ID, `\x1b]0;${args.title}\x07`, 2)
  return { runtime, wiring, transcriptPath }
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'tok', method, params }
}

async function dispatchFrames(
  runtime: OrcaRuntimeService,
  method: string,
  clientKind: 'mobile' | 'runtime'
): Promise<RpcResponse[]> {
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const frames: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    makeRequest(method, { worktree: `id:${WORKTREE_ID}` }),
    (raw) => frames.push(JSON.parse(raw)),
    { clientKind, connectionId: `conn-${clientKind}` }
  )
  return frames
}

function firstTerminalTab(frame: RpcResponse | undefined): Record<string, unknown> | undefined {
  const result = frame?.ok ? frame.result : null
  if (!result || typeof result !== 'object' || !('tabs' in result) || !Array.isArray(result.tabs)) {
    return undefined
  }
  return result.tabs.find((tab) => tab?.type === 'terminal')
}

describe('idle Codex pane conversation identity on a headless host', () => {
  it.each<Presence>(['unverifiable', null])(
    'gives a cold phone the session under the neutral idle title (presence %s)',
    async (presence) => {
      const { runtime, wiring, transcriptPath } = await createIdleCodexPane({
        presence,
        title: NEUTRAL_TITLE
      })
      // Preconditions: real recovery restored Codex idle on a connected pane with a fresh done row.
      await vi.waitFor(() => expect(runtime.ptyRecord(PTY_ID)?.lastAgentStatus).toBe('idle'))
      const pty = runtime.ptyRecord(PTY_ID)
      expect(pty?.connected).toBe(true)
      expect(pty?.lastOscTitle).toBe(NEUTRAL_TITLE)
      const row = wiring.statusStore.getStatusSnapshot()[0]
      expect(row).toMatchObject({
        state: 'done',
        providerSession: { id: SESSION_ID, transcriptPath }
      })
      expect(row?.restoredUnconfirmed).not.toBe(true)
      expect(row?.providerSessionOnly).not.toBe(true)

      const mobileList = firstTerminalTab(
        (await dispatchFrames(runtime, 'session.tabs.list', 'mobile'))[0]
      )
      expect(mobileList).toMatchObject({ type: 'terminal', launchAgent: 'codex' })
      expect(mobileList?.agentStatus).toMatchObject({
        state: 'done',
        sessionBoundary: true,
        prompt: '',
        agentType: 'codex',
        providerSession: { id: SESSION_ID, transcriptPath }
      })
      const mobileSubscribe = firstTerminalTab(
        (await dispatchFrames(runtime, 'session.tabs.subscribe', 'mobile'))[0]
      )
      expect(mobileSubscribe?.agentStatus).toEqual(mobileList?.agentStatus)

      const runtimeList = firstTerminalTab(
        (await dispatchFrames(runtime, 'session.tabs.list', 'runtime'))[0]
      )
      expect(runtimeList).toBeDefined()
      expect(runtimeList).not.toHaveProperty('agentStatus')
    }
  )

  it('the seeded rollout the identity addresses is readable as the conversation', async () => {
    const transcriptPath = await writeCodexRollout()
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: SESSION_ID,
      transcriptPath,
      limit: 40
    })
    expect(tail).toMatchObject({
      messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'Say hi' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Hi there' }] }
      ]
    })
  })
})
