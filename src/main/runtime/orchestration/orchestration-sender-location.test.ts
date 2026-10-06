// What a chat names a message's sender, and where it opens it: the host's two reads of a party.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow, TaskRow } from './types'
import { orchestrationSenderName } from './orchestration-sender-name'
import { locateOrchestrationParty } from './orchestration-party-location'
import type { AgentSessionRecordReader } from './structured-session-lineage'

const ROOT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const LIVE = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'

function record(sessionId: string, overrides: Partial<AgentSessionRecord> = {}) {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return { ...base, location: { ...base.location, workspaceId: 'wt-chat' }, ...overrides }
}

/** A chat `/clear` continued in LIVE: its root id still names it. */
function clearedChat(liveName?: string): AgentSessionRecordReader {
  const records = new Map([
    [
      ROOT,
      record(ROOT, {
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          replacementSessionId: LIVE,
          operationId: 'op',
          callerKey: 'k',
          phase: 'committed'
        }
      })
    ],
    [LIVE, record(LIVE, liveName ? { conversationName: liveName } : {})]
  ])
  return { getRecord: (id) => records.get(id) ?? null, listRecords: () => [...records.values()] }
}

/** Only the dispatch lookups the reads make. */
function dispatchDb(dispatch?: Partial<DispatchContextRow>, task?: Partial<TaskRow>) {
  const db = {
    getDispatchContextById: () => dispatch,
    getTask: () => task,
    getRemoteDispatchAttachment: () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reads under test call only these three lookups, and read only the fields set here.
  return db as unknown as OrchestrationDb
}

const chatParty = { address: `orca_session_id:${ROOT}`, terminalHandle: null, orcaSessionId: ROOT }
const terminalParty = { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null }
const dispatchParty = { address: 'dispatch:d1', terminalHandle: 'dispatch:d1', orcaSessionId: null }

describe("a sender's name, from names Orca controls", () => {
  const name = (
    party: Parameters<typeof orchestrationSenderName>[0],
    deps: Partial<Parameters<typeof orchestrationSenderName>[1]> = {}
  ) => orchestrationSenderName(party, { db: null, records: null, terminal: () => null, ...deps })

  it("names a chat by its live session's conversation name, else its agent's chat label", () => {
    expect(name(chatParty, { records: clearedChat('Fix the build') })).toBe('Fix the build')
    expect(name(chatParty, { records: clearedChat() })).toBe('Claude Chat')
    expect(name(chatParty)).toBeNull()
  })

  it('names a terminal by the title the person gave its tab, else its agent', () => {
    expect(
      name(terminalParty, { terminal: () => ({ customTitle: ' Lint ', agent: 'codex' }) })
    ).toBe('Lint')
    expect(name(terminalParty, { terminal: () => ({ customTitle: null, agent: 'codex' }) })).toBe(
      'Codex'
    )
    expect(name(terminalParty, { terminal: () => ({ customTitle: null, agent: null }) })).toBeNull()
  })

  it('names a federated sender by the task its dispatch was given', () => {
    const db = dispatchDb({ task_id: 't1' }, { display_name: 'Port the parser', task_title: 'x' })
    expect(name(dispatchParty, { db })).toBe('Port the parser')
    expect(name(dispatchParty, { db: dispatchDb(undefined) })).toBeNull()
  })
})

describe('where a sender opens', () => {
  const locate = (address: string, deps: Partial<Parameters<typeof locateOrchestrationParty>[1]>) =>
    locateOrchestrationParty(address, {
      db: null,
      records: null,
      terminalHandleForPaneKey: () => null,
      ...deps
    })

  it("opens a chat at its `/clear` lineage's live session, in that session's worktree", () => {
    expect(locate(chatParty.address, { records: clearedChat() })).toEqual({
      kind: 'chat',
      sessionId: LIVE,
      worktreeId: 'wt-chat'
    })
    expect(locate(chatParty.address, {})).toBeNull()
  })

  it('opens a terminal at its handle', () => {
    expect(locate('term_a', {})).toEqual({ kind: 'terminal', handle: 'term_a' })
  })

  it("opens a dispatch at its assignee: a chat by its session, a terminal by its pane's handle now", () => {
    const chatAssignee = dispatchDb({ assignee_orca_session_id: ROOT })
    expect(locate('dispatch:d1', { db: chatAssignee, records: clearedChat() })).toMatchObject({
      kind: 'chat',
      sessionId: LIVE
    })
    const terminalAssignee = dispatchDb({
      assignee_pane_key: 'tab:leaf',
      assignee_handle: 'term_old'
    })
    expect(
      locate('dispatch:d1', {
        db: terminalAssignee,
        terminalHandleForPaneKey: (paneKey) => (paneKey === 'tab:leaf' ? 'term_now' : null)
      })
    ).toEqual({ kind: 'terminal', handle: 'term_now' })
    expect(locate('dispatch:d1', { db: terminalAssignee })).toEqual({
      kind: 'terminal',
      handle: 'term_old'
    })
    expect(locate('dispatch:d1', { db: dispatchDb(undefined) })).toBeNull()
  })
})
