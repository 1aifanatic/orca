// A Retry of a rejected message is a new send that names the message it sends again. The host
// records that on the new submission, durably, so every client hides the rejected one.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-schemas'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

const CALLER = { callerKey: 'client-1' }
const RETRIED = `${NOW}-${'f'.repeat(32)}`

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

function startHost(): void {
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: 'created' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
      releaseAcquisition: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-retries-'))
  resetHostTestOperationIds()
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a send that is the Retry of a rejected message', () => {
  it('records the message it sends again on its submission, across a restart, for every client', async () => {
    const body = hostTestMessage('hello again')
    const params = SendParams.parse({
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body,
      retries: RETRIED
    })

    const sent = await host.send(CALLER, { ...params, userSend: true })

    expect(sent).toMatchObject({ ok: true })
    const id = sent.ok ? sent.value.clientMessageId : ''
    const recorded = async () =>
      (await host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === id
      )
    expect(await recorded()).toMatchObject({ retries: RETRIED })
    // A client reads it whole.
    expect(AgentJournalSubmissionSchema.parse(await recorded())).toMatchObject({
      retries: RETRIED
    })

    await host.flushAllStreamedEvents()
    startHost()
    expect(await recorded()).toMatchObject({ retries: RETRIED })
  })
})
