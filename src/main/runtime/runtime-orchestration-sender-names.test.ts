// A sender's name snapshot, read from the sources production fills: dispatch tasks in the
// orchestration database, the chat tabs and terminal tabs of the workspace session this host
// mirrors, and the terminal's own pty.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const CHAT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const WORKTREE = 'repo_1::/work/tree'

type Session = NonNullable<
  ReturnType<
    ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]['getWorkspaceSession']
  >
>

let db: OrchestrationDb
let session: Session
let records: Map<string, AgentSessionRecord>

function names() {
  return new RuntimeOrchestrationSenderNames({
    getDb: () => db,
    getHandleRecord: (handle) =>
      handle === 'term_worker' || handle === 'term_plain'
        ? { worktreeId: WORKTREE, tabId: `tab_${handle}`, ptyId: `pty_${handle}` }
        : undefined,
    getPtyAgents: () => ({ launchAgent: 'codex' }),
    getTerminalPaneKey: (handle) => `tab_${handle}:leaf`,
    getWorkspaceSession: (worktreeId) => (worktreeId === WORKTREE ? session : undefined)
  })
}

function chatTab(customLabel: string | null, label: string) {
  return { contentType: 'agent-session' as const, entityId: CHAT, customLabel, label }
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  session = { unifiedTabs: {}, tabsByWorktree: {} }
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: CHAT }))
  records = new Map([[CHAT, { ...base, location: { ...base.location, workspaceId: WORKTREE } }]])
  hostRef.current = {
    deps: {
      store: { getRecord: (id: string) => records.get(id) ?? null, listRecords: () => [] }
    }
  }
})

afterEach(() => {
  db.close()
})

const chatParty = { address: `orca_session_id:${CHAT}`, terminalHandle: null, orcaSessionId: CHAT }
const terminalParty = (handle: string) => ({
  address: handle,
  terminalHandle: handle,
  orcaSessionId: null
})

describe("a sender's name, from what Orca shows for it", () => {
  it("names a local worker by its active dispatch's task, before its tab or agent", () => {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({
      runId: run.id,
      spec: 'Port the parser',
      displayName: 'Parser port'
    })
    createRootDispatch(db, task.id, 'term_worker')
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_worker', customTitle: 'Build tab' }] }
    expect(names().nameOf(terminalParty('term_worker'))).toBe('Parser port')
  })

  it("names a chat by the label its tab shows, the person's rename first", () => {
    session.unifiedTabs = { [WORKTREE]: [chatTab(null, 'Fix the login flow')] }
    expect(names().nameOf(chatParty)).toBe('Fix the login flow')
    session.unifiedTabs = { [WORKTREE]: [chatTab('Auth chat', 'Fix the login flow')] }
    expect(names().nameOf(chatParty)).toBe('Auth chat')
  })

  it("names a chat with no tab by its agent's chat label", () => {
    expect(names().nameOf(chatParty)).toBe('Claude Chat')
  })

  it("names a terminal by its tab's stored title, else its agent", () => {
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Codex')
    session.tabsByWorktree = { [WORKTREE]: [{ id: 'tab_term_plain', customTitle: ' Lint ' }] }
    expect(names().nameOf(terminalParty('term_plain'))).toBe('Lint')
  })

  it('names a party nothing records as nothing', () => {
    expect(names().nameOf(terminalParty('term_unknown'))).toBeNull()
  })

  it('builds the one sender a message records: its party and the name it has now', () => {
    session.unifiedTabs = { [WORKTREE]: [chatTab(null, 'Fix the login flow')] }
    expect(names().sender(`orca_session_id:${CHAT}`)).toEqual({
      party: { address: `orca_session_id:${CHAT}`, terminalHandle: null, orcaSessionId: CHAT },
      name: 'Fix the login flow'
    })
  })
})
