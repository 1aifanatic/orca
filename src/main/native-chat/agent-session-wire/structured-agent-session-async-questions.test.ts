import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { codexItemIdentity, codexJournalItem } from '../../codex/codex-structured-item-translation'
import { CodexTurnOrdinals } from '../../codex/codex-turn-ordinals'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'
import { readStructuredAgentSessionAsyncQuestions } from './structured-agent-session-status-journal-projection'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-async',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const OPTIONS = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-async-journal-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const open = (): Promise<AgentSessionJournal> =>
  journals.open({ identity: IDENTITY, stateDirectory: root })

function asking(title: string): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: title,
        asyncQuestions: { providerItemId: `raw-${title}`, questions: [{ title }] }
      }
    ]
  }
}

let ordinal = 0
function codexIdentity(): AgentJournalItemIdentity {
  ordinal += 1
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

async function ask(journal: AgentSessionJournal, title: string): Promise<void> {
  await journal.appendItem(codexIdentity(), asking(title), OPTIONS)
}

async function submit(
  journal: AgentSessionJournal,
  clientMessageId: string,
  queued = false
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: digestPayload(clientMessageId),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    fence: 1,
    ...(queued ? { handoverRecorded: true as const } : {})
  })
}

async function accept(journal: AgentSessionJournal, clientMessageId: string): Promise<void> {
  await journal.resolveDispatch({
    clientMessageId,
    state: 'accepted',
    providerIdentity: codexIdentity(),
    fence: 1
  })
}

function titles(journal: AgentSessionJournal): string[] {
  const field = readStructuredAgentSessionAsyncQuestions(journal)
  return field.state === 'ready' ? field.questions.map((question) => question.title) : []
}

describe('structured async questions retire at the transport canonical order', () => {
  it('a direct send retires what was asked before it, once accepted', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await ask(journal, 'B before tap?')
    await submit(journal, 'm1')
    expect(titles(journal)).toEqual(['A?', 'B before tap?'])
    await accept(journal, 'm1')
    expect(titles(journal)).toEqual([])
  })

  it('a question asked between submission and acceptance stays pending', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await submit(journal, 'm1')
    await ask(journal, 'B between?')
    await accept(journal, 'm1')
    expect(titles(journal)).toEqual(['B between?'])
    await ask(journal, 'C after?')
    expect(titles(journal)).toEqual(['B between?', 'C after?'])
  })

  it('a queued send counts at its handover, so a question asked before it is retired', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await submit(journal, 'q1', true)
    await ask(journal, 'B before handover?')
    expect(titles(journal)).toEqual(['A?', 'B before handover?'])
    await journal.resolveDispatch({
      clientMessageId: 'q1',
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: 1
    })
    await accept(journal, 'q1')
    expect(titles(journal)).toEqual([])
  })

  it('derives the same set and keys after a replay', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    await submit(journal, 'm1')
    await ask(journal, 'B?')
    await accept(journal, 'm1')
    const before = readStructuredAgentSessionAsyncQuestions(journal)
    await journal.close()
    const replayed = await open()
    expect(readStructuredAgentSessionAsyncQuestions(replayed)).toEqual(before)
  })

  it('caches by cursor and keeps the published identity while unchanged', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    const first = readStructuredAgentSessionAsyncQuestions(journal)
    expect(readStructuredAgentSessionAsyncQuestions(journal)).toBe(first)
    await journal.appendItem(
      codexIdentity(),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'more work' }] },
      OPTIONS
    )
    expect(readStructuredAgentSessionAsyncQuestions(journal)).toBe(first)
  })
})

