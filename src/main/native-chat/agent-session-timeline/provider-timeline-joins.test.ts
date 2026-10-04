import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalApprovalItem,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { createCodexProviderTimelineIdentityScheme } from '../../codex/codex-provider-timeline-identity'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createLegacyProviderTimelineIdentityScheme } from './provider-timeline-identity'
import { ProviderTimelineJoins, type ProviderTimelineItemJoin } from './provider-timeline-joins'

const journals = createTrackedJournalOpener()
const roots: string[] = []

afterEach(async () => {
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function openJournal(): Promise<AgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'orca-provider-timeline-joins-'))
  roots.push(root)
  return journals.open({
    identity: {
      sessionId: 'session-joins',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'root' }
    },
    stateDirectory: root,
    now: () => 1_000
  })
}

const codexJoins = () =>
  new ProviderTimelineJoins({
    scheme: createCodexProviderTimelineIdentityScheme({
      sessionId: 'session-joins',
      primaryThreadId: () => 'root'
    }),
    generation: 'gen-1',
    namespace: 'ns'
  })

const message = (id: string): ProviderTimelineItemJoin => ({
  family: 'item',
  key: { source: 'provider', value: id },
  thread: 'root'
})

const inTurn = (turn: string) => ({
  thread: 'root',
  turn: { source: 'provider', value: turn } as const,
  scope: { kind: 'turn', turnItemId: `turn:${turn}` } as const
})

const codexSlot = (turn: string, ordinal: number, threadId = 'root'): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId,
  turnId: turn,
  ordinal
})

async function write(
  journal: AgentSessionJournal,
  row: { identity: AgentJournalItemIdentity; ref?: string },
  text: string
) {
  await journal.appendItem(
    row.identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    {
      fence: 1,
      turnScope: { kind: 'turn', turnItemId: 'turn:t1' },
      ...(row.ref === undefined ? {} : { providerItemRef: row.ref })
    }
  )
}

describe('provider timeline joins', () => {
  it('finds an ordinal message again from the reference its row carries, after a restart', async () => {
    const journal = await openJournal()
    const before = codexJoins()
    const m0 = before.place(message('m0'), 'message', inTurn('t1'), journal)
    await write(journal, m0, 'first')
    const m1 = before.place(message('m1'), 'message', inTurn('t1'), journal)
    await write(journal, m1, 'second')
    expect([m0.itemId, m1.itemId]).toEqual(['codex:root:t1:0', 'codex:root:t1:1'])

    const after = codexJoins()
    expect(after.find(message('m1'), journal)).toMatchObject({
      itemId: 'codex:root:t1:1',
      scope: { kind: 'turn', turnItemId: 'turn:t1' }
    })
    // A new message takes the next free place, past every row the turn holds.
    expect(after.place(message('m2'), 'message', inTurn('t1'), journal).itemId).toBe(
      'codex:root:t1:2'
    )
  })

  it('skips a place an echoed send holds through its submission alias', async () => {
    const journal = await openJournal()
    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'send-1',
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: 'root', turnId: 't1', ordinal: 0 },
      fence: 1
    })
    expect(codexJoins().place(message('reply'), 'message', inTurn('t1'), journal).itemId).toBe(
      'codex:root:t1:1'
    )
  })

  it('continues past the highest ordinal the journal holds, never into a gap below it', async () => {
    const journal = await openJournal()
    await write(journal, { identity: codexSlot('t1', 2), ref: 'item:old' }, 'old')
    // Another turn and another thread keep their own places.
    await write(journal, { identity: codexSlot('t2', 7) }, 'other turn')
    await write(journal, { identity: codexSlot('t1', 9, 'sub') }, 'subagent')
    const joins = codexJoins()
    expect(joins.place(message('new'), 'message', inTurn('t1'), journal).itemId).toBe(
      'codex:root:t1:3'
    )
    expect(joins.place(message('next'), 'message', inTurn('t1'), journal).itemId).toBe(
      'codex:root:t1:4'
    )
  })

  it('continues past an echoed send above the highest row', async () => {
    const journal = await openJournal()
    await write(journal, { identity: codexSlot('t1', 0) }, 'first')
    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'send-1',
      state: 'accepted',
      providerIdentity: codexSlot('t1', 4),
      fence: 1
    })
    expect(codexJoins().place(message('reply'), 'message', inTurn('t1'), journal).itemId).toBe(
      'codex:root:t1:5'
    )
  })

  it('forgets what it read from an epoch the journal replaced', async () => {
    const journal = await openJournal()
    const joins = codexJoins()
    const m0 = joins.place(message('m0'), 'message', inTurn('t1'), journal)
    await write(journal, m0, 'first')
    expect(joins.find(message('m0'), journal)?.itemId).toBe('codex:root:t1:0')
    await journal.replaceEpochItems('handle_forked', 1, [])
    expect(joins.find(message('m0'), journal)).toBeNull()
    expect(joins.place(message('m1'), 'message', inTurn('t1'), journal).itemId).toBe(
      'codex:root:t1:0'
    )
  })

  it('finds a row whose identity spells its key without any reference', async () => {
    const journal = await openJournal()
    const scheme = createLegacyProviderTimelineIdentityScheme({
      agent: 'grok',
      sessionId: 'session-joins'
    })
    const joins = () => new ProviderTimelineJoins({ scheme, generation: 'g', namespace: 'ns' })
    const tool = joins().place(message('tool'), 'tool-call', inTurn('t1'), journal)
    expect(tool.ref).toBeUndefined()
    await write(journal, tool, 'x')
    expect(joins().find(message('tool'), journal)?.itemId).toBe(tool.itemId)
    expect(joins().find({ ...message('tool'), thread: 'other' }, journal)).toBeNull()
  })

  it('reads the current request incarnation back from the rows', async () => {
    const journal = await openJournal()
    const scheme = createLegacyProviderTimelineIdentityScheme({
      agent: 'grok',
      sessionId: 'session-joins'
    })
    const joins = () => new ProviderTimelineJoins({ scheme, generation: 'g', namespace: 'ns' })
    const key = { source: 'provider', value: 'p1' } as const
    const thread = { thread: null, turn: null, scope: AGENT_JOURNAL_THREAD_SCOPE }
    const approval: AgentJournalApprovalItem = {
      kind: 'approval',
      title: 'Run?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
    const before = joins()
    for (let incarnation = 1; incarnation <= 2; incarnation += 1) {
      const row = before.nextRequest(key, 'approval', thread, journal)
      expect(row.incarnation).toBe(incarnation)
      await journal.appendItem(row.identity, approval, {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
    expect(joins().request(key, journal)).toMatchObject({
      incarnation: 2,
      itemId: agentJournalItemKey(
        scheme.item({
          namespace: 'ns',
          family: 'request',
          key,
          thread: null,
          turn: null,
          itemClass: 'approval',
          messageOrdinal: null,
          incarnation: 2
        })
      )
    })
  })
})
