// Chats in every state an open's settlement plan can find, written through a real journal store,
// for the tests of the stored state and the plan that must agree about them.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from './journal-store'

/** The fence every case writes its content under; an `unverifiable` turn's writer. */
export const CORPUS_FENCE = 3

const THREAD = 'thread-corpus'

function codexItem(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD, turnId, ordinal }
}

async function item(
  journal: AgentSessionJournal,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): Promise<void> {
  await journal.appendItem(identity, body, {
    fence: CORPUS_FENCE,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

async function send(
  journal: AgentSessionJournal,
  clientMessageId: string,
  text: string,
  handoverRecorded?: true
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: `fp-${clientMessageId}`,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    fence: CORPUS_FENCE,
    ...(handoverRecorded ? { handoverRecorded } : {})
  })
}

async function settledTurn(journal: AgentSessionJournal, turnId: string): Promise<void> {
  await send(journal, `send-${turnId}`, `asked ${turnId}`)
  await journal.resolveDispatch({
    clientMessageId: `send-${turnId}`,
    state: 'accepted',
    providerIdentity: codexItem(turnId, 1),
    fence: CORPUS_FENCE
  })
  await item(journal, codexItem(turnId, 0), {
    kind: 'turn',
    turnId,
    state: 'completed',
    outcome: 'success',
    startedAt: 10,
    completedAt: 20
  })
  await item(journal, codexItem(turnId, 2), {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: `answered ${turnId}` }]
  })
}

function roster(state: 'working' | 'done'): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'system',
    blocks: [
      {
        type: 'subagent-group',
        groupId: 'group-1',
        agents: [{ id: 'child-1', label: 'reads', state, startedAt: 10 }]
      }
    ]
  }
}

/** Each case, written onto a freshly opened (empty) journal. */
export const JOURNAL_SESSION_STATE_CORPUS = {
  empty: async () => undefined,
  settled: (journal: AgentSessionJournal) => settledTurn(journal, 'turn-1'),
  'older turn running beside a newer one': async (journal: AgentSessionJournal) => {
    await item(journal, codexItem('turn-0', 0), {
      kind: 'turn',
      turnId: 'turn-0',
      state: 'running',
      startedAt: 5
    })
    await settledTurn(journal, 'turn-1')
  },
  'working subagent roster': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, { provider: 'orca', clientMessageId: 'roster-1' }, roster('working'))
  },
  'live background task': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(
      journal,
      { provider: 'orca', clientMessageId: 'claude-background-task:task-1' },
      {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'background-task',
            taskId: 'task-1',
            kind: 'command',
            label: 'sleep 20',
            state: 'working',
            startedAt: 10
          }
        ]
      }
    )
  },
  'pending prompt': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-1', 3), {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
  },
  'running tool': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-1', 4), {
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'ls' },
      state: 'running'
    })
  },
  'pending send': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-pending', 'never answered')
  },
  'unknown send': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-unknown', 'ambiguous')
    await journal.resolveDispatch({
      clientMessageId: 'send-unknown',
      state: 'unknown',
      reason: 'adapter_timeout',
      fence: CORPUS_FENCE
    })
  },
  'queued leftover': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await send(journal, 'send-queued', 'waiting its turn', true)
  },
  'unverifiable turn': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, codexItem('turn-2', 0), {
      kind: 'turn',
      turnId: 'turn-2',
      state: 'unverifiable',
      startedAt: 30
    })
  },
  'settled roster': async (journal: AgentSessionJournal) => {
    await settledTurn(journal, 'turn-1')
    await item(journal, { provider: 'orca', clientMessageId: 'roster-1' }, roster('done'))
  }
} satisfies Record<string, (journal: AgentSessionJournal) => Promise<void>>

export type JournalSessionStateCase = keyof typeof JOURNAL_SESSION_STATE_CORPUS

export const JOURNAL_SESSION_STATE_CASES = Object.keys(JOURNAL_SESSION_STATE_CORPUS).filter(
  (name): name is JournalSessionStateCase => name in JOURNAL_SESSION_STATE_CORPUS
)

/** Death evidence as a record can carry it: none, an older build's (no owner), naming the
 *  corpus's writer, and naming another owner. */
export const CORPUS_DEATH_EVIDENCE: Record<string, AgentSessionDeathEvidence | null> = {
  none: null,
  'older build, no owner': { kind: 'exit-observed', detail: 'exit', observedAt: 50 },
  'names the writer': {
    kind: 'pid-absent',
    detail: 'gone',
    observedAt: 60,
    ownerFence: CORPUS_FENCE
  },
  'names another owner': {
    kind: 'exit-observed',
    detail: 'exit',
    observedAt: 70,
    ownerFence: CORPUS_FENCE + 1
  }
}
