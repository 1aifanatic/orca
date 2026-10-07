import { describe, expect, it } from 'vitest'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import { takeLaunchFollowUpsInto } from './agent-launch-follow-up-record'

const DESKTOP = 'trusted-local:desktop'
const FOLLOW_UP = { kind: 'review-notes-delivered', version: 1, payload: { noteIds: ['n1'] } }

function launch(
  promptOutcome: 'handed-to-terminal' | 'not-delivered' | 'unconfirmed',
  unobserved = false
) {
  const result: AgentLaunchResult = {
    outcome: { kind: 'terminal', handle: 'term_1', paneKey: 'tab:leaf' },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' },
    prompt:
      promptOutcome === 'handed-to-terminal' && unobserved
        ? { delivery: 'submit', outcome: 'handed-to-terminal', composerUnobserved: true }
        : { delivery: 'submit', outcome: promptOutcome }
  }
  return result
}

function row(
  operationId: string,
  overrides: Partial<AgentSessionOperationRow> = {}
): AgentSessionOperationRow {
  return {
    callerKey: DESKTOP,
    operationId,
    fingerprint: 'fp',
    operationTimestamp: 1,
    recordedAt: 1,
    expiresAt: 10_000,
    outcome: { status: 'succeeded', sessionId: '', launch: launch('handed-to-terminal') },
    launchFollowUp: FOLLOW_UP,
    ...overrides
  }
}

function rows(...list: AgentSessionOperationRow[]) {
  return {
    operations: new Map(list.map((r) => [agentSessionOperationKey(r.callerKey, r.operationId), r]))
  }
}

const take = (
  state: ReturnType<typeof rows>,
  args: { callerKey?: string; operationId?: string; running?: string[] } = {}
) =>
  takeLaunchFollowUpsInto(state, {
    callerKey: args.callerKey ?? DESKTOP,
    ...(args.operationId ? { operationId: args.operationId } : {}),
    now: 100,
    isLaunchRunning: (key) => (args.running ?? []).includes(key)
  })

describe('taking a click’s follow-up off its launch’s row', () => {
  it('takes it once its prompt was handed over, removing it in the same write', () => {
    const state = rows(row('op-1'))
    expect(take(state)).toEqual({
      taken: [
        {
          operationId: 'op-1',
          followUp: FOLLOW_UP,
          promptHandedOver: true,
          composerUnobserved: false
        }
      ],
      pending: []
    })
    expect(state.operations.get(agentSessionOperationKey(DESKTOP, 'op-1'))).not.toHaveProperty(
      'launchFollowUp'
    )
    // Taken once: whoever took it is the one runner.
    expect(take(state)).toEqual({ taken: [], pending: [] })
  })

  it('says when the host wrote the prompt without seeing the composer', () => {
    const state = rows(
      row('op-1', {
        outcome: {
          status: 'succeeded',
          sessionId: '',
          launch: launch('handed-to-terminal', true)
        }
      })
    )
    expect(take(state).taken[0]).toMatchObject({ promptHandedOver: true, composerUnobserved: true })
  })

  it('reports a follow-up whose prompt is still owed, read-only', () => {
    const state = rows(
      row('op-1', {
        promptDelivery: {
          state: 'owed',
          text: 't',
          agent: 'claude',
          deadline: 9_000,
          terminal: null
        }
      })
    )
    expect(take(state)).toEqual({
      taken: [],
      pending: [{ operationId: 'op-1', followUp: FOLLOW_UP, deadline: 9_000 }]
    })
    expect(state.operations.get(agentSessionOperationKey(DESKTOP, 'op-1'))?.launchFollowUp).toEqual(
      FOLLOW_UP
    )
  })

  it('takes, with nothing to run, a launch that never handed its prompt over', () => {
    const state = rows(
      row('not-delivered', {
        outcome: { status: 'succeeded', sessionId: '', launch: launch('not-delivered') }
      }),
      row('failed', { outcome: { status: 'failed', code: 'worktree_not_found' } }),
      // Claimed, then the host died before it recorded anything.
      row('died', { outcome: { status: 'unknown' } })
    )
    expect(take(state).taken.map((t) => [t.operationId, t.promptHandedOver])).toEqual([
      ['not-delivered', false],
      ['failed', false],
      ['died', false]
    ])
  })

  it('waits on a prompt whose state this build cannot read, rather than dropping its follow-up', () => {
    const state = rows(Object.assign(row('op-1'), { promptDelivery: { state: 'paused' } }))
    expect(take(state)).toEqual({
      taken: [],
      pending: [{ operationId: 'op-1', followUp: FOLLOW_UP }]
    })
  })

  it('waits on a launch this process is still running', () => {
    const state = rows(row('op-1', { outcome: { status: 'unknown' } }))
    expect(take(state, { running: [agentSessionOperationKey(DESKTOP, 'op-1')] })).toEqual({
      taken: [],
      pending: [{ operationId: 'op-1', followUp: FOLLOW_UP }]
    })
  })

  it('retains an unconfirmed live prompt without inventing a retry obligation', () => {
    const state = rows(
      row('op-1', {
        outcome: { status: 'succeeded', sessionId: '', launch: launch('unconfirmed') }
      })
    )
    expect(take(state, { running: [agentSessionOperationKey(DESKTOP, 'op-1')] })).toEqual({
      taken: [],
      pending: [{ operationId: 'op-1', followUp: FOLLOW_UP }]
    })
    expect(state.operations.get(agentSessionOperationKey(DESKTOP, 'op-1'))).toMatchObject({
      launchFollowUp: FOLLOW_UP
    })
    expect(
      state.operations.get(agentSessionOperationKey(DESKTOP, 'op-1'))?.promptDelivery
    ).toBeUndefined()
    expect(take(state).taken).toMatchObject([{ promptHandedOver: false }])
    expect(take(state)).toEqual({ taken: [], pending: [] })
  })

  for (const promptOutcome of ['handed-to-terminal', 'not-delivered'] as const) {
    it(`takes a ${promptOutcome} receipt before the active launch is deleted`, () => {
      const state = rows(
        row('op-1', {
          outcome: { status: 'succeeded', sessionId: '', launch: launch(promptOutcome) }
        })
      )
      expect(take(state, { running: [agentSessionOperationKey(DESKTOP, 'op-1')] })).toMatchObject({
        pending: [],
        taken: [{ promptHandedOver: promptOutcome === 'handed-to-terminal' }]
      })
    })
  }

  it('never shows or takes another caller’s follow-ups', () => {
    const state = rows(row('op-1'))
    expect(take(state, { callerKey: 'device-1' })).toEqual({ taken: [], pending: [] })
    expect(take(state, { callerKey: 'trusted-local:runtime' })).toEqual({ taken: [], pending: [] })
    expect(take(state).taken).toHaveLength(1)
  })

  it('takes only the named launch when the click asks for its own', () => {
    const state = rows(row('op-1'), row('op-2'))
    expect(take(state, { operationId: 'op-2' }).taken.map((t) => t.operationId)).toEqual(['op-2'])
    expect(take(state).taken.map((t) => t.operationId)).toEqual(['op-1'])
  })

  it('ignores an expired row and a value this build cannot read', () => {
    const state = rows(
      row('expired', { expiresAt: 50 }),
      Object.assign(row('malformed'), { launchFollowUp: { kind: 'x' } })
    )
    expect(take(state)).toEqual({ taken: [], pending: [] })
  })
})
