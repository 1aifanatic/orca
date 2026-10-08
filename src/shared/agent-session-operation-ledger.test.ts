import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS
} from './agent-session-host-authority'
import {
  agentSessionOperationExpiry,
  agentSessionOperationKey,
  claimAgentSessionOperation,
  evaluateAgentSessionOperation,
  pendingAgentSessionOperationRow,
  settleAgentSessionOperation,
  isAgentSessionOperationRow,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationRow
} from './agent-session-operation-ledger'

const NOW = 1_800_000_000_000

function operationId(timestamp: number, suffix = 'a'.repeat(32)): string {
  return `${String(timestamp).padStart(13, '0')}-${suffix}`
}

function evaluate(
  rows: Map<string, AgentSessionOperationRow>,
  overrides: Partial<{
    callerKey: string
    operationId: string
    fingerprint: string
    now: number
  }> = {}
) {
  return evaluateAgentSessionOperation({
    rows,
    callerKey: 'client-1',
    operationId: operationId(NOW),
    fingerprint: 'fp-1',
    now: NOW,
    ...overrides
  })
}

function admit(
  rows: Map<string, AgentSessionOperationRow>,
  overrides: Parameters<typeof evaluate>[1] = {}
): AgentSessionOperationRow {
  const decision = evaluate(rows, overrides)
  if (decision.decision !== 'admit') {
    throw new Error(`expected admit, got ${decision.decision}`)
  }
  rows.set(agentSessionOperationKey(decision.row.callerKey, decision.row.operationId), decision.row)
  return decision.row
}

describe('operation admission', () => {
  it('admits a fresh id once and replays the identical retry', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    const replay = evaluate(rows)
    expect(replay).toEqual({ decision: 'replay', row })
  })

  it('refuses the same id carrying different parameters', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(evaluate(rows, { fingerprint: 'fp-2' })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict',
      details: { reason: 'operationIdReused' }
    })
  })

  it('scopes ids per caller so two clients cannot collide or replay each other', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(evaluate(rows, { callerKey: 'client-2' }).decision).toBe('admit')
  })

  it('refuses a malformed or future-dated id', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    expect(evaluate(rows, { operationId: 'not-an-operation-id' })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'operationIdInvalid' }
    })
    // Why: a future-dated id would look new again after its own tombstone is collected.
    expect(
      evaluate(rows, {
        operationId: operationId(NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1)
      })
    ).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'operationIdInvalid' }
    })
    expect(
      evaluate(rows, { operationId: operationId(NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS) })
        .decision
    ).toBe('admit')
  })

  it('refuses an id older than the admission window instead of treating it as new', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const stale = operationId(NOW - AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS - 1)
    expect(evaluate(rows, { operationId: stale })).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_expired',
      details: { reason: 'operationExpired' }
    })
    expect(
      evaluate(rows, {
        operationId: operationId(NOW - AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS)
      }).decision
    ).toBe('admit')
  })

  it.each(['caller', 'global'] as const)(
    'bounds new work at the %s quota without evicting replayable receipts',
    (limit) => {
      const rows = new Map<string, AgentSessionOperationRow>()
      const original = admit(rows)
      const count = limit === 'caller' ? 512 : 4_096
      for (let index = 1; index < count; index += 1) {
        const row = pendingAgentSessionOperationRow({
          callerKey: limit === 'caller' ? 'client-1' : `other-${index}`,
          operationId: operationId(NOW, index.toString(16).padStart(32, '0')),
          fingerprint: 'fp',
          now: NOW
        })
        rows.set(agentSessionOperationKey(row.callerKey, row.operationId), row)
      }
      expect(evaluate(rows, { operationId: operationId(NOW, 'f'.repeat(32)) })).toMatchObject({
        decision: 'refused',
        code: 'agent_session_operation_capacity'
      })
      expect(evaluate(rows)).toEqual({ decision: 'replay', row: original })
    }
  )
})

