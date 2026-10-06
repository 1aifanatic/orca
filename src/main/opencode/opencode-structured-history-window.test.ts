import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readOpenCodeProviderHistoryWindow } from './opencode-structured-history-window'
import { OpenCodeStructuredSessionAdapter } from './opencode-structured-session-adapter'
import { reconcileJournalSubmissionsAgainstHistory } from '../native-chat/agent-session-journal/journal-restart-reconciliation'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  OpenCodeStructuredLaunch,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

function fixture(agent: 'opencode' | 'opencode2' = 'opencode') {
  const identity: AgentSessionJournalIdentity = {
    sessionId: SESSION,
    workspaceId: 'workspace',
    hostId: 'local',
    agent,
    providerHandle: { transport: 'opencode-serve', agent, nativeId: 'root' }
  }
  const launch: OpenCodeStructuredLaunch = {
    command: 'fixture',
    cwd: '/workspace',
    environment: { XDG_DATA_HOME: '/pinned', OPENCODE_DB: 'selected.db' },
    resumeSessionId: 'root',
    permissions: [],
    agent
  }
  const readHistoryPage: NonNullable<OpenCodeStructuredSessionAdapterDeps['readHistoryPage']> =
    vi.fn<NonNullable<OpenCodeStructuredSessionAdapterDeps['readHistoryPage']>>(async () => ({
      items: [
        {
          rowid: 1,
          fingerprint: 'fixture',
          message: {
            id: agent === 'opencode' ? 'msg_receipt' : 'opencode:msg_receipt',
            role: 'user',
            timestamp: 100,
            source: 'transcript',
            blocks: [{ type: 'text', text: 'Do this once' }]
          }
        }
      ],
      hasMore: false,
      beforeMessageRowId: 1
    }))
  const deps = { resolveLaunch: async () => launch, readHistoryPage }
  return { identity, launch, deps }
}

it.each(['opencode', 'opencode2'] as const)(
  'reconciles a crash after send before acknowledgment once for %s',
  async (agent) => {
    const { identity, deps } = fixture(agent)
    const rig = await openProviderTimelineRig({ agent, sessionId: SESSION, namespace: 'root' })
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Do this once' }]
    } as const
    await rig.journal.appendSubmission({
      clientMessageId: 'crashed',
      body: { ...body, blocks: [...body.blocks] },
      fence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    })
    await rig.journal.resolveDispatch({
      clientMessageId: 'crashed',
      state: 'unknown',
      reason: 'crash',
      fence: 1
    })
    const window = await readOpenCodeProviderHistoryWindow(identity, deps)
    expect(deps.readHistoryPage).toHaveBeenCalledWith(
      { dbPath: join('/pinned', 'opencode', 'selected.db'), sessionId: 'root', limit: 2400 },
      expect.any(AbortSignal)
    )
    expect(window).toMatchObject({ boundaryConsistent: false, turnInFlight: true })
    if (!window) {
      throw new Error('history window unavailable')
    }
    expect(
      await reconcileJournalSubmissionsAgainstHistory({
        journal: rig.journal,
        fence: 1,
        history: window
      })
    ).toEqual(['crashed'])
    expect(
      await reconcileJournalSubmissionsAgainstHistory({
        journal: rig.journal,
        fence: 1,
        history: window
      })
    ).toEqual([])
    expect(rig.journal.submissions()[0]?.dispatchState).toBe('accepted')
    expect(
      (await rig.rows()).filter((row) => row.body.kind === 'message' && row.body.role === 'user')
    ).toHaveLength(1)
  }
)

it.each(['failure', 'timeout'] as const)(
  'does not prevent startup after a recovery reader %s',
  async (failure) => {
    const { identity, deps } = fixture()
    if (failure === 'timeout') {
      vi.useFakeTimers()
    }
    const spawn = vi.fn(async () => {
      throw new Error('startup reached')
    })
    const adapter = new OpenCodeStructuredSessionAdapter({
      ...deps,
      openServer: spawn,
      readHistoryPage:
        failure === 'timeout'
          ? () => new Promise(() => {})
          : async () => {
              throw new Error('unreadable')
            }
    })
    const reading = adapter.providerHistoryWindow({
      identity,
      accountHome: {
        kind: 'opencode',
        locator: {
          kind: 'unmanaged',
          dataHome: '/pinned',
          stateHome: '/state',
          databaseSelection: { kind: 'override', value: 'selected.db' }
        }
      }
    })
    if (failure === 'timeout') {
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(await reading).toBeNull()
    await expect(adapter.acquire({ identity, fence: 1, spawnToken: 'fixture' })).rejects.toThrow(
      'startup reached'
    )
    expect(spawn).toHaveBeenCalledOnce()
  }
)

it('does not read a fresh or in-memory native session', async () => {
  const { identity, deps, launch } = fixture()
  launch.resumeSessionId = null
  expect(await readOpenCodeProviderHistoryWindow(identity, deps)).toBeNull()
  launch.resumeSessionId = 'root'
  launch.environment.OPENCODE_DB = ':memory:'
  expect(await readOpenCodeProviderHistoryWindow(identity, deps)).toBeNull()
  expect(deps.readHistoryPage).not.toHaveBeenCalled()
})
