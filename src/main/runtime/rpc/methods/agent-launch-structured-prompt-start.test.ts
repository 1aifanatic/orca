// A launch prompt is the new chat's first message, which starts its agent. Read from a real host:
// a start still being retried at the budget refuses the launch as unknown, and leaves the chat and
// its message to start on the next try.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { mintAgentSessionOperationId } from '../../orchestration/structured-pointer-operation-id'
import { deliverStructuredAgentSessionLaunchPrompt } from './agent-launch-structured-prompt'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let fence: number
let clock: number

const accountSwitch = () =>
  new AgentSessionPreSpawnError(new Error('switching'), { reason: 'accountSwitchInProgress' })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-launch-prompt-start-'))
  clock = Date.now()
  const store = await openTestAgentSessionRecordStore(root)
  acquire = vi.fn(async ({ fence: acquiredFence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: clock, spawnToken },
    link: {
      linkId: `link-${acquiredFence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'created',
      mintedAtFence: acquiredFence,
      observedAt: clock
    }
  }))
  closeSession = vi.fn(async () => true)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      supportsCreate: () => true,
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      closeSession,
      dispatch: vi.fn(async ({ clientMessageId }) => ({
        state: 'accepted' as const,
        providerIdentity: {
          provider: 'codex' as const,
          threadId: THREAD,
          turnId: `turn-${clientMessageId}`,
          ordinal: 1
        }
      })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    now: () => clock
  })
  const create = hostTestAttachParams(null)
  create.envelope.clientOperationId = mintAgentSessionOperationId(clock)
  const created = await host.create(CALLER, create)
  if (!created.ok) {
    throw new Error(created.refusal.message)
  }
  fence = created.fence
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function deliver(budgetMs: number) {
  return deliverStructuredAgentSessionLaunchPrompt({
    host,
    caller: CALLER,
    sessionId: SESSION,
    fence,
    text: 'review my notes',
    budgetMs
  })
}

describe('a launch prompt whose agent is still starting at the budget', () => {
  it('refuses the launch as unknown, and the chat keeps its message and starts it later', async () => {
    acquire.mockRejectedValueOnce(accountSwitch())

    await expect(deliver(200)).rejects.toMatchObject({
      refusal: { code: 'agent_session_operation_unknown' }
    })

    // The chat survives the refused launch: nothing closed it, and its first message still waits.
    expect(closeSession).not.toHaveBeenCalled()
    expect(host.sessionAgent(SESSION)).not.toBeNull()
    const [waiting] = (await host.journalSnapshot(SESSION)).submissions
    expect(waiting).toMatchObject({ dispatchState: 'pending', startRetry: { attempts: 1 } })

    // The retry comes due; the delivery loop starts the agent with that same message.
    clock += 15_000
    host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
    await vi.waitFor(async () =>
      expect((await host.journalSnapshot(SESSION)).submissions).toEqual([
        expect.objectContaining({
          clientMessageId: waiting.clientMessageId,
          dispatchState: 'accepted'
        })
      ])
    )
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('is taken when the start succeeds within the budget', async () => {
    await expect(deliver(5_000)).resolves.toMatchObject({ taken: true })
  })
})
