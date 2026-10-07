import { settleAgentSessionOperationInto } from './agent-session-operation-admission'
import { describe, expect, it } from 'vitest'
import {
  agentSessionOperationKey,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  beginOwedLaunchPromptWrite,
  listOwedLaunchPromptRows,
  readOwedLaunchPrompt,
  recordLaunchOutcome
} from './agent-launch-owed-prompt-record'
import type { AgentSessionStoreState } from './agent-session-store-state'

const REF = { callerKey: 'trusted-local:desktop', operationId: 'op-1' }
const KEY = agentSessionOperationKey(REF.callerKey, REF.operationId)
const SUCCEEDED = { status: 'succeeded' as const, sessionId: '', launch: { stub: true } }

function row(overrides: Partial<AgentSessionOperationRow> = {}): AgentSessionOperationRow {
  return {
    ...REF,
    fingerprint: 'fp',
    operationTimestamp: 1,
    recordedAt: 1,
    expiresAt: 10_000,
    outcome: { status: 'pending' },
    ...overrides
  }
}

/** The store's ledger transaction over one in-memory draft. */
function ledger(initial: AgentSessionOperationRow[] = [row()]) {
  const draft = {
    operations: new Map(
      initial.map((r) => [agentSessionOperationKey(r.callerKey, r.operationId), r])
    )
  }
  return {
    draft,
    store: {
      transactOperations: async <T>(apply: (state: AgentSessionStoreState) => T) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these writes read and replace only `operations`.
        apply(draft as unknown as AgentSessionStoreState),
      recordOperationOutcome: async (args: Parameters<typeof settleAgentSessionOperationInto>[1]) =>
        settleAgentSessionOperationInto(draft, args)
    },
    current: () => draft.operations.get(KEY)
  }
}

describe('the launch record around an owed first prompt', () => {
  it('W1 records the answer and owes the prompt with its agent, in one write', async () => {
    const { store, current } = ledger()
    await recordLaunchOutcome(store, {
      ...REF,
      outcome: SUCCEEDED,
      owedPrompt: { text: 'fix the checks', agent: 'claude', deadline: 9_000, terminal: null }
    })
    expect(current()?.outcome).toEqual(SUCCEEDED)
    expect(readOwedLaunchPrompt(current()!)).toEqual({
      state: 'owed',
      text: 'fix the checks',
      agent: 'claude',
      deadline: 9_000,
      terminal: null
    })
  })

  it('W2 takes the write once: a second writer finds it taken, and the text is gone', async () => {
    const { store, current } = ledger()
    await recordLaunchOutcome(store, {
      ...REF,
      outcome: SUCCEEDED,
      owedPrompt: { text: 'fix the checks', agent: 'claude', deadline: 9_000, terminal: null }
    })
    await expect(beginOwedLaunchPromptWrite(store, REF, 500)).resolves.toBe('began')
    expect(current()?.promptDelivery).toEqual({ state: 'writing', since: 500 })
    await expect(beginOwedLaunchPromptWrite(store, REF, 600)).resolves.toBe('taken')
  })

  it('W2 on a row that owes nothing says so, and never blocks the write', async () => {
    const { store } = ledger()
    await expect(beginOwedLaunchPromptWrite(store, REF, 500)).resolves.toBe('absent')
    await expect(beginOwedLaunchPromptWrite(ledger([]).store, REF, 500)).resolves.toBe('absent')
  })

  it('W3 clears the prompt and keeps the answer', async () => {
    const { store, current } = ledger()
    await recordLaunchOutcome(store, {
      ...REF,
      outcome: SUCCEEDED,
      owedPrompt: { text: 'fix the checks', agent: 'claude', deadline: 9_000, terminal: null }
    })
    await recordLaunchOutcome(store, { ...REF, outcome: { status: 'failed', code: 'boom' } })
    expect(current()?.promptDelivery).toBeUndefined()
    expect(current()?.outcome).toEqual({ status: 'failed', code: 'boom' })
    expect(JSON.stringify(current())).not.toContain('fix the checks')
  })

  it('an expired row is gone with its text', async () => {
    const { store, draft } = ledger()
    await recordLaunchOutcome(store, {
      ...REF,
      outcome: SUCCEEDED,
      owedPrompt: { text: 'fix the checks', agent: 'claude', deadline: 9_000, terminal: null }
    })
    expect(listOwedLaunchPromptRows(draft.operations.values(), 20_000)).toEqual([])
    const kept = pruneAgentSessionOperationRows(draft.operations, 20_000)
    expect(JSON.stringify([...kept.values()])).not.toContain('fix the checks')
  })

  it('reads nothing from a value this build cannot read', () => {
    for (const promptDelivery of [
      { state: 'owed', text: 'x' },
      { state: 'owed', text: 'x', agent: 'not-an-agent', deadline: 1 },
      { state: 'owed', text: 'x', agent: 'claude' },
      { state: 'owed', text: 'x', agent: 'claude', deadline: 1 },
      { state: 'owed', text: 'x', agent: 'claude', deadline: 1, terminal: { ptyId: 3 } },
      { state: 'writing' },
      'owed',
      null
    ]) {
      // A malformed persisted value, as an older or newer build could leave it.
      expect(readOwedLaunchPrompt(Object.assign(row(), { promptDelivery }))).toBeNull()
    }
  })
})