describe('structured async question identity across resume', () => {
  it('keeps the key when the resumed provider renumbers the asking item', async () => {
    const journal = await open()
    const questions = [{ title: 'Color?', options: ['Red'] }]
    const live = {
      type: 'agentMessage',
      id: 'call_live',
      text: 'Color?',
      delivery: 'async',
      questions
    }
    const resumed = { ...live, id: 'item-2' }
    const liveOrdinals = new CodexTurnOrdinals()
    liveOrdinals.ordinalFor('thread-1', 'turn-9', 'user-live')
    const resumedOrdinals = new CodexTurnOrdinals()
    resumedOrdinals.ordinalFor('thread-1', 'turn-9', 'item-1')

    const write = async (item: typeof live, ordinals: CodexTurnOrdinals): Promise<void> => {
      const body = codexJournalItem(item).body
      if (!body) {
        throw new Error('expected a message body')
      }
      const identity = codexItemIdentity({ threadId: 'thread-1', turnId: 'turn-9', item, ordinals })
      await journal.appendItem(identity, body, OPTIONS)
    }
    await write(live, liveOrdinals)
    const liveKeys = readStructuredAgentSessionAsyncQuestions(journal)
    await write(resumed, resumedOrdinals)
    const resumedKeys = readStructuredAgentSessionAsyncQuestions(journal)
    expect(liveKeys.state === 'ready' && liveKeys.questions.map((q) => q.key)).toEqual(
      resumedKeys.state === 'ready' && resumedKeys.questions.map((q) => q.key)
    )
    // The raw provider id is carried separately and never used as client state.
    expect(resumedKeys.state === 'ready' && resumedKeys.questions[0]?.providerItemId).toBe('item-2')

    // A genuine re-ask is a new item, so a new key.
    const reAsk = { ...live, id: 'call_again' }
    await write(reAsk, resumedOrdinals)
    const after = readStructuredAgentSessionAsyncQuestions(journal)
    expect(after.state === 'ready' ? new Set(after.questions.map((q) => q.key)).size : 0).toBe(2)
  })
})

describe('structured async questions on subscribe frames', () => {
  it('carries a question older than the hydration page on the snapshot and reset frames', async () => {
    const journal = await open()
    await ask(journal, 'Old?')
    for (let index = 0; index < 260; index += 1) {
      await journal.appendItem(
        codexIdentity(),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `row ${index}` }] },
        OPTIONS
      )
    }
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readAsyncQuestions: readStructuredAgentSessionAsyncQuestions
    })
    subscribers.open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const snapshot = events[0]
    expect(snapshot?.type).toBe('snapshot')
    if (snapshot?.type !== 'snapshot') {
      return
    }
    expect(JSON.stringify(snapshot.page.items)).not.toContain('Old?')
    expect(snapshot.asyncQuestions).toMatchObject({
      state: 'ready',
      questions: [{ title: 'Old?' }]
    })

    subscribers.reset(IDENTITY.sessionId, journal, 'cursor_compacted', 1)
    expect(events.at(-1)).toMatchObject({
      type: 'reset',
      asyncQuestions: { state: 'ready', questions: [{ title: 'Old?' }] }
    })
  })

  it('attaches the field to a batch only when the set changed', async () => {
    const journal = await open()
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readAsyncQuestions: readStructuredAgentSessionAsyncQuestions
    })
    subscribers.open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    await journal.appendItem(
      codexIdentity(),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'work' }] },
      OPTIONS
    )
    subscribers.publish(IDENTITY.sessionId, journal)
    expect(events.at(-1)).toMatchObject({ type: 'batch' })
    expect(events.at(-1)).not.toHaveProperty('asyncQuestions')

    await ask(journal, 'New?')
    subscribers.publish(IDENTITY.sessionId, journal)
    expect(events.at(-1)).toMatchObject({
      type: 'batch',
      asyncQuestions: { state: 'ready', questions: [{ title: 'New?' }] }
    })
  })

  it('gives a resumed, already caught-up cursor the set it was never sent', async () => {
    const journal = await open()
    await ask(journal, 'A?')
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers({
      readAsyncQuestions: readStructuredAgentSessionAsyncQuestions
    }).open({
      id: 's',
      sessionId: IDENTITY.sessionId,
      journal,
      fence: 1,
      cursor: journal.cursor(),
      emit: (event) => events.push(event)
    })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'batch',
        asyncQuestions: { state: 'ready', questions: [expect.objectContaining({ title: 'A?' })] }
      })
    ])
  })
})
