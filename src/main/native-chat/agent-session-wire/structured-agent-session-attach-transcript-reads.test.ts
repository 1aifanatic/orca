// What a Claude attach costs in transcript I/O. Most attaches have nothing in
// doubt and must not parse the provider's transcript at all; one that does must
// read it once for every question it asks of it.

import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ path: '', opens: 0, streams: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (path: string, flags: string) => {
      const handle = await fs.open(path, flags)
      if (path !== reads.path) {
        return handle
      }
      reads.opens += 1
      return {
        stat: (options?: Parameters<FileHandle['stat']>[0]) => handle.stat(options),
        createReadStream: (options: Parameters<FileHandle['createReadStream']>[0]) => {
          reads.streams += 1
          return handle.createReadStream(options)
        },
        close: () => handle.close()
      }
    }
  }
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-outbox'
import { sampleClaudeProviderHistory } from '../../claude/claude-structured-history-window'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import {
  attachJournal,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'

const PROVIDER_SESSION = 'provider-1'
const BASE = agentSessionRecordFixture()
let root = ''
let record: AgentSessionRecord
const journals = createTrackedJournalOpener()

function params(): AgentSessionAttachParams {
  return {
    envelope: {
      sessionId: record.sessionId,
      clientOperationId: 'op-1',
      expectedRuntimeFence: record.lease.runtimeFence,
      payloadFingerprint: 'fp'
    },
    location: record.location,
    provider: 'claude',
    agent: 'claude',
    accountHome: record.accountHome,
    runtimeKind: 'native',
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: 'anchor' }
  }
}

/** Mirrors the Claude adapter: the real sampler, over this test's account home. */
const adapter: StructuredAgentSessionAdapter = {
  acquire: vi.fn(),
  dispatch: vi.fn(),
  cancelTurn: vi.fn(),
  answerPrompt: vi.fn(),
  setOption: vi.fn(),
  sampleProviderHistory: (input) =>
    sampleClaudeProviderHistory({
      identity: input.identity,
      accountHomePath: input.accountHome.path,
      hasLiveSession: false
    })
}

function fingerprint(text: string): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: record.sessionId,
    fields: { body: structuredAgentSessionSendBody(text, []) }
  })
}

/** A previous process handed `text` over under `frameUuid` and died before its outcome. */
async function crashAfterHandover(text: string, frameUuid: string): Promise<void> {
  const identity = journalIdentityFor(record, params())
  const journal = await journals.open({
    identity,
    journalDir: journalDirectoryFor(root, {
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId
    })
  })
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  }
  const fence = record.lease.runtimeFence
  await journal.appendSubmission({
    clientMessageId: 'cm_1',
    payloadFingerprint: fingerprint(text),
    body,
    fence
  })
  await journal.resolveDispatch({
    clientMessageId: 'cm_1',
    state: 'pending',
    providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: frameUuid },
    fence
  })
  await journal.close()
}

async function attach() {
  const attached = await attachJournal({
    record,
    params: params(),
    journalRoot: root,
    openConversation: openTestAttachConversation(root),
    adapter
  })
  journals.track(attached.journal)
  return attached
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attach-transcript-reads-'))
  const accountHome = join(root, 'claude-home')
  const projectDir = join(accountHome, 'projects', 'work')
  await mkdir(projectDir, { recursive: true })
  record = {
    ...BASE,
    providerHandleChain: [
      {
        ...BASE.providerHandleChain[0]!,
        handle: { provider: 'claude', sessionId: PROVIDER_SESSION, leafUuid: 'anchor' }
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: accountHome }
  }
  reads.path = join(projectDir, `${PROVIDER_SESSION}.jsonl`)
  reads.opens = 0
  reads.streams = 0
  const rows = [
    { type: 'user', uuid: 'anchor', parentUuid: null, message: { content: 'earlier turn' } },
    { type: 'user', uuid: 'u-sent', parentUuid: 'anchor', message: { content: 'ship it' } },
    { type: 'last-prompt', leafUuid: 'u-sent' }
  ]
  await writeFile(
    reads.path,
    `${rows.map((row) => JSON.stringify({ ...row, sessionId: PROVIDER_SESSION })).join('\n')}\n`
  )
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('Claude attach transcript reads', () => {
  it('parses no transcript when nothing is in doubt', async () => {
    const attached = await attach()

    expect(attached.unconfirmedClientMessageIds).toEqual([])
    expect(reads.opens).toBe(0)
    expect(reads.streams).toBe(0)
  })

  it('reads the transcript once to decide a send in doubt', async () => {
    await crashAfterHandover('ship it', 'u-sent')

    const attached = await attach()

    expect(attached.journal.submissions()[0]).toMatchObject({ dispatchState: 'accepted' })
    // The branch proof, the anchored window and the id lookup share one pass.
    expect(reads.opens).toBe(1)
    expect(reads.streams).toBe(1)
  })
})