describe('the pane a launch laid out', () => {
  const pane = { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' }

  it('is recorded only by the claim that wins, and outlives the settle', () => {
    const id = operationId(NOW)
    const key = agentSessionOperationKey('caller', id)
    const pending = new Map([
      [
        key,
        pendingAgentSessionOperationRow({
          callerKey: 'caller',
          operationId: id,
          fingerprint: 'fp',
          now: NOW
        })
      ]
    ])

    const won = claimAgentSessionOperation(pending, {
      callerKey: 'caller',
      operationId: id,
      ownedPane: pane
    })
    expect(won.rows.get(key)?.ownedPane).toEqual(pane)
    const lost = claimAgentSessionOperation(won.rows, {
      callerKey: 'caller',
      operationId: id,
      ownedPane: { worktreeId: 'wt-1', paneKey: 'tab-2:leaf-2' }
    })
    expect(lost.claim.claim).toBe('lost')
    expect(lost.rows.get(key)?.ownedPane).toEqual(pane)

    const settled = settleAgentSessionOperation(won.rows, {
      callerKey: 'caller',
      operationId: id,
      outcome: { status: 'failed', code: 'boom' }
    })
    expect(settled.get(key)?.ownedPane).toEqual(pane)
    expect(isAgentSessionOperationRow(settled.get(key))).toBe(true)
  })
})

describe('retention', () => {
  it.each(['succeeded', 'failed'] as const)(
    'keeps a %s receipt through the exact retry boundary, then expires its id',
    (status) => {
      const rows = new Map<string, AgentSessionOperationRow>()
      const row = admit(rows)
      const key = agentSessionOperationKey(row.callerKey, row.operationId)
      rows.set(key, {
        ...row,
        outcome:
          status === 'succeeded' ? { status, sessionId: 'session-1' } : { status, code: 'failure' }
      })
      const boundary = NOW + AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS
      expect(
        evaluate(pruneAgentSessionOperationRows(rows, boundary), { now: boundary }).decision
      ).toBe('replay')
      const expired = pruneAgentSessionOperationRows(rows, boundary + 1)
      expect(expired.size).toBe(0)
      expect(evaluate(expired, { now: boundary + 1 })).toMatchObject({
        decision: 'refused',
        code: 'agent_session_operation_expired'
      })
    }
  )

  it.each(['pending', 'unknown'] as const)(
    'keeps a %s receipt beyond the settled retry window until its existing expiry',
    (status) => {
      const rows = new Map<string, AgentSessionOperationRow>()
      const row = admit(rows)
      rows.set(agentSessionOperationKey(row.callerKey, row.operationId), {
        ...row,
        outcome: { status }
      })
      const now = NOW + AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS + 1
      expect(evaluate(pruneAgentSessionOperationRows(rows, now), { now }).decision).toBe('replay')
      expect(pruneAgentSessionOperationRows(rows, row.expiresAt).size).toBe(0)
    }
  )

  it('retains a settled future-stamped receipt until the id itself expires', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const id = operationId(NOW + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS)
    const row = admit(rows, { operationId: id })
    rows.set(agentSessionOperationKey(row.callerKey, id), {
      ...row,
      outcome: { status: 'succeeded', sessionId: 'session-1' }
    })
    const now = row.operationTimestamp + AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS
    expect(
      evaluate(pruneAgentSessionOperationRows(rows, now), { operationId: id, now }).decision
    ).toBe('replay')
    expect(
      evaluate(pruneAgentSessionOperationRows(rows, now + 1), { operationId: id, now: now + 1 })
    ).toMatchObject({ decision: 'refused', code: 'agent_session_operation_expired' })
  })

  it('keeps a tombstone strictly longer than its id can be admitted as new', () => {
    const expiry = agentSessionOperationExpiry(NOW, NOW)
    const lastAdmissibleAt = NOW + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
    expect(expiry).toBeGreaterThan(lastAdmissibleAt)
    // Why: a retry landing in that gap would become a second spawn instead of a replay.
    const rows = new Map<string, AgentSessionOperationRow>()
    admit(rows)
    expect(pruneAgentSessionOperationRows(rows, lastAdmissibleAt).size).toBe(1)
    expect(evaluate(pruneAgentSessionOperationRows(rows, lastAdmissibleAt)).decision).toBe('replay')
  })

  it('anchors retention to the later of recording and stamping', () => {
    const late = agentSessionOperationExpiry(NOW + 10_000, NOW)
    expect(late).toBe(agentSessionOperationExpiry(NOW + 10_000, NOW + 10_000))
    expect(late).toBeGreaterThan(agentSessionOperationExpiry(NOW, NOW))
  })

  it('drops only rows past their own expiry', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(pruneAgentSessionOperationRows(rows, row.expiresAt).size).toBe(0)
    expect(pruneAgentSessionOperationRows(rows, row.expiresAt - 1).size).toBe(1)
  })
})

describe('persisted row validation', () => {
  it('accepts every recorded outcome shape', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(isAgentSessionOperationRow(row)).toBe(true)
    expect(
      isAgentSessionOperationRow({ ...row, outcome: { status: 'succeeded', sessionId: 's-1' } })
    ).toBe(true)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'unknown' } })).toBe(true)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'failed', code: 'x' } })).toBe(
      true
    )
  })

  it('rejects rows a later build could misread', () => {
    const rows = new Map<string, AgentSessionOperationRow>()
    const row = admit(rows)
    expect(isAgentSessionOperationRow({ ...row, operationId: 'garbage' })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, callerKey: '' })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, expiresAt: 1.5 })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, outcome: { status: 'succeeded' } })).toBe(false)
    expect(isAgentSessionOperationRow({ ...row, outcome: null })).toBe(false)
    expect(isAgentSessionOperationRow(null)).toBe(false)
  })
})
